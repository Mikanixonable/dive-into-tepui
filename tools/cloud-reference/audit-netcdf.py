#!/usr/bin/env python3
"""保持した GOES ABI NetCDF の構造と生データの画素数を監査する。

データ整合性の監査のみを行い、品質マスク、幾何補正、視差、照合、観測指標は扱わない。
"""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import sys
from typing import Any

import netCDF4
import numpy as np


CHUNK_ROWS = 128
PRODUCTS = (
    ("ABI-L1b-RadF", "L1b-RadF-M6C02", "Rad", 2),
    ("ABI-L1b-RadF", "L1b-RadF-M6C13", "Rad", 13),
    ("ABI-L2-CODF", "L2-CODF-M6", "COD", None),
    ("ABI-L2-ACHAF", "L2-ACHAF-M6", "HT", None),
    ("ABI-L2-ACTPF", "L2-ACTPF-M6", "Phase", None),
    ("ABI-L2-ACMF", "L2-ACMF-M6", "ACM", None),
)
FILENAME = re.compile(
    r"^OR_ABI-(?P<product>[A-Za-z0-9-]+)_(?P<satellite>G\d{2})_"
    r"s(?P<start>\d{14})_e(?P<end>\d{14})_c(?P<created>\d{14})\.nc$"
)
NOAA_TIME = re.compile(r"^(\d{4})(\d{3})(\d{2})(\d{2})(\d{3})$")


class AuditError(Exception):
    """必須の監査条件を満たさない入力を示す。"""


def fail(message: str) -> None:
    raise AuditError(message)


def required_attribute(variable: Any, name: str) -> Any:
    if name not in variable.ncattrs():
        fail(f"{variable.name}: missing required attribute {name}")
    return getattr(variable, name)


def unsigned_scalar(value: Any, unsigned: bool, itemsize: int) -> int | float:
    scalar = np.asarray(value).item()
    if unsigned and isinstance(scalar, (int, np.integer)) and scalar < 0:
        return scalar + (1 << (8 * itemsize))
    return scalar


def raw_array(variable: Any, start: int, stop: int) -> np.ndarray:
    variable.set_auto_maskandscale(False)
    values = np.asarray(variable[start:stop, :])
    is_unsigned = "_Unsigned" in variable.ncattrs() and variable.getncattr("_Unsigned") == "true"
    if is_unsigned:
        if values.dtype.kind == "i":
            values = values.view(np.dtype(f"u{values.dtype.itemsize}"))
    return values


def utc_scan_time(value: str) -> datetime:
    match = NOAA_TIME.fullmatch(value)
    if match is None:
        fail(f"invalid NOAA timestamp: {value}")
    year, day, hour, minute, tenth = (int(part) for part in match.groups())
    if not (1 <= day <= 366 and 0 <= hour <= 23 and 0 <= minute <= 59 and 0 <= tenth <= 599):
        fail(f"invalid NOAA timestamp: {value}")
    try:
        start = datetime(year, 1, 1, tzinfo=timezone.utc) + timedelta(
            days=day - 1, hours=hour, minutes=minute, milliseconds=tenth * 100,
        )
    except ValueError as error:
        fail(f"invalid NOAA timestamp {value}: {error}")
    if start.year != year or start.timetuple().tm_yday != day:
        fail(f"invalid NOAA day-of-year: {value}")
    return start


def filename_match(path: Path, product_name: str, satellite: str, slot: str) -> bool:
    match = FILENAME.fullmatch(path.name)
    return bool(
        match
        and match.group("product") == product_name
        and match.group("satellite") == satellite
        and match.group("start").startswith(slot)
    )


def scan_slots(series: dict[str, Any]) -> list[str]:
    try:
        start = datetime.fromisoformat(series["start"].replace("Z", "+00:00"))
        end = datetime.fromisoformat(series["end"].replace("Z", "+00:00"))
        interval = int(series["intervalMinutes"])
    except (KeyError, TypeError, ValueError) as error:
        fail(f"invalid manifest series: {error}")
    if (start.tzinfo is None or end.tzinfo is None
        or start.utcoffset() != timedelta(0) or end.utcoffset() != timedelta(0)
        or interval <= 0 or start >= end):
        fail("manifest series requires ordered timezone-aware times and a positive interval")
    if start.second or start.microsecond or end.second or end.microsecond:
        fail("manifest series bounds must align to whole minutes")
    duration = (end - start).total_seconds()
    if duration % (interval * 60) != 0:
        fail("manifest series end is not aligned to its interval")
    result = []
    cursor = start
    while cursor <= end:
        result.append(cursor.strftime("%Y%j%H%M"))
        cursor += timedelta(minutes=interval)
    return result


