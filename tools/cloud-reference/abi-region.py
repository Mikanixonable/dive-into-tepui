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
    start = datetime.fromisoformat(series["start"].replace("Z", "+00:00"))
    end = datetime.fromisoformat(series["end"].replace("Z", "+00:00"))
    interval = int(series["intervalMinutes"])
    if start.utcoffset() is None or end.utcoffset() is None or interval <= 0 or end < start:
        fail(f"{case['id']}: 系列の時刻または間隔が不正")
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
    for parent, product_name, field, dqf_product, band in PRODUCTS:
        path = locate_file(case_dir, product_name, satellite, timestamp, parent)
        summary = summarize_product(path, region, dqf_product, field, band)
        summary["caseId"] = case_id
        summary["slotStart"] = observed_time.isoformat().replace("+00:00", "Z")
        products.append(summary)
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
        "scope": "all declared series slots; each product is summarized on its native grid; raw science valid-range and product DQF are conjoined; no cross-product collocation, scan-line timing, solar mask, cloud parallax, area weighting, calibrated radiance, or evaluation metric" if all_slots else "one manifest start slot; each product is summarized on its native grid; no cross-product collocation, scan-line timing, solar mask, cloud parallax, area weighting, calibrated radiance, or evaluation metric",
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
