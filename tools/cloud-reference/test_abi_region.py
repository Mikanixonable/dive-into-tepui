"""abi-region.py の投影・小領域抽出を検査する。"""

from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest

import numpy as np


MODULE_PATH = Path(__file__).with_name("abi-region.py")
SPEC = importlib.util.spec_from_file_location("abi_region", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
REGION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REGION)


class AbiRegionGeometryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.projection = {
            "height": 35_786_023.0,
            "a": 6_378_137.0,
            "b": 6_356_752.31414,
            "lon0": np.deg2rad(-137.0),
        }

    def test_subsatellite_point_round_trips(self) -> None:
        x, y, visible = REGION.geodetic_to_grid(np.array([0.0]), np.array([self.projection["lon0"]]), self.projection)
        self.assertTrue(bool(visible[0]))
        np.testing.assert_allclose(x, [0], atol=1e-12)
        np.testing.assert_allclose(y, [0], atol=1e-12)
        latitude, longitude, ray_visible = REGION.grid_to_geodetic(x, y, self.projection)
        self.assertTrue(bool(ray_visible[0]))
        np.testing.assert_allclose(latitude, [0], atol=1e-12)
        np.testing.assert_allclose(longitude, [self.projection["lon0"]], atol=1e-12)

    def test_off_nadir_geographic_points_round_trip(self) -> None:
        latitude = np.deg2rad(np.array([20.0, 20.0, 45.0, 45.0]))
        longitude = np.deg2rad(np.array([-130.0, -110.0, -130.0, -110.0]))
        x, y, visible = REGION.geodetic_to_grid(latitude, longitude, self.projection)
        self.assertTrue(np.all(visible))
        result_latitude, result_longitude, ray_visible = REGION.grid_to_geodetic(x, y, self.projection)
        self.assertTrue(np.all(ray_visible))
        np.testing.assert_allclose(result_latitude, latitude, atol=1e-10)
        np.testing.assert_allclose(result_longitude, longitude, atol=1e-10)

    def test_region_bounds_enclose_projected_edges(self) -> None:
        region = {"westLonDeg": -137, "eastLonDeg": -117, "southLatDeg": 24, "northLatDeg": 40}
        bounds = REGION.region_grid_bounds(region, self.projection)
        west, east = np.deg2rad([-137, -117])
        south, north = np.deg2rad([24, 40])
        points = np.linspace(0, 1, 65)
        latitude = np.concatenate((np.full_like(points, south), np.full_like(points, north), south + points * (north - south), south + points * (north - south)))
        longitude = np.concatenate((west + points * (east - west), west + points * (east - west), np.full_like(points, west), np.full_like(points, east)))
        x, y, visible = REGION.geodetic_to_grid(latitude, longitude, self.projection)
        self.assertTrue(np.all(visible))
        self.assertLessEqual(bounds[0], float(x.min()))
        self.assertGreaterEqual(bounds[1], float(x.max()))
        self.assertLessEqual(bounds[2], float(y.min()))
        self.assertGreaterEqual(bounds[3], float(y.max()))

    def test_product_good_quality_does_not_reject_nighttime(self) -> None:
        cod_flags = np.array([0, 1, 2, 3, 16, 17, 18])
        np.testing.assert_array_equal(REGION.good_dqf(cod_flags, "L2_COD"), [True, True, False, False, False, False, False])
        np.testing.assert_array_equal(REGION.good_dqf(np.array([0, 1, 2]), "L1B_RAD"), [True, False, False])

    def test_acm_values_outside_declared_categories_are_not_good_field(self) -> None:
        class Variable:
            name = "ACM"
            _FillValue = 255

            @staticmethod
            def set_auto_maskandscale(enabled: bool) -> None:
                if enabled:
                    raise AssertionError("raw-value test must keep auto scaling disabled")

            @staticmethod
            def ncattrs() -> list[str]:
                return ["_FillValue", "flag_values"]

            @staticmethod
            def getncattr(name: str) -> np.ndarray:
                if name != "flag_values":
                    raise AssertionError(name)
                return np.array([0, 1, 2, 3], dtype=np.uint8)

        valid, out_of_range = REGION.raw_valid(np.array([0, 3, 4, 255], dtype=np.uint8), Variable())
        np.testing.assert_array_equal(valid, [True, True, False, False])
        np.testing.assert_array_equal(out_of_range, [False, False, True, False])

    def test_unsigned_packed_fill_and_range_values_keep_their_bits(self) -> None:
        class Variable:
            name = "Rad"
            _FillValue = np.int16(-1)

            @staticmethod
            def ncattrs() -> list[str]:
                return ["_Unsigned", "_FillValue", "valid_range"]

            @staticmethod
            def getncattr(name: str) -> object:
                if name == "_Unsigned":
                    return "true"
                if name == "valid_range":
                    return np.array([0, -5536], dtype=np.int16)
                raise AssertionError(name)

            @staticmethod
            def set_auto_maskandscale(enabled: bool) -> None:
                if enabled:
                    raise AssertionError("raw-value test must keep auto scaling disabled")

        packed = np.array([-15536, -2, -1], dtype=np.int16)
        decoded = REGION.unsigned_array(packed, Variable())
        np.testing.assert_array_equal(decoded, [50000, 65534, 65535])
        valid, out_of_range = REGION.raw_valid(decoded, Variable())
        np.testing.assert_array_equal(valid, [True, False, False])
        np.testing.assert_array_equal(out_of_range, [False, True, False])

    def test_non_monotonic_coordinate_axis_is_rejected(self) -> None:
        class Coordinate:
            def __init__(self, values: np.ndarray, scale: float) -> None:
                self.values = values
                self.scale_factor = scale
                self.add_offset = 0.0
                self.units = "rad"

            def set_auto_maskandscale(self, enabled: bool) -> None:
                if enabled:
                    raise AssertionError("raw coordinate test must disable automatic scaling")

            def __getitem__(self, selection: object) -> np.ndarray:
                return self.values[selection]

        class Projection:
            grid_mapping_name = "geostationary"
            sweep_angle_axis = "x"
            perspective_point_height = 35_786_023.0
            semi_major_axis = 6_378_137.0
            semi_minor_axis = 6_356_752.31414
            longitude_of_projection_origin = -137.0

        class Dataset:
            variables = {
                "x": Coordinate(np.array([0.0, 1.0, 0.5]), 1.0),
                "y": Coordinate(np.array([0.0, 1.0]), 1.0),
                "goes_imager_projection": Projection(),
            }

        with self.assertRaises(REGION.RegionError):
            REGION.grid_parameters(Dataset())

    def test_cod_acm_alignment_requires_verified_two_by_two_fixed_grid(self) -> None:
        projection = {"height": 35_786_023.0, "a": 6_378_137.0, "b": 6_356_752.31414, "lon0": -2.39}
        REGION.validate_cod_acm_grid_alignment(
            np.array([-1.0, 0.0]), np.array([0.5, -0.5]), projection,
            np.array([-1.25, -0.75, -0.25, 0.25]),
            np.array([0.75, 0.25, -0.25, -0.75]), projection,
        )
        with self.assertRaises(REGION.RegionError):
            REGION.validate_cod_acm_grid_alignment(
                np.array([-1.0, 0.0]), np.array([0.5, -0.5]), projection,
                np.array([-1.25, -0.75, -0.24, 0.26]),
                np.array([0.75, 0.25, -0.25, -0.75]), projection,
            )
        with self.assertRaises(REGION.RegionError):
            REGION.validate_cod_acm_grid_alignment(
                np.array([-1.0, 0.0]), np.array([0.5, -0.5]), projection,
                np.array([-1.25, -0.75, -0.25, 0.25]),
                np.array([0.75, 0.25, -0.25, -0.75]),
                {**projection, "lon0": -2.3},
            )

    def test_cod_cloud_coverage_excludes_clear_acm_and_retains_raw6_and_raw14_clouds(self) -> None:
        acm_field = np.array([[2, 3, 2, 3, 2, 3, 0, 1], [3, 2, 3, 2, 3, 2, 1, 0]], dtype=np.uint8)
        acm_field_valid = np.ones((2, 8), dtype=bool)
        acm_dqf = np.zeros((2, 8), dtype=np.uint8)
        acm_dqf_valid = np.ones((2, 8), dtype=bool)
        acm_inside = np.ones((2, 8), dtype=bool)
        result = REGION.summarize_cod_cloud_eligible_coverage(
            np.array([[True, True, True, True]]),
            np.array([[0, 6, 14, 0]], dtype=np.uint8),
            np.ones((1, 4), dtype=bool),
            acm_field, acm_field_valid, acm_dqf, acm_dqf_valid, acm_inside,
            np.tile(np.array([1.0, 2.0, 3.0, 4.0, 1.0, 2.0, 1.0, 1.0]), (2, 1)),
        )
        self.assertEqual(result["eligibleCloudPixelCount"], 12)
        self.assertEqual(result["goodCodCloudPixelCount"], 4)
        self.assertAlmostEqual(result["coverageFraction"], 1 / 3)
        self.assertEqual(result["eligibleCloudAreaM2"], 26.0)
        self.assertEqual(result["goodCodCloudAreaM2"], 6.0)
        self.assertAlmostEqual(result["areaWeightedCoverageFraction"], 6 / 26)
        self.assertEqual(
            result["indicatorAvailability"]["status"],
            "blocked_insufficient_support",
        )
        self.assertEqual(result["indicatorAvailability"]["finalMetricStatus"], "blocked")
        self.assertEqual(result["codDqfRawCountsOnEligibleCloudPixels"], {"0": 4, "6": 4, "14": 4})
        self.assertIn("raw 6 and raw 14 remain in the cloud denominator", result["limitations"])

        acm_field_valid[0, 0] = False
        acm_dqf_valid[0, 1] = False
        masked = REGION.summarize_cod_cloud_eligible_coverage(
            np.array([[True, True, True, True]]),
            np.array([[0, 6, 14, 0]], dtype=np.uint8),
            np.ones((1, 4), dtype=bool),
            acm_field, acm_field_valid, acm_dqf, acm_dqf_valid, acm_inside,
            np.ones((2, 8)),
        )
        self.assertEqual(masked["eligibleCloudPixelCount"], 10)
        self.assertEqual(masked["goodCodCloudPixelCount"], 2)

    def test_fixed_grid_pixel_areas_grow_towards_scan_edge(self) -> None:
        x = np.linspace(-0.12, -0.10, 5)
        y = np.linspace(0.03, 0.01, 5)
        areas = REGION.grid_pixel_area_weights(x, y, self.projection, 0, 4, 0, 4)
        self.assertTrue(np.all(np.isfinite(areas)))
        self.assertTrue(np.all(areas > 0))
        self.assertGreater(float(areas[0, 0]), float(areas[0, -1]))

    def test_nadir_pixel_area_matches_small_angle_metric(self) -> None:
        step = 1e-5
        axis = np.array([-step, 0.0, step])
        area = REGION.grid_pixel_area_weights(axis, axis, self.projection, 1, 2, 1, 2)[0, 0]
        # At nadir, ground distance per small scan-angle increment tends to satellite altitude * dθ.
        expected = (self.projection["height"] * step) ** 2
        self.assertLess(abs(float(area) / expected - 1), 1e-5)