def expected_files(
    case_dir: Path,
    satellite: str,
    inventory_slots: list[str],
    required_slots: list[str],
) -> dict[tuple[str, str], Path]:
    all_nc = sorted(case_dir.rglob("*.nc"))
    if not all_nc:
        fail(f"no NetCDF files under {case_dir}")
    for candidate in all_nc:
        if candidate.is_symlink() or not candidate.is_file():
            fail(f"NetCDF inventory contains a link or non-file: {candidate}")
    selected: dict[tuple[str, str], Path] = {}
    inventory_names = {(name, slot) for slot in inventory_slots for _, name, _, _ in PRODUCTS}
    required_names = {(name, slot) for slot in required_slots for _, name, _, _ in PRODUCTS}
    for candidate in all_nc:
        matches = [
            (name, slot)
            for name, slot in inventory_names
            if filename_match(candidate, name, satellite, slot)
        ]
        if len(matches) != 1:
            fail(f"unexpected or ambiguous NetCDF file: {candidate.relative_to(case_dir)}")
        key = matches[0]
        if key in selected:
            fail(f"duplicate file for {key[0]} slot {key[1]}")
        selected[key] = candidate
    missing = sorted(required_names - selected.keys())
    if missing:
        fail(f"missing expected product/slot: {missing[0][0]} slot {missing[0][1]}")
    if len(selected) < len(required_names):
        fail(f"expected at least {len(required_names)} files, found {len(selected)}")
    return selected


def validate_identity(
    dataset: Any,
    path: Path,
    satellite: str,
    slot: str,
    filename_start: datetime,
    filename_end: datetime,
) -> tuple[datetime, datetime]:
    required_globals = ("platform_ID", "dataset_name", "time_coverage_start", "time_coverage_end")
    for name in required_globals:
        if name not in dataset.ncattrs():
            fail(f"{path.name}: missing global attribute {name}")
    if dataset.getncattr("platform_ID") != satellite:
        fail(f"{path.name}: platform_ID does not match {satellite}")
    if dataset.getncattr("dataset_name") != path.name:
        fail(f"{path.name}: dataset_name does not match filename")
    try:
        global_start = datetime.fromisoformat(dataset.getncattr("time_coverage_start").replace("Z", "+00:00"))
        global_end = datetime.fromisoformat(dataset.getncattr("time_coverage_end").replace("Z", "+00:00"))
    except ValueError as error:
        fail(f"{path.name}: invalid global time coverage: {error}")
    if global_start.utcoffset() != timedelta(0) or global_end.utcoffset() != timedelta(0):
        fail(f"{path.name}: global time coverage must be UTC")
    if abs((global_start - filename_start).total_seconds()) > 0.11:
        fail(f"{path.name}: time_coverage_start disagrees with NOAA filename")
    if abs((global_end - filename_end).total_seconds()) > 0.11:
        fail(f"{path.name}: time_coverage_end disagrees with NOAA filename")
    if not global_start.strftime("%Y%j%H%M").startswith(slot) or global_end <= global_start:
        fail(f"{path.name}: time coverage does not match selected slot {slot}")
    return global_start, global_end


def validate_projection(
    dataset: Any,
    path: Path,
    common_projection: dict[str, float] | None,
) -> tuple[Any, Any, dict[str, float]]:
    for variable_name in ("x", "y", "goes_imager_projection"):
        if variable_name not in dataset.variables:
            fail(f"{path.name}: missing variable {variable_name}")
    x = dataset.variables["x"]
    y = dataset.variables["y"]
    if x.dimensions != ("x",) or y.dimensions != ("y",):
        fail(f"{path.name}: x/y coordinates have unexpected dimensions")
    for coordinate in (x, y):
        if required_attribute(coordinate, "units") != "rad":
            fail(f"{path.name}: x/y coordinate units must be radians")
        for name in ("scale_factor", "add_offset"):
            if name not in coordinate.ncattrs() or not np.isfinite(float(coordinate.getncattr(name))):
                fail(f"{path.name}: {coordinate.name} coordinate lacks finite packed {name}")
    projection = dataset.variables["goes_imager_projection"]
    projection_attributes = (
        "perspective_point_height", "semi_major_axis", "semi_minor_axis",
        "longitude_of_projection_origin",
    )
    projection_values = {
        name: float(required_attribute(projection, name)) for name in projection_attributes
    }
    if not all(np.isfinite(value) for value in projection_values.values()):
        fail(f"{path.name}: projection contains non-finite values")
    if required_attribute(projection, "grid_mapping_name") != "geostationary":
        fail(f"{path.name}: unsupported grid mapping")
    if required_attribute(projection, "sweep_angle_axis") != "x":
        fail(f"{path.name}: expected sweep=x")
    if common_projection is not None and any(
        abs(projection_values[name] - common_projection[name]) > 1e-6
        for name in projection_attributes
    ):
        fail(f"{path.name}: projection disagrees with other products in selected slot")
    return x, y, projection_values


