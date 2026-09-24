"""Synthetic bit-pattern tests for the provisional VIIRS CLDPROP decoder."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest

import numpy as np


MODULE_PATH = Path(__file__).with_name("viirs-cldprop.py")
SPEC = importlib.util.spec_from_file_location("viirs_cldprop", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
VIIRS = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = VIIRS
SPEC.loader.exec_module(VIIRS)


QA_DESCRIPTIONS = {
    "description20": "0 VNSWIR-2.1 Retrieval Spectral Data QA",
    "description22": "2,1 VNSWIR-2.1 Retrieval Confidence QA",
    "description24": "10 = Good",
    "description25": "11 = Very Good",
    "description26": "3 VNSWIR-2.1 Retrieval Outcome",
    "description27": "1 = Successful",
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

CLOUD_MASK_DESCRIPTIONS = {
    "description14": "Cloud Mask Flag",
    "description15": "1 = Determined",
    "description17": "2, 1 Unobstructed FOV Quality Flag 00 = Cloudy",
    "description18": "01 = Uncertain",
    "description20": "11 = Confident Clear",
    "description23": "3 Day or Night Path 0 = Night / 1 = Day",
    "description24": "4 Sunglint Path 0 = Yes / 1 = No",
    "description25": "5 Snow/Ice Background Path 0 = Yes / 1 = No",
    "description26": "7, 6 Land or Water Path 00 = Water",
}


class ViirsClDpropTest(unittest.TestCase):
    def setUp(self) -> None:
        self.cod = np.array([1234], dtype=np.int16)
        # Byte 0: all spectral data, Good confidence, successful retrieval.
        # Byte 1: water cloud, .645 um band used, no out-of-bounds/bow-tie bits.
        self.qa = np.array([[0b00001101, 0b00010010, 0, 0]], dtype=np.uint8)
        # Determined, confidently cloudy, day, no sunglint/snow, open water.
        self.cloud_mask = np.array([[0b00111001, 0]], dtype=np.uint8)
        self.solar_zenith = np.array([5000], dtype=np.int16)
        self.latitude = np.array([30.0])
        self.longitude = np.array([-130.0])

    def decode(self, **overrides: object) -> VIIRS.CodDecodeResult:
        values = {
            "best_point_cod_raw": self.cod,
            "quality_assurance": self.qa,
            "cloud_mask": self.cloud_mask,
            "solar_zenith_raw": self.solar_zenith,
            "latitude": self.latitude,
            "longitude": self.longitude,
            "processing_version": "v1.1",
            "qa_descriptions": QA_DESCRIPTIONS,
            "cloud_mask_descriptions": CLOUD_MASK_DESCRIPTIONS,
        }
        values.update(overrides)
        return VIIRS.decode_daytime_cod(**values)

    def test_decodes_array_and_scalar_primary_cod(self) -> None:
        result = self.decode()
        np.testing.assert_array_equal(result.valid, [True])
        np.testing.assert_allclose(result.cod, [12.34])
        self.assertEqual(result.reason_counts["cod_fill"], 0)

        scalar = VIIRS.decode_daytime_cod(
            1234,
            self.qa[0],
            self.cloud_mask[0],
            5000,
            30.0,
            -130.0,
            processing_version="1.1",
            qa_descriptions=QA_DESCRIPTIONS,
            cloud_mask_descriptions=CLOUD_MASK_DESCRIPTIONS,
        )
        self.assertTrue(bool(scalar.valid))
        self.assertAlmostEqual(float(scalar.cod), 12.34)

    def test_primary_field_is_best_point_cod_not_edge_pcl(self) -> None:
        self.assertEqual(VIIRS.PRIMARY_COD_FIELD, "Cloud_Optical_Thickness")
        self.assertNotIn("PCL", VIIRS.PRIMARY_COD_FIELD)

    def test_rejects_each_required_quality_bit_and_category(self) -> None:
        cases = [
            ("spectral_data_missing", "quality_assurance", 0, 0b00001100),
            ("retrieval_confidence_below_good", "quality_assurance", 0, 0b00001001),
            ("primary_retrieval_failed", "quality_assurance", 0, 0b00000101),
            ("not_water_cloud_path", "quality_assurance", 1, 0b00010011),
            ("optical_thickness_band_not_used", "quality_assurance", 1, 0b00000010),
            ("optical_thickness_out_of_bounds", "quality_assurance", 1, 0b01010010),
            ("bow_tie_pixel", "quality_assurance", 1, 0b10010010),
            ("clear_sky_restored", "quality_assurance", 2, 0b00000001),
            ("not_ice_free_ocean", "quality_assurance", 3, 0b00000001),
            ("cloud_mask_undetermined", "cloud_mask", 0, 0b00111000),
            ("not_confidently_cloudy", "cloud_mask", 0, 0b00111011),
            ("night", "cloud_mask", 0, 0b00110001),
            ("sunglint", "cloud_mask", 0, 0b00101001),
            ("snow_or_ice_background", "cloud_mask", 0, 0b00011001),
            ("cloud_mask_not_water", "cloud_mask", 0, 0b01111001),
        ]
        for reason, field, byte_index, changed_byte in cases:
            with self.subTest(reason=reason):
                qa = self.qa.copy()
                mask = self.cloud_mask.copy()
                if field == "quality_assurance":
                    qa[0, byte_index] = changed_byte
                else:
                    mask[0, byte_index] = changed_byte
                result = self.decode(quality_assurance=qa, cloud_mask=mask)
                self.assertFalse(bool(result.valid[0]))
                self.assertEqual(result.reason_counts[reason], 1)

    def test_rejects_fill_and_out_of_range_primary_cod(self) -> None:
        for raw_value, reason in ((-9999, "cod_fill"), (-1, "cod_out_of_range"), (15001, "cod_out_of_range")):
            with self.subTest(raw_value=raw_value):
                result = self.decode(best_point_cod_raw=np.array([raw_value], dtype=np.int16))
                self.assertFalse(bool(result.valid[0]))
                self.assertEqual(result.reason_counts[reason], 1)

    def test_rejects_solar_zenith_fill_night_and_out_of_range(self) -> None:
        for raw_value in (-32768, -1, 7001, 18001):
            with self.subTest(raw_value=raw_value):
                result = self.decode(solar_zenith_raw=np.array([raw_value], dtype=np.int16))
                self.assertFalse(bool(result.valid[0]))
                self.assertEqual(result.reason_counts["solar_zenith_invalid_or_over_70"], 1)
        boundary = self.decode(solar_zenith_raw=np.array([7000], dtype=np.int16))
        self.assertTrue(bool(boundary.valid[0]))

    def test_rejects_invalid_geolocation(self) -> None:
        cases = [
            ("latitude", np.array([-999.0])),
            ("latitude", np.array([np.nan])),
            ("latitude", np.array([90.01])),
            ("longitude", np.array([-999.0])),
            ("longitude", np.array([np.inf])),
            ("longitude", np.array([-180.01])),
        ]
        for field, values in cases:
            with self.subTest(field=field, value=values[0]):
                result = self.decode(**{field: values})
                self.assertFalse(bool(result.valid[0]))
                self.assertEqual(result.reason_counts["invalid_geolocation"], 1)

    def test_fails_closed_when_v11_layout_is_not_confirmed(self) -> None:
        with self.assertRaisesRegex(ValueError, "processing_version"):
            self.decode(processing_version="v1.0")
        changed = dict(QA_DESCRIPTIONS)
        changed["description39"] = "011 = Ice Cloud"
        with self.assertRaisesRegex(ValueError, "description39"):
            self.decode(qa_descriptions=changed)

    def test_fails_closed_on_masked_or_shape_mismatched_raw_inputs(self) -> None:
        with self.assertRaisesRegex(ValueError, "automatic masking disabled"):
            self.decode(best_point_cod_raw=np.ma.array([1234], mask=[True]))
        with self.assertRaisesRegex(ValueError, "plus 4 bytes"):
            self.decode(quality_assurance=np.array([[13, 18, 0]], dtype=np.uint8))
        with self.assertRaisesRegex(ValueError, "one-byte integers"):
            self.decode(quality_assurance=self.qa.astype(np.int16))


if __name__ == "__main__":
    unittest.main()