class AbiRegionSeriesTest(unittest.TestCase):
    def test_series_slots_include_start_and_end_at_declared_interval(self) -> None:
        case = {
            "id": "synthetic",
            "series": {
                "start": "2024-08-19T18:00:00Z",
                "end": "2024-08-19T18:20:00Z",
                "intervalMinutes": 10,
            },
        }
        slots = REGION.series_slots(case)
        self.assertEqual(len(slots), 3)
        self.assertEqual([slot.minute for slot in slots], [0, 10, 20])
        self.assertTrue(all(slot.utcoffset().total_seconds() == 0 for slot in slots))

    def test_series_slots_reject_non_aligned_end(self) -> None:
        case = {
            "id": "synthetic",
            "series": {
                "start": "2024-08-19T18:00:00Z",
                "end": "2024-08-19T18:21:00Z",
                "intervalMinutes": 10,
            },
        }
        with self.assertRaises(REGION.RegionError):
            REGION.series_slots(case)

    def test_series_slots_reject_non_integer_or_non_positive_intervals(self) -> None:
        for interval in (10.5, float("nan"), float("inf"), 0, -10, True, "10"):
            with self.subTest(interval=interval):
                case = {
                    "id": "synthetic",
                    "series": {
                        "start": "2024-08-19T18:00:00Z",
                        "end": "2024-08-19T18:20:00Z",
                        "intervalMinutes": interval,
                    },
                }
                with self.assertRaises(REGION.RegionError):
                    REGION.series_slots(case)

    def test_series_slots_require_explicit_utc_and_reject_reversed_bounds(self) -> None:
        valid = {
            "id": "synthetic",
            "series": {
                "start": "2024-08-19T18:00:00Z",
                "end": "2024-08-19T18:00:00Z",
                "intervalMinutes": 10,
            },
        }
        self.assertEqual(len(REGION.series_slots(valid)), 1)

        invalid_series = (
            {"start": "2024-08-19T18:00:00", "end": "2024-08-19T18:10:00Z"},
            {"start": "2024-08-19T19:00:00+01:00", "end": "2024-08-19T18:10:00Z"},
            {"start": "2024-08-19T18:10:00Z", "end": "2024-08-19T18:00:00Z"},
        )
        for times in invalid_series:
            with self.subTest(times=times):
                case = {
                    "id": "synthetic",
                    "series": {**times, "intervalMinutes": 10},
                }
                with self.assertRaises(REGION.RegionError):
                    REGION.series_slots(case)

    def test_product_aggregate_uses_pixel_weighted_joint_quality_counts(self) -> None:
        def summary(slot: str, region_pixels: int, joint_good: int) -> dict[str, object]:
            return {
                "slotStart": slot,
                "sourceFile": f"{slot}.nc",
                "product": "L2_ACM",
                "field": "ACM",
                "bandId": None,
                "regionGridPixelCount": region_pixels,
                "fieldFillCount": 1,
                "fieldOutOfRangeCount": 1,
                "fieldValidCount": region_pixels - 2,
                "dqfFillCount": 0,
                "dqfOutOfRangeCount": 0,
                "dqfGoodCount": region_pixels,
                "jointGoodFieldAndDqfCount": joint_good,
                "pixelCoverageFraction": joint_good / region_pixels,
                "dqfRawCounts": {"0": region_pixels},
                "rawFieldCounts": {"0": region_pixels - 2, "128": 1},
            }

        result = REGION.aggregate_product_slots(
            "L2_ACM", "ACM", None,
            [summary("2024-08-19T18:00:00Z", 100, 80), summary("2024-08-19T18:10:00Z", 10, 5)],
        )
        self.assertEqual(result["slotCount"], 2)
        self.assertEqual(result["regionGridPixelCount"], 110)
        self.assertEqual(result["jointGoodFieldAndDqfCount"], 85)
        self.assertAlmostEqual(result["pixelCoverageFraction"], 85 / 110)
        self.assertEqual(result["rawFieldCounts"]["128"], 2)
        self.assertEqual(len(result["slots"]), 2)

    def test_product_aggregate_keeps_cod_cloud_eligible_diagnostic_separate(self) -> None:
        def summary(slot: str, eligible: int, covered: int, raw_dqf: dict[str, int]) -> dict[str, object]:
            return {
                "slotStart": slot, "sourceFile": f"{slot}.nc", "product": "L2_COD", "field": "COD", "bandId": None,
                "regionGridPixelCount": 100, "fieldFillCount": 0, "fieldOutOfRangeCount": 0,
                "fieldValidCount": 100, "dqfFillCount": 0, "dqfOutOfRangeCount": 0,
                "dqfGoodCount": 10, "jointGoodFieldAndDqfCount": 10, "pixelCoverageFraction": 0.1,
                "dqfRawCounts": {"0": 10}, "cloudEligibleCoverageDiagnostic": {
                    "eligibleCloudPixelCount": eligible, "goodCodCloudPixelCount": covered,
                    "coverageFraction": covered / eligible, "codDqfRawCountsOnEligibleCloudPixels": raw_dqf,
                    "eligibleCloudAreaM2": eligible * 2.0, "goodCodCloudAreaM2": covered * 3.0,
                    "areaWeightedCoverageFraction": covered * 1.5 / eligible,
                    "denominatorDefinition": "ACM cloud pixels", "numeratorDefinition": "good COD over ACM clouds",
                    "areaDenominatorDefinition": "weighted eligible ACM cloud pixels",
                    "areaNumeratorDefinition": "weighted good COD over ACM clouds",
                    "aggregation": "2x2 fixed-grid count", "limitations": "diagnostic only",
                },
            }

        result = REGION.aggregate_product_slots("L2_COD", "COD", None, [
            summary("2024-05-15T18:00:00Z", 100, 25, {"0": 25, "14": 75}),
            summary("2024-05-15T18:10:00Z", 200, 50, {"0": 50, "6": 20, "14": 130}),
        ])
        diagnostic = result["cloudEligibleCoverageDiagnostic"]
        self.assertEqual(diagnostic["slotCount"], 2)
        self.assertEqual(diagnostic["eligibleCloudPixelCount"], 300)
        self.assertEqual(diagnostic["goodCodCloudPixelCount"], 75)
        self.assertEqual(diagnostic["coverageFraction"], 0.25)
        self.assertEqual(diagnostic["eligibleCloudAreaM2"], 600.0)
        self.assertEqual(diagnostic["goodCodCloudAreaM2"], 225.0)
        self.assertEqual(diagnostic["areaWeightedCoverageFraction"], 0.375)
        self.assertEqual(
            diagnostic["indicatorAvailability"]["status"],
            "blocked_insufficient_support",
        )
        self.assertEqual(diagnostic["codDqfRawCountsOnEligibleCloudPixels"], {"0": 75, "6": 20, "14": 205})
        self.assertIn("cloudEligibleCoverageDiagnostic", result["slots"][0])

    def test_cod_support_threshold_is_provisional_and_never_passes_final_metric(self) -> None:
        exact_threshold = REGION.cod_indicator_availability(0.5)
        self.assertEqual(exact_threshold["status"], "provisional_support_sufficient")
        self.assertEqual(exact_threshold["minimumValidSupportFraction"], 0.5)
        self.assertEqual(exact_threshold["finalMetricStatus"], "blocked")
        self.assertIn("solar_angle_mask_not_applied", exact_threshold["finalMetricBlockers"])

        missing = REGION.cod_indicator_availability(None)
        self.assertEqual(missing["status"], "blocked_insufficient_support")
        self.assertIsNone(missing["diagnosticSupportFraction"])


if __name__ == "__main__":
    unittest.main()