def validate_scan_time(
    dataset: Any,
    path: Path,
    global_start: datetime,
    global_end: datetime,
) -> datetime:
    for variable_name in ("t", "time_bounds"):
        if variable_name not in dataset.variables:
            fail(f"{path.name}: missing variable {variable_name}")
    time_var = dataset.variables["t"]
    if time_var.ndim != 0 or not str(required_attribute(time_var, "units")).startswith("seconds since "):
        fail(f"{path.name}: t must be scalar CF seconds since an epoch")
    bounds = np.asarray(dataset.variables["time_bounds"][:], dtype=np.float64)
    if bounds.shape != (2,) or not np.all(np.isfinite(bounds)) or bounds[1] <= bounds[0]:
        fail(f"{path.name}: invalid time_bounds")
    epoch_text = required_attribute(time_var, "units").removeprefix("seconds since ")
    try:
        epoch = datetime.fromisoformat(epoch_text.replace("Z", "+00:00"))
    except ValueError as error:
        fail(f"{path.name}: unsupported t epoch {epoch_text}: {error}")
    if epoch.tzinfo is None:
        epoch = epoch.replace(tzinfo=timezone.utc)
    bound_start = epoch + timedelta(seconds=float(bounds[0]))
    bound_end = epoch + timedelta(seconds=float(bounds[1]))
    midpoint = epoch + timedelta(seconds=float(time_var[()]))
    if abs((bound_start - global_start).total_seconds()) > 0.11:
        fail(f"{path.name}: time_bounds start disagrees with global coverage")
    if abs((bound_end - global_end).total_seconds()) > 0.11:
        fail(f"{path.name}: time_bounds end disagrees with global coverage")
    if not bound_start <= midpoint <= bound_end:
        fail(f"{path.name}: t lies outside time_bounds")
    return midpoint


def validate_science_variables(
    dataset: Any,
    path: Path,
    field_name: str,
    band_id: int | None,
    x: Any,
    y: Any,
) -> tuple[Any, Any]:
    if field_name not in dataset.variables or "DQF" not in dataset.variables:
        fail(f"{path.name}: missing {field_name} or DQF variable")
    field = dataset.variables[field_name]
    dqf = dataset.variables["DQF"]
    if required_attribute(field, "grid_mapping") != "goes_imager_projection":
        fail(f"{path.name}: science field uses an unexpected grid mapping")
    if field.dimensions != ("y", "x") or dqf.dimensions != ("y", "x"):
        fail(f"{path.name}: field and DQF must have y,x dimensions")
    if field.shape != dqf.shape or field.shape != (len(y), len(x)):
        fail(f"{path.name}: field/DQF/x/y shapes disagree")
    for variable in (field, dqf):
        if "_FillValue" not in variable.ncattrs():
            fail(f"{path.name}: {variable.name} must declare _FillValue")
    if "valid_range" not in dqf.ncattrs():
        fail(f"{path.name}: DQF must declare valid_range")
    if "valid_range" not in field.ncattrs() and "flag_values" not in field.ncattrs():
        fail(f"{path.name}: science field must declare valid_range or flag_values")
    if ("scale_factor" in field.ncattrs()) != ("add_offset" in field.ncattrs()):
        fail(f"{path.name}: field scale_factor/add_offset must be declared together")
    for attribute in ("scale_factor", "add_offset"):
        if attribute in field.ncattrs() and not np.isfinite(float(field.getncattr(attribute))):
            fail(f"{path.name}: invalid field {attribute}")
    if band_id is not None:
        if "band_id" not in dataset.variables or int(dataset.variables["band_id"][()]) != band_id:
            fail(f"{path.name}: band_id does not match C{band_id:02d}")
    return field, dqf


