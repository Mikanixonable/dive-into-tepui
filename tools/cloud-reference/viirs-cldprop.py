"""Provisional decoder for daytime SNPP VIIRS Collection 1 COD pixels.

The bit layout follows NASA's Collection 1 VIIRS file specification and its
CLDPROP user guide. NASA's current product page identifies v1.1 as the active
collection, but the public file-spec example is v1.0. Callers must pass the
actual granule's version and embedded QA descriptions through
``decode_daytime_cod``; processing stops unless they identify v1.1 and confirm
the expected bit meanings. Synthetic tests do not validate a real granule.

Inputs are unmasked raw packed COD, QA and cloud-mask values, packed solar
zenith in centidegrees, and geolocation in degrees. NetCDF readers must disable
automatic mask/scale for packed fields before calling this module. PCL edge
retrievals are intentionally not accepted as primary COD.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping

import numpy as np
from numpy.typing import ArrayLike, NDArray


COD_FILL = -9999
COD_MIN = 0
COD_MAX = 15000
COD_SCALE = 0.01
PRIMARY_COD_FIELD = "Cloud_Optical_Thickness"
SOLAR_ZENITH_FILL = -32768
SOLAR_ZENITH_MAX_RAW = 18000
SOLAR_ZENITH_DAY_MAX_RAW = 7000
LATITUDE_FILL = -999.0
LONGITUDE_FILL = -999.0


@dataclass(frozen=True)
class CodDecodeResult:
    """Primary COD values, validity mask, and overlapping rejection counts."""

    cod: NDArray[np.float64]
    valid: NDArray[np.bool_]
    reason_counts: Mapping[str, int]


_QA_DESCRIPTION_FRAGMENTS = {
    "description20": "VNSWIR-2.1 Retrieval Spectral Data QA",
    "description22": "VNSWIR-2.1 Retrieval Confidence QA",
    "description24": "10 = Good",
    "description25": "11 = Very Good",
    "description26": "VNSWIR-2.1 Retrieval Outcome",
    "description27": "Successful",
    "description37": "Primary retrieval processing path",
    "description39": "010 = Water Cloud",
    "description44": "Band Used for Optical Thickness Retrieval",
    "description45": "00 = No attempt",
    "description49": "Optical thickness out of bounds",
    "description50": "1 = yes",
    "description51": "VIIRS Bow-tie pixel indicator",
    "description54": "Clear Sky Restoral Type QA",
    "description55": "00 = Not Restored",
    "description72": "Earth surface type used in optical thickness retrieval",
    "description73": "00 = ice-free ocean",
}

_CLOUD_MASK_DESCRIPTION_FRAGMENTS = {
    "description14": "Cloud Mask Flag",
    "description15": "1 = Determined",
    "description17": ("Unobstructed FOV Quality Flag", "00 = Cloudy"),
    "description18": "01 = Uncertain",
    "description20": "11 = Confident Clear",
    "description23": ("Day or Night Path", "0 = Night", "1 = Day"),
    "description24": ("Sunglint Path", "0 = Yes", "1 = No"),
    "description25": ("Snow/Ice Background Path", "0 = Yes", "1 = No"),
    "description26": ("Land or Water Path", "00 = Water"),
}


def _description_text(value: object) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


def _check_descriptions(
    descriptions: Mapping[str, object],
    expected: Mapping[str, str | tuple[str, ...]],
    label: str,
) -> None:
    for name, fragment in expected.items():
        actual = descriptions.get(name)
        fragments = (fragment,) if isinstance(fragment, str) else fragment
        actual_text = "" if actual is None else _description_text(actual).casefold()
        if any(part.casefold() not in actual_text for part in fragments):
            raise ValueError(f"{label}:{name} does not confirm expected Collection 1 QA semantics")


def _confirm_v11_qa_layout(
    processing_version: str,
    qa_descriptions: Mapping[str, object],
    cloud_mask_descriptions: Mapping[str, object],
) -> None:
    """Fail closed unless actual embedded attributes confirm the v1.1 layout."""
    if processing_version.strip().casefold() not in {"v1.1", "1.1"}:
        raise ValueError("CLDPROP processing_version must identify v1.1")
    _check_descriptions(qa_descriptions, _QA_DESCRIPTION_FRAGMENTS, "Quality_Assurance")
    _check_descriptions(cloud_mask_descriptions, _CLOUD_MASK_DESCRIPTION_FRAGMENTS, "Cloud_Mask")


def _raw_array(values: ArrayLike, label: str) -> NDArray:
    if np.ma.isMaskedArray(values) and np.any(np.ma.getmaskarray(values)):
        raise ValueError(f"{label} must be read with NetCDF automatic masking disabled")
    return np.asarray(values)


def _same_shape(values: NDArray, expected: tuple[int, ...], label: str) -> None:
    if values.shape != expected:
        raise ValueError(f"{label} shape {values.shape} must match COD shape {expected}")


def _as_unsigned_byte(values: NDArray, label: str) -> NDArray[np.uint8]:
    if not np.issubdtype(values.dtype, np.integer) or values.dtype.itemsize != 1:
        raise ValueError(f"{label} must contain packed one-byte integers")
    return values.astype(np.uint8, copy=False)


def decode_daytime_cod(
    best_point_cod_raw: ArrayLike,
    quality_assurance: ArrayLike,
    cloud_mask: ArrayLike,
    solar_zenith_raw: ArrayLike,
    latitude: ArrayLike,
    longitude: ArrayLike,
    *,
    processing_version: str,
    qa_descriptions: Mapping[str, object],
    cloud_mask_descriptions: Mapping[str, object],
) -> CodDecodeResult:
    """Decode strict daytime, confident-cloud, ice-free-ocean primary COD.

    QA bytes and Cloud_Mask byte 0 use the bit numbers and values documented by
    NASA (bit 7 is most significant; bit 0 is least significant). Arrays must
    have matching pixel shapes, with trailing lengths four and two for QA and
    Cloud_Mask respectively. Scalars are accepted as zero-dimensional pixels.
    Rejection counts overlap when a pixel fails more than one criterion.
    """
    _confirm_v11_qa_layout(processing_version, qa_descriptions, cloud_mask_descriptions)

    cod_raw = _raw_array(best_point_cod_raw, PRIMARY_COD_FIELD)
    if not np.issubdtype(cod_raw.dtype, np.integer):
        raise ValueError(f"{PRIMARY_COD_FIELD} must contain raw packed integers")
    shape = cod_raw.shape
    qa_raw = _raw_array(quality_assurance, "Quality_Assurance")
    mask_raw = _raw_array(cloud_mask, "Cloud_Mask")
    solar_raw = _raw_array(solar_zenith_raw, "solar_zenith")
    latitude_values = _raw_array(latitude, "latitude")
    longitude_values = _raw_array(longitude, "longitude")
    if not np.issubdtype(solar_raw.dtype, np.integer):
        raise ValueError("solar_zenith must contain raw packed centidegrees")
    if not np.issubdtype(latitude_values.dtype, np.number) or np.issubdtype(latitude_values.dtype, np.complexfloating):
        raise ValueError("latitude must contain numeric degrees")
    if not np.issubdtype(longitude_values.dtype, np.number) or np.issubdtype(longitude_values.dtype, np.complexfloating):
        raise ValueError("longitude must contain numeric degrees")

    if qa_raw.shape != shape + (4,):
        raise ValueError(f"Quality_Assurance shape {qa_raw.shape} must be COD shape {shape} plus 4 bytes")
    if mask_raw.shape != shape + (2,):
        raise ValueError(f"Cloud_Mask shape {mask_raw.shape} must be COD shape {shape} plus 2 bytes")
    for values, label in (
        (solar_raw, "solar_zenith"),
        (latitude_values, "latitude"),
        (longitude_values, "longitude"),
    ):
        _same_shape(values, shape, label)

    qa = _as_unsigned_byte(qa_raw, "Quality_Assurance")
    mask = _as_unsigned_byte(mask_raw, "Cloud_Mask")
    qa0, qa1, qa2, qa3 = (qa[..., index] for index in range(4))
    mask0 = mask[..., 0]

    cod_in_range = (cod_raw >= COD_MIN) & (cod_raw <= COD_MAX)
    cod_not_fill = cod_raw != COD_FILL
    # QA byte 3 value 00 is the valid ice-free-ocean category, so it is not a fill test.
    quality_ok = (qa0 != 0) & (qa1 != 0)
    confidence = (qa0 >> 1) & 0b11
    band_used = (qa1 >> 4) & 0b11
    water_cloud_path = (qa1 & 0b111) == 0b010
    ocean_surface = (qa3 & 0b11) == 0b00
    cloud_confidence = (mask0 >> 1) & 0b11
    water_background = (mask0 >> 6) & 0b11

    reasons: dict[str, NDArray[np.bool_]] = {
        "cod_fill": ~cod_not_fill,
        "cod_out_of_range": ~cod_in_range,
        "qa_primary_bytes_zero": ~quality_ok,
        "spectral_data_missing": (qa0 & 0b1) == 0,
        "retrieval_confidence_below_good": confidence < 0b10,
        "primary_retrieval_failed": (qa0 & 0b1000) == 0,
        "not_water_cloud_path": ~water_cloud_path,
        "optical_thickness_band_not_used": band_used == 0,
        "optical_thickness_out_of_bounds": (qa1 & 0b01000000) != 0,
        "bow_tie_pixel": (qa1 & 0b10000000) != 0,
        "clear_sky_restored": (qa2 & 0b11) != 0,
        "not_ice_free_ocean": ~ocean_surface,
        "cloud_mask_undetermined": (mask0 & 0b1) == 0,
        "not_confidently_cloudy": cloud_confidence != 0,
        "night": (mask0 & 0b00001000) == 0,
        "sunglint": (mask0 & 0b00010000) == 0,
        "snow_or_ice_background": (mask0 & 0b00100000) == 0,
        "cloud_mask_not_water": water_background != 0,
        "solar_zenith_invalid_or_over_70": (
            (solar_raw == SOLAR_ZENITH_FILL)
            | (solar_raw < 0)
            | (solar_raw > SOLAR_ZENITH_MAX_RAW)
            | (solar_raw > SOLAR_ZENITH_DAY_MAX_RAW)
        ),
        "invalid_geolocation": (
            ~np.isfinite(latitude_values)
            | ~np.isfinite(longitude_values)
            | (latitude_values == LATITUDE_FILL)
            | (longitude_values == LONGITUDE_FILL)
            | (latitude_values < -90.0)
            | (latitude_values > 90.0)
            | (longitude_values < -180.0)
            | (longitude_values > 180.0)
        ),
    }
    valid = cod_not_fill & cod_in_range
    for rejected in reasons.values():
        valid &= ~rejected

    decoded_cod = np.where(valid, cod_raw.astype(np.float64) * COD_SCALE, np.nan)
    counts = {name: int(np.count_nonzero(rejected)) for name, rejected in reasons.items()}
    return CodDecodeResult(decoded_cod, valid, counts)
