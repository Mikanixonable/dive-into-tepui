#!/usr/bin/env python3
"""GOES ABI の manifest 地域を抽出し、製品ごとの有効画素数を集計する。"""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timedelta
import json
import math
from pathlib import Path
import re
import shutil
import subprocess
import sys
from typing import Any

import netCDF4
import numpy as np


CHUNK_ROWS = 64
PRODUCTS = (
    ("ABI-L1b-RadF", "L1b-RadF-M6C02", "Rad", "L1B_RAD", 2),
    ("ABI-L1b-RadF", "L1b-RadF-M6C13", "Rad", "L1B_RAD", 13),
    ("ABI-L2-CODF", "L2-CODF-M6", "COD", "L2_COD", None),
    ("ABI-L2-ACHAF", "L2-ACHAF-M6", "HT", "L2_ACHA", None),
    ("ABI-L2-ACTPF", "L2-ACTPF-M6", "Phase", "L2_ACTP", None),
    ("ABI-L2-ACMF", "L2-ACMF-M6", "ACM", "L2_ACM", None),
)

MINIMUM_COD_INDICATOR_SUPPORT_FRACTION = 0.5
MAXIMUM_COD_SOLAR_ZENITH_DEGREES = 70.0


class AbiSolarAngleEvaluator:
    """既存 abiPixelAngles を Node 経由で呼び、ACM 画素中心の昼間 mask を作る。"""

    def __init__(self) -> None:
        node = shutil.which("node")
        if node is None:
            fail("COD solar-angle mask requires Node.js to call the canonical abiPixelAngles implementation")
        bridge = r"""
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  module._compile(ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }), filename);
};
const { abiPixelAngles } = require('./tools/cloud-reference/abi-angles.ts');
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  try {
    const request = JSON.parse(line);
    const result = request.y.map((y) => request.x.map((x) => {
      const angles = abiPixelAngles(
        { xAngleRadians: x, yAngleRadians: y },
        request.projection,
        request.scanTimeUtc,
      );
      return angles !== null && angles.solarZenithRadians <= request.maximumSolarZenithRadians;
    }));
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: String(error) }) + '\n');
    input.close();
    process.exitCode = 1;
  }
});
process.stdout.write(JSON.stringify({ ready: true }) + '\n');
"""
        self.process = subprocess.Popen(
            [node, "-e", bridge],
            cwd=Path(__file__).resolve().parents[2],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        if self.process.stdout is None:
            fail("solar-angle bridge output pipe is unavailable")
        ready_line = self.process.stdout.readline()
        if not ready_line:
            stderr = self.process.stderr.read() if self.process.stderr is not None else ""
            fail(f"canonical solar-angle bridge failed to start: {stderr.strip()}")
        ready = json.loads(ready_line)
        if ready != {"ready": True}:
            fail(f"canonical solar-angle bridge returned unexpected startup response: {ready}")

    def daylight_mask(
        self,
        x_angles: np.ndarray,
        y_angles: np.ndarray,
        projection: dict[str, float],
        scan_time_utc: str,
    ) -> np.ndarray:
        """ACM 中心座標とスロット UTC 時刻から 70° 以下の SZA mask を得る。"""
        if self.process.stdin is None or self.process.stdout is None:
            fail("solar-angle bridge pipes are unavailable")
        request = {
            "x": x_angles.tolist(),
            "y": y_angles.tolist(),
            "projection": {
                "perspectivePointHeightMeters": projection["height"],
                "semiMajorAxisMeters": projection["a"],
                "semiMinorAxisMeters": projection["b"],
                "longitudeOfProjectionOriginRadians": projection["lon0"],
            },
            "scanTimeUtc": scan_time_utc,
            "maximumSolarZenithRadians": math.radians(MAXIMUM_COD_SOLAR_ZENITH_DEGREES),
        }
        self.process.stdin.write(json.dumps(request, separators=(",", ":")) + "\n")
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            stderr = self.process.stderr.read() if self.process.stderr is not None else ""
            fail(f"canonical solar-angle calculation failed: {stderr.strip()}")
        response = json.loads(line)
        if isinstance(response, dict) and "error" in response:
            fail(f"canonical solar-angle calculation failed: {response['error']}")
        mask = np.asarray(response, dtype=bool)
        if mask.shape != (len(y_angles), len(x_angles)):
            fail("canonical solar-angle result dimensions disagree with ACM tile")
        return mask

    def close(self) -> None:
        """角度計算プロセスを終了する。"""
        if self.process.stdin is not None:
            self.process.stdin.close()
        if self.process.poll() is None:
            self.process.terminate()
        self.process.wait()
        if self.process.stdout is not None:
            self.process.stdout.close()
        if self.process.stderr is not None:
            self.process.stderr.close()


def cod_indicator_availability(
    area_weighted_coverage_fraction: float | None,
    assessment_scope: str,
) -> dict[str, Any]:
    """COD の面積閾値診断と未評価の最終指標条件を区別する。"""
    if assessment_scope not in ("single_slot", "aggregated_series"):
        raise ValueError(f"unknown COD diagnostic scope: {assessment_scope}")
    valid_fraction = (
        area_weighted_coverage_fraction is not None
        and math.isfinite(area_weighted_coverage_fraction)
        and 0 <= area_weighted_coverage_fraction <= 1
    )
    if not valid_fraction:
        status = "blocked_invalid_or_missing_support_fraction"
    elif area_weighted_coverage_fraction >= MINIMUM_COD_INDICATOR_SUPPORT_FRACTION:
        status = "provisional_area_threshold_met"
    else:
        status = "provisional_area_threshold_not_met"
    return {
        "scope": assessment_scope,
        "status": status,
        "minimumValidSupportFraction": MINIMUM_COD_INDICATOR_SUPPORT_FRACTION,
        "diagnosticSupportFraction": area_weighted_coverage_fraction if valid_fraction else None,
        "supportBasis": "pixel-centre area-weighted COD-good coverage on eligible ACM cloud pixels",
        "validFrameCountStatus": "not_assessed",
        "finalMetricStatus": "blocked",
        "finalMetricBlockers": [
            "valid_frame_count_not_assessed",
            "area_overlap_collocation_not_implemented",
            "solar_angle_mask_not_assessed",
            "cloud_top_parallax_not_corrected",
        ],
        "appliedMasks": {},
        "unappliedCorrections": ["cloud_top_parallax"],
    }
FILENAME = re.compile(r"^OR_ABI-(?P<product>[A-Za-z0-9-]+)_(?P<satellite>G\d{2})_s(?P<start>\d{14})_.*\.nc$")


class RegionError(Exception):
    """地域抽出の前提が満たされない場合に送出する。"""


def fail(message: str) -> None:
    raise RegionError(message)


def grid_parameters(dataset: Any) -> tuple[np.ndarray, np.ndarray, dict[str, float]]:
    """NetCDF の packed 角度座標を画素中心の rad へ復号する。"""
    x, y = dataset.variables["x"], dataset.variables["y"]
    if getattr(x, "units", None) != "rad" or getattr(y, "units", None) != "rad":
        fail("GOES 固定格子座標の単位は rad でなければならない")
    x.set_auto_maskandscale(False)
    y.set_auto_maskandscale(False)
    x_values = np.asarray(x[:], dtype=np.float64) * float(x.scale_factor) + float(x.add_offset)
    y_values = np.asarray(y[:], dtype=np.float64) * float(y.scale_factor) + float(y.add_offset)
    projection = dataset.variables["goes_imager_projection"]
    if (getattr(projection, "grid_mapping_name", None) != "geostationary"
        or getattr(projection, "sweep_angle_axis", None) != "x"):
        fail("GOES 固定格子投影は geostationary sweep=x でなければならない")
    parameters = {
        "height": float(projection.perspective_point_height),
        "a": float(projection.semi_major_axis),
        "b": float(projection.semi_minor_axis),
        "lon0": math.radians(float(projection.longitude_of_projection_origin)),
    }
    if not all(np.all(np.isfinite(values)) for values in (x_values, y_values)):
        fail("固定格子座標に非有限値がある")
    x_differences, y_differences = np.diff(x_values), np.diff(y_values)
    if (x_values.size < 2 or y_values.size < 2
        or not (np.all(x_differences > 0) or np.all(x_differences < 0))
        or not (np.all(y_differences > 0) or np.all(y_differences < 0))):
        fail("固定格子座標は単調な一次元配列でなければならない")
    return x_values, y_values, parameters


def validate_cod_acm_grid_alignment(
    cod_x: np.ndarray,
    cod_y: np.ndarray,
    cod_projection: dict[str, float],
    acm_x: np.ndarray,
    acm_y: np.ndarray,
    acm_projection: dict[str, float],
) -> None:
    """2 km COD 格子が 1 km ACM 画素 2x2 の中心格子へ入れ子か検査する。"""
    if acm_x.size != 2 * cod_x.size or acm_y.size != 2 * cod_y.size:
        fail("COD/ACM grid dimensions are not aligned at a 2:1 ratio")
    if cod_projection.keys() != acm_projection.keys() or any(
        not math.isclose(cod_projection[key], acm_projection[key], rel_tol=0, abs_tol=1e-6)
        for key in cod_projection
    ):
        fail("COD/ACM projections do not match")
    if (not np.allclose(cod_x, (acm_x[::2] + acm_x[1::2]) / 2, rtol=0, atol=2e-9)
        or not np.allclose(cod_y, (acm_y[::2] + acm_y[1::2]) / 2, rtol=0, atol=2e-9)):
        fail("COD/ACM axes do not align as 2x2 child pixels")


def summarize_cod_cloud_eligible_coverage(
    cod_field_valid: np.ndarray,
    cod_dqf: np.ndarray,
    cod_dqf_valid: np.ndarray,
    acm_field: np.ndarray,
    acm_field_valid: np.ndarray,
    acm_dqf: np.ndarray,
    acm_dqf_valid: np.ndarray,
    acm_inside_region: np.ndarray,
    acm_pixel_areas_m2: np.ndarray,
    acm_solar_angle_valid: np.ndarray,
) -> dict[str, Any]:
    """good ACM cloud pixel centres上でCOD good coverageを固定格子集計する。"""
    height, width = cod_field_valid.shape
    if any(array.shape != (height, width) for array in (cod_dqf, cod_dqf_valid)):
        fail("COD diagnostic field and DQF shapes disagree")
    child_shape = (height * 2, width * 2)
    if any(array.shape != child_shape for array in (
        acm_field, acm_field_valid, acm_dqf, acm_dqf_valid, acm_inside_region,
        acm_pixel_areas_m2,
    )):
        fail("ACM diagnostic grid is not four child pixels per COD pixel")
    if not np.all(np.isfinite(acm_pixel_areas_m2)) or np.any(acm_pixel_areas_m2 <= 0):
        fail("ACM pixel-area weights must be finite and positive")
    if acm_solar_angle_valid.shape != child_shape:
        fail("ACM solar-angle mask shape does not match the ACM diagnostic grid")

    eligible_cloud_before_solar_mask = (
        acm_inside_region & acm_field_valid & acm_dqf_valid
        & good_dqf(acm_dqf, "L2_ACM") & np.isin(acm_field, (2, 3))
    )
    eligible_cloud = eligible_cloud_before_solar_mask & acm_solar_angle_valid
    cloud_children = eligible_cloud.reshape(height, 2, width, 2).sum(axis=(1, 3))
    denominator = int(cloud_children.sum())
    eligible_area = np.where(eligible_cloud, acm_pixel_areas_m2, 0).sum(dtype=np.float64)
    eligible_area_before_solar_mask = np.where(
        eligible_cloud_before_solar_mask, acm_pixel_areas_m2, 0,
    ).sum(dtype=np.float64)
    cod_good = cod_field_valid & cod_dqf_valid & good_dqf(cod_dqf, "L2_COD")
    numerator = int(cloud_children[cod_good].sum())
    good_cod_area = np.where(
        cod_good.reshape(height, 1, width, 1),
        np.where(eligible_cloud, acm_pixel_areas_m2, 0).reshape(height, 2, width, 2),
        0,
    ).sum(dtype=np.float64)
    dqf_counts: Counter[int] = Counter()
    for value, count in zip(*np.unique(cod_dqf[cloud_children > 0], return_counts=True), strict=True):
        dqf_counts[int(value)] += int(np.sum(cloud_children[cod_dqf == value]))
    result = {
        "eligibleCloudPixelCount": denominator,
        "eligibleCloudPixelCountBeforeSolarMask": int(eligible_cloud_before_solar_mask.sum()),
        "solarAngleExcludedEligibleCloudPixelCount": int(
            eligible_cloud_before_solar_mask.sum() - eligible_cloud.sum(),
        ),
        "goodCodCloudPixelCount": numerator,
        "coverageFraction": numerator / denominator if denominator else None,
        "eligibleCloudAreaM2": float(eligible_area),
        "eligibleCloudAreaM2BeforeSolarMask": float(eligible_area_before_solar_mask),
        "solarAngleExcludedEligibleCloudAreaM2": float(eligible_area_before_solar_mask - eligible_area),
        "goodCodCloudAreaM2": float(good_cod_area),
        "areaWeightedCoverageFraction": float(good_cod_area / eligible_area) if eligible_area else None,
        "codDqfRawCountsOnEligibleCloudPixels": {str(value): count for value, count in sorted(dqf_counts.items())},
        "denominatorDefinition": "good-DQF valid ACM class 2/3 1 km pixel centres inside the geographic region and with solar zenith <= 70 degrees",
        "numeratorDefinition": "eligible ACM cloud pixel centres whose enclosing 2 km COD pixel has valid in-range COD and good DQF raw 0/1",
        "areaDenominatorDefinition": "sum of local ENU quadrilateral areas for eligible cloud ACM pixel centres",
        "areaNumeratorDefinition": "area denominator pixels whose enclosing COD parent has valid in-range COD and good DQF raw 0/1",
        "aggregation": "verified same-projection 2x2 fixed-grid ACM child-centre to COD parent grouping; count coverage and pixel-centre area-weighted coverage are diagnostics, not polygon area overlap",
        "appliedMasks": {
            "solarZenith": {
                "maximumDegrees": MAXIMUM_COD_SOLAR_ZENITH_DEGREES,
                "implementation": "tools/cloud-reference/abi-angles.ts:abiPixelAngles",
                "sampling": "ACM fixed-grid pixel centres at product scan time",
                "excludedEligibleCloudPixelCount": int(eligible_cloud_before_solar_mask.sum() - eligible_cloud.sum()),
                "excludedEligibleCloudAreaM2": float(eligible_area_before_solar_mask - eligible_area),
            },
        },
        "unappliedCorrections": ["cloud_top_parallax"],
        "limitations": "diagnostic only; not the final metric gate or area-overlap collocation; pixel area is the four ellipsoid-intersection corners projected to a tangent ENU plane at the pixel centre; region eligibility uses pixel centres without boundary clipping; cloud-top parallax is not corrected; excludes ACM-invalid pixels, but COD raw 6 and raw 14 remain in the cloud denominator and are reported separately",
    }
    result["indicatorAvailability"] = cod_indicator_availability(
        result["areaWeightedCoverageFraction"], "single_slot",
    )
    result["indicatorAvailability"]["appliedMasks"] = result["appliedMasks"]
    result["indicatorAvailability"]["unappliedCorrections"] = result["unappliedCorrections"]
    result["indicatorAvailability"]["finalMetricBlockers"].remove("solar_angle_mask_not_assessed")
    return result


def grid_pixel_area_weights(
    x_axis: np.ndarray,
    y_axis: np.ndarray,
    projection: dict[str, float],
    row0: int,
    row1: int,
    col0: int,
    col1: int,
) -> np.ndarray:
    """固定格子画素四隅を中心点の局所 ENU 平面へ写した面積 [m²] を返す。"""
    x_edges = coordinate_edges(x_axis)
    y_edges = coordinate_edges(y_axis)
    center_x, center_y = np.meshgrid(x_axis[col0:col1], y_axis[row0:row1])
    center_lat, center_lon, center_visible = grid_to_geodetic(center_x, center_y, projection)
    if not np.all(center_visible):
        fail("ACM area window contains a pixel centre beyond the geostationary limb")
    center_ecef = geodetic_to_ecef_arrays(center_lat, center_lon, projection)
    corner_coordinates = (
        np.meshgrid(x_edges[col0:col1], y_edges[row0:row1]),
        np.meshgrid(x_edges[col0 + 1:col1 + 1], y_edges[row0:row1]),
        np.meshgrid(x_edges[col0 + 1:col1 + 1], y_edges[row0 + 1:row1 + 1]),
        np.meshgrid(x_edges[col0:col1], y_edges[row0 + 1:row1 + 1]),
    )
    east_north: list[tuple[np.ndarray, np.ndarray]] = []
    for corner_x, corner_y in corner_coordinates:
        corner_lat, corner_lon, visible = grid_to_geodetic(corner_x, corner_y, projection)
        if not np.all(visible):
            fail("ACM area window contains a pixel corner beyond the geostationary limb")
        corner_ecef = geodetic_to_ecef_arrays(corner_lat, corner_lon, projection)
        delta = tuple(corner_ecef[index] - center_ecef[index] for index in range(3))
        sin_lon, cos_lon = np.sin(center_lon), np.cos(center_lon)
        sin_lat, cos_lat = np.sin(center_lat), np.cos(center_lat)
        east = -sin_lon * delta[0] + cos_lon * delta[1]
        north = -sin_lat * cos_lon * delta[0] - sin_lat * sin_lon * delta[1] + cos_lat * delta[2]
        east_north.append((east, north))
    twice_area = np.zeros(center_x.shape, dtype=np.float64)
    for index, (east, north) in enumerate(east_north):
        next_east, next_north = east_north[(index + 1) % len(east_north)]
        twice_area += east * next_north - north * next_east
    area = np.abs(twice_area) / 2
    if not np.all(np.isfinite(area)) or np.any(area <= 0):
        fail("ACM pixel area calculation produced non-positive or non-finite values")
    return area


def coordinate_edges(centres: np.ndarray) -> np.ndarray:
    """一次元中心座標を隣接中点と端の半間隔で画素境界へ広げる。"""
    if centres.ndim != 1 or centres.size < 2:
        fail("fixed-grid axes need at least two pixel centres")
    edges = np.empty(centres.size + 1, dtype=np.float64)
    edges[1:-1] = (centres[:-1] + centres[1:]) / 2
    edges[0] = centres[0] - (centres[1] - centres[0]) / 2
    edges[-1] = centres[-1] + (centres[-1] - centres[-2]) / 2
    return edges


def geodetic_to_ecef_arrays(
    latitude: np.ndarray,
    longitude: np.ndarray,
    projection: dict[str, float],
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """測地緯度経度を楕円体表面の ECEF 座標へ変換する。"""
    a, b = projection["a"], projection["b"]
    eccentricity = 1 - b * b / (a * a)
    sin_lat = np.sin(latitude)
    normal = a / np.sqrt(1 - eccentricity * sin_lat * sin_lat)
    return (
        normal * np.cos(latitude) * np.cos(longitude),
        normal * np.cos(latitude) * np.sin(longitude),
        normal * (1 - eccentricity) * sin_lat,
    )


def geodetic_to_grid(latitude: np.ndarray, longitude: np.ndarray, projection: dict[str, float]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """地表座標を GOES-R sweep=x の走査角へ投影し、可視性も返す。"""
    a, b, lon0 = projection["a"], projection["b"], projection["lon0"]
    eccentricity = 1 - b * b / (a * a)
    sin_lat = np.sin(latitude)
    normal = a / np.sqrt(1 - eccentricity * sin_lat * sin_lat)
    earth_x = normal * np.cos(latitude) * np.cos(longitude)
    earth_y = normal * np.cos(latitude) * np.sin(longitude)
    earth_z = normal * (1 - eccentricity) * sin_lat
    cos0, sin0 = math.cos(lon0), math.sin(lon0)
    toward = projection["height"] + a - (earth_x * cos0 + earth_y * sin0)
    east = -earth_x * sin0 + earth_y * cos0
    visible = (
        ((earth_y * cos0 - earth_x * sin0) / (a * a)) * (-east)
        + ((earth_x * cos0 + earth_y * sin0) / (a * a)) * toward
        + (earth_z / (b * b)) * (-earth_z)
    ) > 0
    return np.arctan2(east, np.hypot(toward, earth_z)), np.arctan2(earth_z, toward), visible


def grid_to_geodetic(x: np.ndarray, y: np.ndarray, projection: dict[str, float]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """走査角を GRS80 楕円体との最初の交点へ変換する。"""
    a, b = projection["a"], projection["b"]
    distance = projection["height"] + a
    ratio = a * a / (b * b)
    qa = np.sin(x) ** 2 + np.cos(x) ** 2 * (np.cos(y) ** 2 + ratio * np.sin(y) ** 2)
    qb = -2 * distance * np.cos(x) * np.cos(y)
    qc = distance * distance - a * a
    discriminant = qb * qb - 4 * qa * qc
    visible = discriminant >= 0
    ray = np.where(visible, (-qb - np.sqrt(np.maximum(discriminant, 0))) / (2 * qa), 0)
    sat_x = ray * np.cos(x) * np.cos(y)
    sat_y = -ray * np.sin(x)
    sat_z = ray * np.cos(x) * np.sin(y)
    toward = distance - sat_x
    latitude = np.arctan2(ratio * sat_z, np.hypot(toward, sat_y))
    longitude = projection["lon0"] - np.arctan2(sat_y, toward)
    return latitude, longitude, visible


def region_grid_bounds(region: dict[str, float], projection: dict[str, float]) -> tuple[float, float, float, float]:
    """地域境界を細分化して固定格子上の安全な走査角矩形を求める。"""
    west, east = math.radians(region["westLonDeg"]), math.radians(region["eastLonDeg"])
    south, north = math.radians(region["southLatDeg"]), math.radians(region["northLatDeg"])
    count = max(2, math.ceil(max(east - west, north - south) / math.radians(0.1)))
    edge = np.linspace(0, 1, count + 1)
    latitudes = np.concatenate((np.full_like(edge, south), np.full_like(edge, north), south + edge * (north - south), south + edge * (north - south)))
    longitudes = np.concatenate((west + edge * (east - west), west + edge * (east - west), np.full_like(edge, west), np.full_like(edge, east)))
    x, y, visible = geodetic_to_grid(latitudes, longitudes, projection)
    if not np.any(visible):
        fail("指定地域が衛星の視野外")
    return float(np.min(x[visible])), float(np.max(x[visible])), float(np.min(y[visible])), float(np.max(y[visible]))


def index_window(coordinates: np.ndarray, lower: float, upper: float) -> tuple[int, int]:
    """昇順・降順どちらの座標軸にも対応して包含区間を返す。"""
    if coordinates[0] > coordinates[-1]:
        start, stop = index_window(coordinates[::-1], lower, upper)
        size = coordinates.size
        return size - stop, size - start
    return max(0, int(np.searchsorted(coordinates, lower, side="left")) - 1), min(coordinates.size, int(np.searchsorted(coordinates, upper, side="right")) + 1)


def good_dqf(values: np.ndarray, product: str) -> np.ndarray:
    """各製品で quality が good の画素のみを選ぶ。"""
    if product == "L1B_RAD":
        return values == 0
    if product == "L2_COD":
        # bit 0 は昼夜、bits 1..4 は推定品質。夜の raw=1 も good。
        return (values <= 17) & ((values & 30) == 0)
    if product == "L2_ACTP":
        return (values <= 63) & ((values & 1) == 0)
    if product == "L2_ACHA":
        return values == 0
    if product == "L2_ACM":
        return values == 0
    fail(f"未知の品質製品 {product}")


def raw_valid(values: np.ndarray, variable: Any) -> tuple[np.ndarray, np.ndarray]:
    """fill・範囲外を除き、宣言範囲を持つ生画素だけを残す。"""
    variable.set_auto_maskandscale(False)
    fill = unsigned_value(getattr(variable, "_FillValue", None), variable)
    if fill is None:
        fail(f"{variable.name}: _FillValue がない")
    not_fill = values != fill
    if "valid_range" in variable.ncattrs():
        low, high = unsigned_array(variable.getncattr("valid_range"), variable).astype(np.float64)
        valid = (values >= low) & (values <= high)
    elif "flag_values" in variable.ncattrs():
        valid = np.isin(values, unsigned_array(variable.getncattr("flag_values"), variable))
    else:
        fail(f"{variable.name}: 有効範囲の属性がない")
    return not_fill & valid, not_fill & ~valid


def valid_dqf(values: np.ndarray, variable: Any) -> np.ndarray:
    """DQF の fill と宣言範囲を除いた標本を返す。"""
    valid, _ = raw_valid(values, variable)
    return valid


def unsigned_enabled(variable: Any) -> bool:
    """NetCDF の unsigned 属性が有効か判定する。"""
    if "_Unsigned" not in variable.ncattrs():
        return False
    value = variable.getncattr("_Unsigned")
    return value.decode("ascii").lower() == "true" if isinstance(value, bytes) else str(value).lower() == "true"


def unsigned_array(values: Any, variable: Any) -> np.ndarray:
    """signed storage を同じ bit 幅の unsigned integer として読む。"""
    result = np.asarray(values)
    if unsigned_enabled(variable) and result.dtype.kind == "i":
        result = result.view(np.dtype(f"u{result.dtype.itemsize}"))
    return result


def unsigned_value(value: Any, variable: Any) -> int | float | None:
    """属性の scalar 値にも packed 配列と同じ signed/unsigned 解釈を適用する。"""
    if value is None:
        return None
    return unsigned_array(np.asarray(value), variable).item()


def raw_slice(variable: Any, row0: int, row1: int, col0: int, col1: int) -> np.ndarray:
    """netCDF4 の自動変換を止め、必要なら unsigned 解釈を適用する。"""
    variable.set_auto_maskandscale(False)
    return unsigned_array(variable[row0:row1, col0:col1], variable)


def locate_file(case_dir: Path, product_name: str, satellite: str, slot: str, parent: str) -> Path:
    matches = []
    for path in (case_dir / parent).glob("*.nc"):
        match = FILENAME.fullmatch(path.name)
        if match and match.group("product") == product_name and match.group("satellite") == satellite and match.group("start").startswith(slot):
            matches.append(path)
    if len(matches) != 1:
        fail(f"{parent}/{product_name} {slot}: 一致ファイル数が {len(matches)}")
    return matches[0]


def summarize_product(path: Path, region: dict[str, float], product: str, field_name: str, band: int | None) -> dict[str, Any]:
    """当該製品の独立した格子上で地域内画素を chunk 単位に集計する。"""
    with netCDF4.Dataset(path, "r") as dataset:
        field, dqf = dataset.variables[field_name], dataset.variables["DQF"]
        x_axis, y_axis, projection = grid_parameters(dataset)
        x_min, x_max, y_min, y_max = region_grid_bounds(region, projection)
        x0, x1 = index_window(x_axis, x_min, x_max)
        y0, y1 = index_window(y_axis, y_min, y_max)
        if band is not None and int(dataset.variables["band_id"][()]) != band:
            fail(f"{path.name}: band_id does not match C{band:02d}")
        field.set_auto_maskandscale(False)
        dqf.set_auto_maskandscale(False)
        if (field.dimensions != ("y", "x") or dqf.dimensions != ("y", "x")
            or field.shape != dqf.shape or field.shape != (len(y_axis), len(x_axis))):
            fail(f"{path.name}: field/DQF/native-grid shapes disagree")
        if getattr(field, "grid_mapping", None) != "goes_imager_projection":
            fail(f"{path.name}: science field does not declare the GOES projection")
        if "_FillValue" not in field.ncattrs() or not ({"valid_range", "flag_values"} & set(field.ncattrs())):
            fail(f"{path.name}: science field lacks fill or valid-value metadata")
        if "_FillValue" not in dqf.ncattrs() or "valid_range" not in dqf.ncattrs():
            fail(f"{path.name}: DQF lacks fill or valid-range metadata")
        result: dict[str, Any] = {
            "product": product, "field": field_name, "bandId": band,
            "sourceFile": path.name, "sourceShape": list(field.shape),
            "candidateWindowYX": [y0, y1, x0, x1],
            "regionGridPixelCount": 0, "fieldFillCount": 0,
            "fieldOutOfRangeCount": 0, "fieldValidCount": 0,
            "dqfFillCount": 0, "dqfOutOfRangeCount": 0,
            "dqfRawCounts": {}, "dqfGoodCount": 0,
            "jointGoodFieldAndDqfCount": 0,
        }
        dqf_counts: Counter[int] = Counter()
        value_counts: Counter[int] = Counter()
        for row0 in range(y0, y1, CHUNK_ROWS):
            row1 = min(row0 + CHUNK_ROWS, y1)
            raw_field = raw_slice(field, row0, row1, x0, x1)
            raw_dqf = raw_slice(dqf, row0, row1, x0, x1)
            xx, yy = np.meshgrid(x_axis[x0:x1], y_axis[row0:row1])
            latitude, longitude, visible = grid_to_geodetic(xx, yy, projection)
            inside = (
                visible
                & (latitude >= math.radians(region["southLatDeg"]))
                & (latitude <= math.radians(region["northLatDeg"]))
                & (longitude >= math.radians(region["westLonDeg"]))
                & (longitude <= math.radians(region["eastLonDeg"]))
            )
            if not np.any(inside):
                continue
            region_field, region_dqf = raw_field[inside], raw_dqf[inside]
            field_is_valid, field_oob = raw_valid(region_field, field)
            dqf_fill = unsigned_value(getattr(dqf, "_FillValue", None), dqf)
            if dqf_fill is None or "valid_range" not in dqf.ncattrs():
                fail(f"{path.name}: DQF に fill/range 定義がない")
            dqf_range = unsigned_array(dqf.valid_range, dqf)
            dqf_is_in_range = (region_dqf >= dqf_range[0]) & (region_dqf <= dqf_range[1])
            dqf_is_valid = (region_dqf != dqf_fill) & dqf_is_in_range
            dqf_is_good = good_dqf(region_dqf, product)
            result["regionGridPixelCount"] += int(inside.sum())
            result["fieldFillCount"] += int(np.count_nonzero(region_field == unsigned_value(field._FillValue, field)))
            result["fieldOutOfRangeCount"] += int(field_oob.sum())
            result["fieldValidCount"] += int(field_is_valid.sum())
            result["dqfFillCount"] += int(np.count_nonzero(region_dqf == dqf_fill))
            result["dqfOutOfRangeCount"] += int(np.count_nonzero((region_dqf != dqf_fill) & ~dqf_is_in_range))
            result["dqfGoodCount"] += int(np.count_nonzero(dqf_is_valid & dqf_is_good))
            result["jointGoodFieldAndDqfCount"] += int(np.count_nonzero(field_is_valid & dqf_is_valid & dqf_is_good))
            for value, count in zip(*np.unique(region_dqf, return_counts=True), strict=True):
                dqf_counts[int(value)] += int(count)
            if "flag_values" in field.ncattrs():
                for value, count in zip(*np.unique(region_field, return_counts=True), strict=True):
                    value_counts[int(value)] += int(count)
        result["dqfRawCounts"] = {str(value): count for value, count in sorted(dqf_counts.items())}
        if value_counts:
            result["rawFieldCounts"] = {str(value): count for value, count in sorted(value_counts.items())}
        result["pixelCoverageFraction"] = (
            result["jointGoodFieldAndDqfCount"] / result["regionGridPixelCount"]
            if result["regionGridPixelCount"] else None
        )
        result["coverageDefinition"] = "good DQF and non-fill in-range field pixel-centre count / region pixel-centre count; not area weighted"
        result["gridProjection"] = {key: value for key, value in projection.items()}
        return result


def summarize_cod_cloud_coverage(
    cod_path: Path,
    acm_path: Path,
    region: dict[str, float],
) -> dict[str, Any]:
    """同スロットの good ACM cloud domain に対する COD good coverage を診断する。"""
    with netCDF4.Dataset(cod_path, "r") as cod_dataset, netCDF4.Dataset(acm_path, "r") as acm_dataset:
        scan_time_utc = acm_product_scan_time_utc(acm_dataset, acm_path)
        cod_field, cod_dqf = cod_dataset.variables["COD"], cod_dataset.variables["DQF"]
        acm_field, acm_dqf = acm_dataset.variables["ACM"], acm_dataset.variables["DQF"]
        cod_x, cod_y, cod_projection = grid_parameters(cod_dataset)
        acm_x, acm_y, acm_projection = grid_parameters(acm_dataset)
        validate_cod_acm_grid_alignment(cod_x, cod_y, cod_projection, acm_x, acm_y, acm_projection)
        if (cod_field.dimensions != ("y", "x") or cod_dqf.dimensions != ("y", "x")
            or cod_field.shape != cod_dqf.shape or cod_field.shape != (len(cod_y), len(cod_x))):
            fail(f"{cod_path.name}: COD/DQF/native-grid shapes disagree")
        if (acm_field.dimensions != ("y", "x") or acm_dqf.dimensions != ("y", "x")
            or acm_field.shape != acm_dqf.shape or acm_field.shape != (len(acm_y), len(acm_x))):
            fail(f"{acm_path.name}: ACM/DQF/native-grid shapes disagree")
        cod_field.set_auto_maskandscale(False)
        cod_dqf.set_auto_maskandscale(False)
        acm_field.set_auto_maskandscale(False)
        acm_dqf.set_auto_maskandscale(False)
        x_min, x_max, y_min, y_max = region_grid_bounds(region, cod_projection)
        cod_x0, cod_x1 = index_window(cod_x, x_min, x_max)
        cod_y0, cod_y1 = index_window(cod_y, y_min, y_max)
        result: dict[str, Any] = {
            "eligibleCloudPixelCount": 0,
            "eligibleCloudPixelCountBeforeSolarMask": 0,
            "solarAngleExcludedEligibleCloudPixelCount": 0,
            "goodCodCloudPixelCount": 0,
            "eligibleCloudAreaM2": 0.0,
            "eligibleCloudAreaM2BeforeSolarMask": 0.0,
            "solarAngleExcludedEligibleCloudAreaM2": 0.0,
            "goodCodCloudAreaM2": 0.0,
            "codDqfRawCountsOnEligibleCloudPixels": {},
        }
        dqf_counts: Counter[str] = Counter()
        angle_evaluator = AbiSolarAngleEvaluator()
        try:
            for cod_row0 in range(cod_y0, cod_y1, CHUNK_ROWS):
                cod_row1 = min(cod_row0 + CHUNK_ROWS, cod_y1)
                acm_row0, acm_row1 = cod_row0 * 2, cod_row1 * 2
                acm_col0, acm_col1 = cod_x0 * 2, cod_x1 * 2
                cod_values = raw_slice(cod_field, cod_row0, cod_row1, cod_x0, cod_x1)
                cod_dqf_values = raw_slice(cod_dqf, cod_row0, cod_row1, cod_x0, cod_x1)
                acm_values = raw_slice(acm_field, acm_row0, acm_row1, acm_col0, acm_col1)
                acm_dqf_values = raw_slice(acm_dqf, acm_row0, acm_row1, acm_col0, acm_col1)
                xx, yy = np.meshgrid(acm_x[acm_col0:acm_col1], acm_y[acm_row0:acm_row1])
                latitude, longitude, visible = grid_to_geodetic(xx, yy, acm_projection)
                inside = (
                    visible
                    & (latitude >= math.radians(region["southLatDeg"]))
                    & (latitude <= math.radians(region["northLatDeg"]))
                    & (longitude >= math.radians(region["westLonDeg"]))
                    & (longitude <= math.radians(region["eastLonDeg"]))
                )
                solar_valid = angle_evaluator.daylight_mask(
                    acm_x[acm_col0:acm_col1], acm_y[acm_row0:acm_row1], acm_projection, scan_time_utc,
                )
                pixel_areas = grid_pixel_area_weights(
                    acm_x, acm_y, acm_projection, acm_row0, acm_row1, acm_col0, acm_col1,
                )
                cod_valid, _ = raw_valid(cod_values, cod_field)
                acm_valid, _ = raw_valid(acm_values, acm_field)
                partial = summarize_cod_cloud_eligible_coverage(
                    cod_valid,
                    cod_dqf_values,
                    valid_dqf(cod_dqf_values, cod_dqf),
                    acm_values,
                    acm_valid,
                    acm_dqf_values,
                    valid_dqf(acm_dqf_values, acm_dqf),
                    inside,
                    pixel_areas,
                    solar_valid,
                )
                for key in (
                    "eligibleCloudPixelCount", "eligibleCloudPixelCountBeforeSolarMask",
                    "solarAngleExcludedEligibleCloudPixelCount", "goodCodCloudPixelCount",
                    "eligibleCloudAreaM2", "eligibleCloudAreaM2BeforeSolarMask",
                    "solarAngleExcludedEligibleCloudAreaM2", "goodCodCloudAreaM2",
                ):
                    result[key] += partial[key]
                dqf_counts.update(partial["codDqfRawCountsOnEligibleCloudPixels"])
        finally:
            angle_evaluator.close()
        result["coverageFraction"] = (
            result["goodCodCloudPixelCount"] / result["eligibleCloudPixelCount"]
            if result["eligibleCloudPixelCount"] else None
        )
        result["areaWeightedCoverageFraction"] = (
            result["goodCodCloudAreaM2"] / result["eligibleCloudAreaM2"]
            if result["eligibleCloudAreaM2"] else None
        )
        result["codDqfRawCountsOnEligibleCloudPixels"] = dict(sorted(dqf_counts.items(), key=lambda item: int(item[0])))
        result["scanTimeUtc"] = scan_time_utc
        result["denominatorDefinition"] = "good-DQF valid ACM class 2/3 1 km pixel centres inside the geographic region and with solar zenith <= 70 degrees"
        result["numeratorDefinition"] = "eligible ACM cloud pixel centres whose enclosing 2 km COD pixel has valid in-range COD and good DQF raw 0/1"
        result["areaDenominatorDefinition"] = "sum of local ENU quadrilateral areas for eligible cloud ACM pixel centres"
        result["areaNumeratorDefinition"] = "area denominator pixels whose enclosing COD parent has valid in-range COD and good DQF raw 0/1"
        result["aggregation"] = "verified same-projection 2x2 fixed-grid ACM child-centre to COD parent grouping; reports counts and pixel-centre area weights, not polygon area overlap"
        result["appliedMasks"] = {
            "solarZenith": {
                "maximumDegrees": MAXIMUM_COD_SOLAR_ZENITH_DEGREES,
                "implementation": "tools/cloud-reference/abi-angles.ts:abiPixelAngles",
                "sampling": "ACM fixed-grid pixel centres at product scan time",
                "excludedEligibleCloudPixelCount": result["solarAngleExcludedEligibleCloudPixelCount"],
                "excludedEligibleCloudAreaM2": result["solarAngleExcludedEligibleCloudAreaM2"],
            },
        }
        result["unappliedCorrections"] = ["cloud_top_parallax"]
        result["limitations"] = "diagnostic only; pixel area is the four ellipsoid-intersection corners projected to a tangent ENU plane at the pixel centre; region eligibility uses pixel centres without boundary clipping; cloud-top parallax is not corrected; excludes ACM-invalid pixels, but COD raw 6 and raw 14 remain in the cloud denominator and are reported separately"
        result["indicatorAvailability"] = cod_indicator_availability(
            result["areaWeightedCoverageFraction"], "single_slot",
        )
        result["indicatorAvailability"]["appliedMasks"] = result["appliedMasks"]
        result["indicatorAvailability"]["unappliedCorrections"] = result["unappliedCorrections"]
        result["indicatorAvailability"]["finalMetricBlockers"].remove("solar_angle_mask_not_assessed")
        return result


def acm_product_scan_time_utc(dataset: Any, source: Path) -> str:
    """ACM NetCDF の実 time_coverage_start を角度計算用 UTC として検証する。"""
    try:
        value = dataset.getncattr("time_coverage_start")
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, TypeError, ValueError):
        fail(f"{source.name}: ACM time_coverage_start is missing or invalid")
    if not isinstance(value, str) or not value.endswith("Z") or parsed.utcoffset() != timedelta(0):
        fail(f"{source.name}: ACM time_coverage_start must be explicit UTC ending in Z")
    return value


def case_from_manifest(manifest_path: Path, case_id: str) -> dict[str, Any]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    cases = [case for case in manifest["cases"] if case["id"] == case_id]
    if len(cases) != 1:
        fail(f"manifest に case {case_id} が一意に存在しない")
    case = cases[0]
    if case["source"].get("provider") != "NOAA" or "GOES-" not in case["source"].get("product", ""):
        fail(f"{case_id} は NOAA GOES の系列ではない")
    return case


def series_slots(case: dict[str, Any]) -> list[datetime]:
    """系列の開始・終了を含む、宣言間隔の UTC スロットを返す。"""
    series = case["series"]
    try:
        start = datetime.fromisoformat(series["start"].replace("Z", "+00:00"))
        end = datetime.fromisoformat(series["end"].replace("Z", "+00:00"))
    except (AttributeError, TypeError, ValueError):
        fail(f"{case['id']}: 系列の時刻形式が不正")
    interval = series["intervalMinutes"]
    if (
        start.utcoffset() != timedelta(0)
        or end.utcoffset() != timedelta(0)
        or isinstance(interval, bool)
        or not isinstance(interval, (int, float))
        or (
            isinstance(interval, float)
            and (not math.isfinite(interval) or not interval.is_integer())
        )
        or interval <= 0
        or end < start
    ):
        fail(f"{case['id']}: 系列の時刻または間隔が不正")
    interval = int(interval)
    step = timedelta(minutes=interval)
    elapsed = end - start
    if elapsed.total_seconds() % step.total_seconds() != 0:
        fail(f"{case['id']}: 系列の終了時刻が intervalMinutes に整列していない")
    return [start + step * index for index in range(int(elapsed / step) + 1)]


def summarize_slot(case: dict[str, Any], case_id: str, case_dir: Path, observed_time: datetime) -> list[dict[str, Any]]:
    satellite_match = re.match(r"GOES-(\d+)", case["source"]["product"])
    satellite = f"G{int(satellite_match.group(1)):02d}"
    region = case["observation"]["region"]
    if not (-180 <= region["westLonDeg"] < region["eastLonDeg"] <= 180 and -90 <= region["southLatDeg"] < region["northLatDeg"] <= 90):
        fail(f"{case_id}: 地理 bbox が不正")
    timestamp = f"{observed_time.year}{observed_time.timetuple().tm_yday:03d}{observed_time:%H%M}"
    products = []
    paths: dict[str, Path] = {}
    for parent, product_name, field, dqf_product, band in PRODUCTS:
        path = locate_file(case_dir, product_name, satellite, timestamp, parent)
        paths[dqf_product] = path
        summary = summarize_product(path, region, dqf_product, field, band)
        summary["caseId"] = case_id
        summary["slotStart"] = observed_time.isoformat().replace("+00:00", "Z")
        products.append(summary)
    cod_summary = next(summary for summary in products if summary["product"] == "L2_COD")
    cod_summary["cloudEligibleCoverageDiagnostic"] = summarize_cod_cloud_coverage(
        paths["L2_COD"], paths["L2_ACM"], region,
    )
    return products


AGGREGATE_COUNTS = (
    "regionGridPixelCount", "fieldFillCount", "fieldOutOfRangeCount", "fieldValidCount",
    "dqfFillCount", "dqfOutOfRangeCount", "dqfGoodCount", "jointGoodFieldAndDqfCount",
)


def aggregate_product_slots(product: str, field: str, band: int | None, summaries: list[dict[str, Any]]) -> dict[str, Any]:
    """スロット別の品質系列と pixel-weighted coverage を集約する。"""
    aggregate = {key: sum(summary[key] for summary in summaries) for key in AGGREGATE_COUNTS}
    dqf_counts: Counter[str] = Counter()
    field_counts: Counter[str] = Counter()
    for summary in summaries:
        dqf_counts.update(summary["dqfRawCounts"])
        field_counts.update(summary.get("rawFieldCounts", {}))
    aggregate_result: dict[str, Any] = {
        "product": product,
        "field": field,
        "bandId": band,
        "slotCount": len(summaries),
        **aggregate,
        "dqfRawCounts": dict(sorted(dqf_counts.items(), key=lambda item: int(item[0]))),
        "pixelCoverageFraction": (
            aggregate["jointGoodFieldAndDqfCount"] / aggregate["regionGridPixelCount"]
            if aggregate["regionGridPixelCount"] else None
        ),
        "coverageDefinition": "sum of good DQF and non-fill in-range field pixel-centre counts / sum of region pixel-centre counts; not area weighted",
        "slots": [
            {
                "slotStart": summary["slotStart"],
                "sourceFile": summary["sourceFile"],
                **{key: summary[key] for key in AGGREGATE_COUNTS},
                "pixelCoverageFraction": summary["pixelCoverageFraction"],
                "dqfRawCounts": summary["dqfRawCounts"],
            }
            for summary in summaries
        ],
    }
    diagnostics = [summary["cloudEligibleCoverageDiagnostic"] for summary in summaries
                   if isinstance(summary.get("cloudEligibleCoverageDiagnostic"), dict)]
    if diagnostics:
        eligible = sum(diagnostic["eligibleCloudPixelCount"] for diagnostic in diagnostics)
        eligible_before_solar = sum(diagnostic.get("eligibleCloudPixelCountBeforeSolarMask", diagnostic["eligibleCloudPixelCount"]) for diagnostic in diagnostics)
        solar_excluded = sum(diagnostic.get("solarAngleExcludedEligibleCloudPixelCount", 0) for diagnostic in diagnostics)
        good_cod = sum(diagnostic["goodCodCloudPixelCount"] for diagnostic in diagnostics)
        eligible_area = sum(diagnostic["eligibleCloudAreaM2"] for diagnostic in diagnostics)
        eligible_area_before_solar = sum(diagnostic.get("eligibleCloudAreaM2BeforeSolarMask", diagnostic["eligibleCloudAreaM2"]) for diagnostic in diagnostics)
        solar_excluded_area = sum(diagnostic.get("solarAngleExcludedEligibleCloudAreaM2", 0.0) for diagnostic in diagnostics)
        good_cod_area = sum(diagnostic["goodCodCloudAreaM2"] for diagnostic in diagnostics)
        cloud_dqf_counts: Counter[str] = Counter()
        for diagnostic in diagnostics:
            cloud_dqf_counts.update(diagnostic["codDqfRawCountsOnEligibleCloudPixels"])
        aggregate_diagnostic = {
            **{key: diagnostics[0][key] for key in (
                "denominatorDefinition", "numeratorDefinition", "areaDenominatorDefinition",
                "areaNumeratorDefinition", "aggregation", "limitations", "appliedMasks",
                "unappliedCorrections",
            )},
            "slotCount": len(diagnostics),
            "eligibleCloudPixelCount": eligible,
            "eligibleCloudPixelCountBeforeSolarMask": eligible_before_solar,
            "solarAngleExcludedEligibleCloudPixelCount": solar_excluded,
            "goodCodCloudPixelCount": good_cod,
            "coverageFraction": good_cod / eligible if eligible else None,
            "eligibleCloudAreaM2": eligible_area,
            "eligibleCloudAreaM2BeforeSolarMask": eligible_area_before_solar,
            "solarAngleExcludedEligibleCloudAreaM2": solar_excluded_area,
            "goodCodCloudAreaM2": good_cod_area,
            "areaWeightedCoverageFraction": good_cod_area / eligible_area if eligible_area else None,
            "codDqfRawCountsOnEligibleCloudPixels": dict(
                sorted(cloud_dqf_counts.items(), key=lambda item: int(item[0])),
            ),
        }
        first_solar_mask = dict(diagnostics[0].get("appliedMasks", {}).get("solarZenith", {
            "maximumDegrees": MAXIMUM_COD_SOLAR_ZENITH_DEGREES,
            "implementation": "tools/cloud-reference/abi-angles.ts:abiPixelAngles",
            "sampling": "ACM fixed-grid pixel centres at product scan time",
        }))
        first_solar_mask.update({
            "excludedEligibleCloudPixelCount": solar_excluded,
            "excludedEligibleCloudAreaM2": solar_excluded_area,
        })
        aggregate_diagnostic["appliedMasks"] = {"solarZenith": first_solar_mask}
        aggregate_diagnostic["indicatorAvailability"] = cod_indicator_availability(
            aggregate_diagnostic["areaWeightedCoverageFraction"], "aggregated_series",
        )
        aggregate_diagnostic["indicatorAvailability"]["appliedMasks"] = aggregate_diagnostic["appliedMasks"]
        aggregate_diagnostic["indicatorAvailability"]["unappliedCorrections"] = aggregate_diagnostic["unappliedCorrections"]
        aggregate_diagnostic["indicatorAvailability"]["finalMetricBlockers"].remove("solar_angle_mask_not_assessed")
        aggregate_result["cloudEligibleCoverageDiagnostic"] = aggregate_diagnostic
        for slot, summary in zip(aggregate_result["slots"], summaries, strict=True):
            diagnostic = summary.get("cloudEligibleCoverageDiagnostic")
            if isinstance(diagnostic, dict):
                slot["cloudEligibleCoverageDiagnostic"] = diagnostic
    if field_counts:
        aggregate_result["rawFieldCounts"] = dict(sorted(field_counts.items(), key=lambda item: int(item[0])))
    return aggregate_result


def run(manifest_path: Path, case_id: str, case_dir: Path, all_slots: bool = False) -> dict[str, Any]:
    case = case_from_manifest(manifest_path, case_id)
    region = case["observation"]["region"]
    if not (-180 <= region["westLonDeg"] < region["eastLonDeg"] <= 180 and -90 <= region["southLatDeg"] < region["northLatDeg"] <= 90):
        fail(f"{case_id}: 地理 bbox が不正")
    slots = series_slots(case) if all_slots else [datetime.fromisoformat(case["series"]["start"].replace("Z", "+00:00"))]
    per_slot = [summarize_slot(case, case_id, case_dir, observed_time) for observed_time in slots]
    if not all_slots:
        products = per_slot[0]
    else:
        products = [
            aggregate_product_slots(
                initial["product"], initial["field"], initial["bandId"],
                [slot_products[index] for slot_products in per_slot],
            )
            for index, initial in enumerate(per_slot[0])
        ]
    return {
        "schemaVersion": 2 if all_slots else 1,
        "caseId": case_id,
        "split": case["split"],
        "observationStart": case["series"]["start"],
        "observationEnd": case["series"]["end"] if all_slots else case["series"]["start"],
        "slotCount": len(slots),
        "region": region,
        "scope": "all declared series slots; each product is summarized on its native grid; raw science valid-range and product DQF are conjoined; COD adds ACM-centre solar zenith <= 70 degree masked count and pixel-centre area diagnostics, not polygon-overlap or a final metric gate; no scan-line timing, cloud-top parallax correction, or calibrated radiance" if all_slots else "one manifest start slot; each product is summarized on its native grid; raw science valid-range and product DQF are conjoined; COD adds ACM-centre solar zenith <= 70 degree masked count and pixel-centre area diagnostics, not polygon-overlap or a final metric gate; no scan-line timing, cloud-top parallax correction, or calibrated radiance",
        "products": products,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("case_id", help="manifest の NOAA case ID")
    parser.add_argument("case_dir", type=Path, help="取得済みケースのディレクトリ")
    parser.add_argument("--manifest", type=Path, default=Path(__file__).with_name("manifest.json"))
    parser.add_argument("--all-slots", action="store_true", help="manifest の全系列スロットを集計する")
    args = parser.parse_args()
    try:
        report = run(args.manifest, args.case_id, args.case_dir.resolve(), all_slots=args.all_slots)
    except (OSError, ValueError, KeyError, RegionError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(report, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