def count_raw_pixels(field: Any, dqf: Any, path: Path) -> dict[str, Any]:
    field_unsigned = "_Unsigned" in field.ncattrs() and field.getncattr("_Unsigned") == "true"
    field_fill = unsigned_scalar(field.getncattr("_FillValue"), field_unsigned, np.dtype(field.dtype).itemsize)
    dqf_unsigned = "_Unsigned" in dqf.ncattrs() and dqf.getncattr("_Unsigned") == "true"
    dqf_fill = unsigned_scalar(dqf.getncattr("_FillValue"), dqf_unsigned, np.dtype(dqf.dtype).itemsize)
    if "valid_range" in field.ncattrs():
        field_range = np.asarray(field.getncattr("valid_range"), dtype=np.float64)
        field_categories = None
        if field_range.shape != (2,) or field_range[1] < field_range[0]:
            fail(f"{path.name}: invalid field valid_range")
    else:
        field_range = None
        field_categories = np.asarray(field.getncattr("flag_values"), dtype=np.float64)
        if field_categories.ndim != 1 or field_categories.size == 0:
            fail(f"{path.name}: invalid field flag_values")
    dqf_range = np.asarray(dqf.getncattr("valid_range"), dtype=np.float64)
    if dqf_range.shape != (2,) or dqf_range[1] < dqf_range[0]:
        fail(f"{path.name}: invalid DQF valid_range")

    counts = PixelCounts()
    for row_start in range(0, field.shape[0], CHUNK_ROWS):
        row_end = min(row_start + CHUNK_ROWS, field.shape[0])
        raw_field = raw_array(field, row_start, row_end)
        raw_dqf = raw_array(dqf, row_start, row_end)
        counts.add(raw_field, raw_dqf, field_fill, field_range, field_categories, dqf_fill, dqf_range)

    pixel_count = field.shape[0] * field.shape[1]
    if counts.field_valid + counts.field_fill + counts.field_out_of_range != pixel_count:
        fail(f"{path.name}: field count partitions do not sum to image size")
    if counts.dqf_in_range + counts.dqf_fill + counts.dqf_out_of_range != pixel_count:
        fail(f"{path.name}: DQF count partitions do not sum to image size")
    if sum(counts.dqf_histogram.values()) != pixel_count:
        fail(f"{path.name}: raw DQF histogram does not sum to image size")
    return {
        "dqf_raw_counts": {str(key): counts.dqf_histogram[key] for key in sorted(counts.dqf_histogram)},
        "dqf_fill_value": int(dqf_fill),
        "dqf_valid_range": [float(dqf_range[0]), float(dqf_range[1])],
        "dqf_in_range_samples": counts.dqf_in_range,
        "dqf_fill_samples": counts.dqf_fill,
        "dqf_out_of_range_samples": counts.dqf_out_of_range,
        "field_valid_samples": counts.field_valid,
        "field_fill_samples": counts.field_fill,
        "field_out_of_range_samples": counts.field_out_of_range,
        "field_fill_value": int(field_fill),
        "field_units": getattr(field, "units", None),
        "field_scale_factor": float(field.getncattr("scale_factor")) if "scale_factor" in field.ncattrs() else None,
        "field_add_offset": float(field.getncattr("add_offset")) if "add_offset" in field.ncattrs() else None,
        "field_valid_range": [float(field_range[0]), float(field_range[1])] if field_range is not None else None,
        "field_valid_values": [float(value) for value in field_categories] if field_categories is not None else None,
    }


class PixelCounts:
    """生フィールドと DQF の画素区分を重複なく集計する。"""

    def __init__(self) -> None:
        self.dqf_histogram: Counter[int] = Counter()
        self.field_valid = 0
        self.field_fill = 0
        self.field_out_of_range = 0
        self.dqf_in_range = 0
        self.dqf_fill = 0
        self.dqf_out_of_range = 0

    def add(
        self,
        raw_field: np.ndarray,
        raw_dqf: np.ndarray,
        field_fill: int | float,
        field_range: np.ndarray | None,
        field_categories: np.ndarray | None,
        dqf_fill: int | float,
        dqf_range: np.ndarray,
    ) -> None:
        field_values = raw_field.astype(np.float64, copy=False)
        dqf_values = raw_dqf.astype(np.float64, copy=False)
        field_not_fill = raw_field != field_fill
        dqf_not_fill = raw_dqf != dqf_fill
        if field_range is not None:
            field_in_range = (field_values >= field_range[0]) & (field_values <= field_range[1])
        else:
            field_in_range = np.isin(field_values, field_categories)
        dqf_in_range = (dqf_values >= dqf_range[0]) & (dqf_values <= dqf_range[1])
        self.field_fill += int(np.count_nonzero(~field_not_fill))
        self.field_out_of_range += int(np.count_nonzero(field_not_fill & ~field_in_range))
        self.field_valid += int(np.count_nonzero(field_not_fill & field_in_range & np.isfinite(field_values)))
        self.dqf_fill += int(np.count_nonzero(~dqf_not_fill))
        self.dqf_out_of_range += int(np.count_nonzero(dqf_not_fill & ~dqf_in_range))
        self.dqf_in_range += int(np.count_nonzero(dqf_not_fill & dqf_in_range))
        for value, count in zip(*np.unique(raw_dqf, return_counts=True), strict=True):
            self.dqf_histogram[int(value)] += int(count)


