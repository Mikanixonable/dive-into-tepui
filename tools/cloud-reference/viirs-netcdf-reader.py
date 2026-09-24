"""VIIRS CLDPROP L2 NetCDF から COD 復号器用の packed 入力を読む。

版、寸法、属性、変数の期待値は NASA の Collection 1 file spec にある
v1.0 CDL 例から v1.1 へ外挿した暫定契約である。実 v1.1 granule の
検査は未実施であり、合成 NetCDF だけで検証している。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
import re
from typing import Any

import netCDF4
import numpy as np


FILENAME = re.compile(
    r"^CLDPROP_L2_VIIRS_SNPP\.A(?P<year>\d{4})(?P<day>\d{3})\."
    r"(?P<hour>\d{2})(?P<minute>\d{2})\.011\."
    r"(?P<created>\d{13})\.nc$"
)
QA_DESCRIPTION_KEYS = tuple(f"description{index:02d}" for index in (
    20, 22, 24, 25, 26, 27, 37, 39, 44, 45, 49, 50, 51, 54, 55, 72, 73,
))
CLOUD_MASK_DESCRIPTION_KEYS = tuple(f"description{index:02d}" for index in (
    14, 15, 17, 18, 20, 23, 24, 25, 26,
))


class ViirsNetcdfError(ValueError):
    """VIIRS NetCDF が COD 参照用の契約を満たさない。"""


@dataclass(frozen=True)
class ViirsCodInputs:
    """品質 decoder に渡す raw 配列と granule 識別情報。"""

    best_point_cod_raw: np.ndarray
    quality_assurance: np.ndarray
    cloud_mask: np.ndarray
    solar_zenith_raw: np.ndarray
    latitude: np.ndarray
    longitude: np.ndarray
    processing_version: str
    qa_descriptions: dict[str, str]
    cloud_mask_descriptions: dict[str, str]
    granule_name: str
    time_coverage_start: datetime
    time_coverage_end: datetime

    def decoder_arguments(self) -> dict[str, Any]:
        """既存 decoder のキーワード引数だけを返す。"""
        return {
            "best_point_cod_raw": self.best_point_cod_raw,
            "quality_assurance": self.quality_assurance,
            "cloud_mask": self.cloud_mask,
            "solar_zenith_raw": self.solar_zenith_raw,
            "latitude": self.latitude,
            "longitude": self.longitude,
            "processing_version": self.processing_version,
            "qa_descriptions": self.qa_descriptions,
            "cloud_mask_descriptions": self.cloud_mask_descriptions,
        }


def _fail(path: Path, message: str) -> None:
    raise ViirsNetcdfError(f"{path.name}: {message}")


def _required_attribute(owner: Any, path: Path, label: str, name: str) -> Any:
    if name not in owner.ncattrs():
        _fail(path, f"{label} lacks required attribute {name}")
    return owner.getncattr(name)


def _check_equal_attribute(
    owner: Any,
    path: Path,
    label: str,
    name: str,
    expected: str | int | float,
) -> Any:
    actual = _required_attribute(owner, path, label, name)
    if actual != expected:
        _fail(path, f"{label}:{name} is {actual!r}; expected {expected!r}")
    return actual


def _check_numeric_attribute(
    variable: Any,
    path: Path,
    name: str,
    expected: int | float,
) -> None:
    actual = _required_attribute(variable, path, variable.name, name)
    if not np.isclose(float(actual), expected, rtol=0.0, atol=1e-8):
        _fail(path, f"{variable.name}:{name} is {actual!r}; expected {expected!r}")


def _check_raw_variable(
    variable: Any,
    path: Path,
    *,
    dimensions: tuple[str, ...],
    dtype_kind: str,
    itemsize: int,
    fill: int | float,
    valid_min: int | float,
    valid_max: int | float,
    units: str,
    scale: int | float | None = None,
    offset: int | float | None = None,
) -> None:
    if variable.dimensions != dimensions:
        _fail(path, f"{variable.name} dimensions {variable.dimensions!r} do not match {dimensions!r}")
    if variable.dtype.kind != dtype_kind or variable.dtype.itemsize != itemsize:
        _fail(path, f"{variable.name} storage type {variable.dtype} is unsupported")
    _check_numeric_attribute(variable, path, "_FillValue", fill)
    _check_numeric_attribute(variable, path, "valid_min", valid_min)
    _check_numeric_attribute(variable, path, "valid_max", valid_max)
    _check_equal_attribute(variable, path, variable.name, "units", units)
    if scale is None:
        if "scale_factor" in variable.ncattrs() or "add_offset" in variable.ncattrs():
            _fail(path, f"{variable.name} unexpectedly declares packed scale metadata")
    else:
        _check_numeric_attribute(variable, path, "scale_factor", scale)
        _check_numeric_attribute(variable, path, "add_offset", offset if offset is not None else 0.0)


def _text_attribute(variable: Any, path: Path, name: str) -> str:
    value = _required_attribute(variable, path, variable.name, name)
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError as error:
            _fail(path, f"{variable.name}:{name} is not UTF-8: {error}")
    if not isinstance(value, str):
        _fail(path, f"{variable.name}:{name} must be text")
    return value


def _descriptions(variable: Any, path: Path, keys: tuple[str, ...]) -> dict[str, str]:
    descriptions: dict[str, str] = {}
    for key in keys:
        value = _text_attribute(variable, path, key)
        if not value.strip():
            _fail(path, f"{variable.name}:{key} is empty")
        descriptions[key] = value
    return descriptions


def _coverage_time(value: Any, path: Path, name: str) -> datetime:
    if not isinstance(value, str):
        _fail(path, f"{name} must be an ISO timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        _fail(path, f"invalid {name}: {error}")
    if parsed.tzinfo is None or parsed.utcoffset() != timezone.utc.utcoffset(parsed):
        _fail(path, f"{name} must be UTC")
    return parsed.astimezone(timezone.utc)


def _filename_start(path: Path) -> datetime:
    match = FILENAME.fullmatch(path.name)
    if match is None:
        _fail(path, "filename is not a Collection 1.1 CLDPROP SNPP granule")
    year, day, hour, minute = (int(match.group(name)) for name in ("year", "day", "hour", "minute"))
    try:
        start = datetime(year, 1, 1, hour, minute, tzinfo=timezone.utc) + timedelta(days=day - 1)
    except (ValueError, OverflowError) as error:
        _fail(path, f"invalid acquisition time in filename: {error}")
    if start.timetuple().tm_yday != day or hour > 23 or minute > 59:
        _fail(path, "invalid acquisition time in filename")
    return start


def _read_raw(variable: Any, path: Path) -> np.ndarray:
    variable.set_auto_maskandscale(False)
    values = variable[...]
    if np.ma.isMaskedArray(values) and np.any(np.ma.getmaskarray(values)):
        _fail(path, f"{variable.name} returned masked values with automatic masking disabled")
    return np.asarray(values)


def read_cod_inputs(path: str | Path) -> ViirsCodInputs:
    """仕様が一致した granule から COD decoder の packed 入力を読む。"""
    source = Path(path)
    if source.is_symlink() or not source.is_file():
        _fail(source, "input must be a regular file, not a symlink")
    acquisition_start = _filename_start(source)
    try:
        dataset = netCDF4.Dataset(source, "r")
    except OSError as error:
        _fail(source, f"cannot open NetCDF: {error}")
    with dataset:
        for name, expected in (
            ("processing_level", "L2"),
            ("processing_version", "v1.1"),
            ("cdm_data_type", "swath"),
            ("instrument", "VIIRS"),
            ("platform", "Suomi-NPP"),
            ("ShortName", "CLDPROP_L2_VIIRS_SNPP"),
            ("product_version", "1.1"),
        ):
            _check_equal_attribute(dataset, source, "global", name, expected)
        product_name = _check_equal_attribute(dataset, source, "global", "product_name", source.name)
        _check_equal_attribute(dataset, source, "global", "LocalGranuleID", product_name)
        _check_equal_attribute(dataset, source, "global", "DayNightFlag", "Day")
        start = _coverage_time(
            _required_attribute(dataset, source, "global", "time_coverage_start"),
            source,
            "time_coverage_start",
        )
        end = _coverage_time(
            _required_attribute(dataset, source, "global", "time_coverage_end"),
            source,
            "time_coverage_end",
        )
        if start.strftime("%Y%j%H%M") != acquisition_start.strftime("%Y%j%H%M") or end <= start:
            _fail(source, "global time coverage disagrees with granule filename or is empty")
        if (end - start).total_seconds() > 7 * 60:
            _fail(source, "granule time coverage exceeds the six-minute product interval")

        for name, size in (
            ("number_of_lines", None),
            ("number_of_pixels", None),
            ("number_of_quality_assurance_bytes", 4),
            ("number_of_cloud_mask_bytes", 2),
        ):
            if name not in dataset.dimensions:
                _fail(source, f"missing dimension {name}")
            dimension = dataset.dimensions[name]
            if len(dimension) <= 0 or (size is not None and len(dimension) != size):
                _fail(source, f"dimension {name} has unexpected length {len(dimension)}")

        for group_name in ("geophysical_data", "geolocation_data"):
            if group_name not in dataset.groups:
                _fail(source, f"missing group {group_name}")
        geo = dataset.groups["geolocation_data"]
        science = dataset.groups["geophysical_data"]
        field = science.variables.get("Cloud_Optical_Thickness")
        qa = science.variables.get("Quality_Assurance")
        mask = science.variables.get("Cloud_Mask")
        latitude = geo.variables.get("latitude")
        longitude = geo.variables.get("longitude")
        solar = geo.variables.get("solar_zenith")
        if any(item is None for item in (field, qa, mask, latitude, longitude, solar)):
            _fail(source, "required COD, QA, cloud mask, or geolocation variable is missing")

        image_dimensions = ("number_of_lines", "number_of_pixels")
        _check_raw_variable(
            field, source, dimensions=image_dimensions, dtype_kind="i", itemsize=2,
            fill=-9999, valid_min=0, valid_max=15000, units="none", scale=0.01, offset=0.0,
        )
        _check_raw_variable(
            qa, source, dimensions=image_dimensions + ("number_of_quality_assurance_bytes",),
            dtype_kind="i", itemsize=1, fill=0, valid_min=1, valid_max=255, units="none",
        )
        _check_raw_variable(
            mask, source, dimensions=image_dimensions + ("number_of_cloud_mask_bytes",),
            dtype_kind="i", itemsize=1, fill=0, valid_min=1, valid_max=255, units="none",
        )
        _check_raw_variable(
            solar, source, dimensions=image_dimensions, dtype_kind="i", itemsize=2,
            fill=-32768, valid_min=0, valid_max=18000, units="degrees", scale=0.01, offset=0.0,
        )
        for coordinate, minimum, maximum, units in (
            (latitude, -90, 90, "degrees"),
            (longitude, -180, 180, "degrees"),
        ):
            _check_raw_variable(
                coordinate, source, dimensions=image_dimensions, dtype_kind="f", itemsize=4,
                fill=-999, valid_min=minimum, valid_max=maximum, units=units,
            )
        if field.shape != qa.shape[:2] or field.shape != mask.shape[:2]:
            _fail(source, "COD, QA, and cloud mask image shapes disagree")
        if any(variable.shape != field.shape for variable in (solar, latitude, longitude)):
            _fail(source, "geolocation and science image shapes disagree")
        qa_descriptions = _descriptions(qa, source, QA_DESCRIPTION_KEYS)
        mask_descriptions = _descriptions(mask, source, CLOUD_MASK_DESCRIPTION_KEYS)
        return ViirsCodInputs(
            best_point_cod_raw=_read_raw(field, source),
            quality_assurance=_read_raw(qa, source),
            cloud_mask=_read_raw(mask, source),
            solar_zenith_raw=_read_raw(solar, source),
            latitude=_read_raw(latitude, source),
            longitude=_read_raw(longitude, source),
            processing_version="v1.1",
            qa_descriptions=qa_descriptions,
            cloud_mask_descriptions=mask_descriptions,
            granule_name=source.name,
            time_coverage_start=start,
            time_coverage_end=end,
        )