def check_file(
    path: Path,
    case_dir: Path,
    product_name: str,
    field_name: str,
    band_id: int | None,
    satellite: str,
    slot: str,
    common_projection: dict[str, float] | None,
) -> tuple[dict[str, Any], dict[str, float]]:
    match = FILENAME.fullmatch(path.name)
    if match is None:
        fail(f"invalid filename: {path}")
    filename_start = utc_scan_time(match.group("start"))
    filename_end = utc_scan_time(match.group("end"))
    if filename_end <= filename_start or utc_scan_time(match.group("created")) < filename_end:
        fail(f"invalid start/end/creation ordering: {path.name}")
    try:
        dataset = netCDF4.Dataset(path, "r")
    except OSError as error:
        fail(f"cannot open {path}: {error}")
    with dataset:
        global_start, global_end = validate_identity(
            dataset, path, satellite, slot, filename_start, filename_end,
        )
        x, y, projection_values = validate_projection(dataset, path, common_projection)
        midpoint = validate_scan_time(dataset, path, global_start, global_end)
        field, dqf = validate_science_variables(dataset, path, field_name, band_id, x, y)
        pixel_counts = count_raw_pixels(field, dqf, path)
        result = {
            "slot": slot,
            "product": product_name,
            "field": field_name,
            "path": path.relative_to(case_dir).as_posix(),
            "shape": list(field.shape),
            "x_step_rad": float(x.getncattr("scale_factor")),
            "y_step_rad": float(y.getncattr("scale_factor")),
            "time_start": global_start.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
            "time_end": global_end.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
            "time_midpoint": midpoint.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
            "projection": projection_values,
            **pixel_counts,
        }
        return result, projection_values


def audit(manifest_path: Path, case_id: str, case_dir: Path, only_slot: str | None) -> dict[str, Any]:
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot read manifest: {error}")
    cases = [case for case in manifest.get("cases", []) if case.get("id") == case_id]
    if len(cases) != 1:
        fail(f"manifest must contain exactly one case named {case_id}")
    case = cases[0]
    source = case.get("source", {})
    match = re.match(r"^GOES-(\d+) ABI ", source.get("product", ""))
    if source.get("provider") != "NOAA" or not match:
        fail(f"case {case_id} is not a supported NOAA GOES ABI case")
    satellite = f"G{int(match.group(1)):02d}"
    slots = scan_slots(case["series"])
    requested_slots = slots
    if only_slot is not None:
        if only_slot not in slots:
            fail(f"selected slot {only_slot} is outside manifest case series")
        requested_slots = [only_slot]
    selected = expected_files(case_dir, satellite, slots, requested_slots)
    slots = requested_slots
    results = []
    for slot in slots:
        common_projection = None
        common_time: datetime | None = None
        for directory, product_name, field_name, band_id in PRODUCTS:
            key = (product_name, slot)
            path = selected[key]
            if path.parent.name != directory:
                fail(f"{path.name}: parent directory must be {directory}")
            result, projection = check_file(
                path, case_dir, product_name, field_name,
                band_id, satellite, slot, common_projection,
            )
            if common_projection is None:
                common_projection = projection
            product_start = datetime.fromisoformat(result["time_start"].replace("Z", "+00:00"))
            if common_time is not None and abs((product_start - common_time).total_seconds()) > 0.11:
                fail(f"{path.name}: scan start disagrees with other products in selected slot")
            common_time = common_time or product_start
            results.append(result)
    return {
        "schemaVersion": 1,
        "caseId": case_id,
        "satellite": satellite,
        "auditedSlots": slots,
        "scope": "NetCDF schema, timestamps, fixed-grid metadata, raw fill/range and DQF counts only; no complete masks, geometry, collocation, parallax or observation metrics",
        "files": results,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("case_id", help="case id from the manifest")
    parser.add_argument("case_dir", type=Path, help="directory containing this case's retained NetCDF files")
    parser.add_argument("--manifest", type=Path, default=Path(__file__).with_name("manifest.json"))
    parser.add_argument("--slot", help="audit one manifest slot, formatted YYYYDDDHHMM")
    args = parser.parse_args()
    try:
        report = audit(args.manifest, args.case_id, args.case_dir.resolve(), args.slot)
    except AuditError as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(report, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
