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
            np.ones((2, 8), dtype=bool),
        )
        self.assertEqual(result["eligibleCloudPixelCount"], 12)
        self.assertEqual(result["goodCodCloudPixelCount"], 4)
        self.assertAlmostEqual(result["coverageFraction"], 1 / 3)
        self.assertEqual(result["eligibleCloudAreaM2"], 26.0)
        self.assertEqual(result["goodCodCloudAreaM2"], 6.0)
        self.assertAlmostEqual(result["areaWeightedCoverageFraction"], 6 / 26)
        self.assertEqual(
            result["indicatorAvailability"]["status"],
            "provisional_area_threshold_not_met",
        )
        self.assertEqual(result["indicatorAvailability"]["finalMetricStatus"], "blocked")
        self.assertEqual(result["indicatorAvailability"]["scope"], "single_slot")
        self.assertEqual(result["indicatorAvailability"]["validFrameCountStatus"], "not_assessed")
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
            np.ones((2, 8), dtype=bool),
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

    def test_acm_bbox_overlap_area_is_full_half_or_zero_from_projected_corners(self) -> None:
        step = 1e-5
        axis = np.array([-step / 2, step / 2])
        area = REGION.grid_pixel_area_weights(axis, axis, self.projection, 0, 1, 0, 1)
        west_half = REGION.grid_to_geodetic(np.array([-step]), np.array([-step]), self.projection)
        east_half = REGION.grid_to_geodetic(np.array([0.0]), np.array([-step]), self.projection)
        west_lon, east_lon = float(west_half[1][0]), float(east_half[1][0])
        south = float(REGION.grid_to_geodetic(np.array([-step]), np.array([-step]), self.projection)[0][0]) - 1e-5
        north = float(REGION.grid_to_geodetic(np.array([-step]), np.array([0.0]), self.projection)[0][0]) + 1e-5

        def overlap(west: float, east: float) -> float:
            return REGION.acm_bbox_overlap_area_weights(
                axis, axis, self.projection,
                {"westLonDeg": np.rad2deg(west), "eastLonDeg": np.rad2deg(east),
                 "southLatDeg": np.rad2deg(south), "northLatDeg": np.rad2deg(north)},
                0, 1, 0, 1, area,
            )[0, 0]

        full = overlap(west_lon - 1e-5, east_lon + 1e-5)
        half = overlap((west_lon + east_lon) / 2, east_lon + 1e-5)
        outside = overlap(east_lon + 1e-5, east_lon + 2e-5)
        self.assertAlmostEqual(full / area[0, 0], 1.0, places=5)
        self.assertAlmostEqual(half / area[0, 0], 0.5, places=3)
        self.assertEqual(outside, 0.0)

    def test_acm_bbox_overlap_rejects_antimeridian_spanning_regions(self) -> None:
        axis = np.array([-1e-5, 1e-5])
        area = np.ones((1, 1))
        region = {"westLonDeg": 170, "eastLonDeg": -170, "southLatDeg": -1, "northLatDeg": 1}
        with self.assertRaisesRegex(REGION.RegionError, "antimeridian"):
            REGION.acm_bbox_overlap_area_weights(
                axis, axis, self.projection, region, 0, 1, 0, 1, area,
            )

    def test_bbox_overlap_diagnostic_does_not_change_center_based_cod_values(self) -> None:
        acm_shape = (2, 4)
        common = (
            np.ones((1, 2), dtype=bool), np.array([[0, 14]], dtype=np.uint8),
            np.ones((1, 2), dtype=bool), np.full(acm_shape, 2, dtype=np.uint8),
            np.ones(acm_shape, dtype=bool), np.zeros(acm_shape, dtype=np.uint8),
            np.ones(acm_shape, dtype=bool), np.ones(acm_shape, dtype=bool),
            np.ones(acm_shape), np.ones(acm_shape, dtype=bool),
        )
        baseline = REGION.summarize_cod_cloud_eligible_coverage(*common)
        overlap = np.zeros(acm_shape)
        overlap[0, 0] = 0.25  # overlap can exist even when this centre is outside
        diagnostic = REGION.summarize_cod_cloud_eligible_coverage(*common, overlap)
        for key in ("eligibleCloudPixelCount", "goodCodCloudPixelCount", "eligibleCloudAreaM2", "goodCodCloudAreaM2", "areaWeightedCoverageFraction"):
            self.assertEqual(diagnostic[key], baseline[key])
        self.assertEqual(diagnostic["bboxOverlapEligibleCloudAreaM2"], 0.25)
        self.assertEqual(diagnostic["bboxOverlapGoodCodCloudAreaM2"], 0.25)
        self.assertEqual(diagnostic["indicatorAvailability"]["finalMetricStatus"], "blocked")

    def test_solar_mask_uses_canonical_angle_at_pixel_centre_and_utc_time(self) -> None:
        evaluator = REGION.AbiSolarAngleEvaluator()
        try:
            centre = np.array([0.0])
            local_noon = evaluator.daylight_mask(
                centre, centre, self.projection, "2024-03-20T21:08:00Z",
            )
            local_night = evaluator.daylight_mask(
                centre, centre, self.projection, "2024-03-20T09:08:00Z",
            )
            beyond_zenith_limit = evaluator.daylight_mask(
                centre, centre, self.projection, "2024-03-20T16:08:00Z",
            )
        finally:
            evaluator.close()
        self.assertTrue(bool(local_noon[0, 0]))
        self.assertFalse(bool(local_night[0, 0]))
        self.assertFalse(bool(beyond_zenith_limit[0, 0]))

    def test_acm_scan_time_uses_fractional_utc_product_attribute(self) -> None:
        class Dataset:
            @staticmethod
            def getncattr(name: str) -> str:
                if name != "time_coverage_start":
                    raise AssertionError(name)
                return "2024-05-28T15:00:20.600Z"

        self.assertEqual(
            REGION.acm_product_scan_time_utc(Dataset(), Path("ACM.nc")),
            "2024-05-28T15:00:20.600Z",
        )
        class OffsetDataset:
            @staticmethod
            def getncattr(name: str) -> str:
                return "2024-05-28T15:00:20.600+00:00"

        with self.assertRaises(REGION.RegionError):
            REGION.acm_product_scan_time_utc(OffsetDataset(), Path("ACM.nc"))

    def test_cod_cloud_coverage_reports_applied_solar_mask_separately(self) -> None:
        acm_field = np.full((2, 4), 2, dtype=np.uint8)
        area = np.ones((2, 4), dtype=np.float64)
        solar_valid = np.array([[True, True, False, False], [True, False, False, True]])
        result = REGION.summarize_cod_cloud_eligible_coverage(
            np.ones((1, 2), dtype=bool), np.array([[0, 14]], dtype=np.uint8),
            np.ones((1, 2), dtype=bool), acm_field, np.ones((2, 4), dtype=bool),
            np.zeros((2, 4), dtype=np.uint8), np.ones((2, 4), dtype=bool),
            np.ones((2, 4), dtype=bool), area, solar_valid,
        )
        self.assertEqual(result["eligibleCloudPixelCountBeforeSolarMask"], 8)
        self.assertEqual(result["eligibleCloudPixelCount"], 4)
        self.assertEqual(result["solarAngleExcludedEligibleCloudPixelCount"], 4)
        self.assertAlmostEqual(result["areaWeightedCoverageFraction"], 0.75)
        self.assertEqual(result["appliedMasks"]["solarZenith"]["maximumDegrees"], 70.0)
        self.assertEqual(result["unappliedCorrections"], ["cloud_top_parallax"])
        self.assertEqual(result["indicatorAvailability"]["finalMetricStatus"], "blocked")


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
                    "eligibleCloudPixelCountBeforeSolarMask": eligible,
                    "solarAngleExcludedEligibleCloudPixelCount": 0,
                    "coverageFraction": covered / eligible, "codDqfRawCountsOnEligibleCloudPixels": raw_dqf,
                    "eligibleCloudAreaM2": eligible * 2.0, "goodCodCloudAreaM2": covered * 3.0,
                    "eligibleCloudAreaM2BeforeSolarMask": eligible * 2.0,
                    "solarAngleExcludedEligibleCloudAreaM2": 0.0,
                    "areaWeightedCoverageFraction": covered * 1.5 / eligible,
                    "denominatorDefinition": "ACM cloud pixels", "numeratorDefinition": "good COD over ACM clouds",
                    "areaDenominatorDefinition": "weighted eligible ACM cloud pixels",
                    "areaNumeratorDefinition": "weighted good COD over ACM clouds",
                    "aggregation": "2x2 fixed-grid count", "limitations": "diagnostic only",
                    "appliedMasks": {"solarZenith": {
                        "maximumDegrees": 70.0, "implementation": "canonical",
                        "sampling": "ACM centres", "excludedEligibleCloudPixelCount": 0,
                        "excludedEligibleCloudAreaM2": 0.0,
                    }},
                    "unappliedCorrections": ["cloud_top_parallax"],
                },
            }

        summaries = [
            summary("2024-05-15T18:00:00Z", 100, 25, {"0": 25, "14": 75}),
            summary("2024-05-15T18:10:00Z", 200, 50, {"0": 50, "6": 20, "14": 130}),
        ]
        result = REGION.aggregate_product_slots("L2_COD", "COD", None, summaries)
        diagnostic = result["cloudEligibleCoverageDiagnostic"]
        self.assertEqual(diagnostic["slotCount"], 2)
        self.assertEqual(diagnostic["eligibleCloudPixelCount"], 300)
        self.assertEqual(diagnostic["goodCodCloudPixelCount"], 75)
        self.assertEqual(diagnostic["coverageFraction"], 0.25)
        self.assertEqual(diagnostic["eligibleCloudAreaM2"], 600.0)
        self.assertEqual(diagnostic["goodCodCloudAreaM2"], 225.0)
        self.assertEqual(diagnostic["areaWeightedCoverageFraction"], 0.375)
        self.assertEqual(diagnostic["frameSupportDiagnostic"], {
            "slotCount": 2, "solarEligibleFrameCount": 2, "goodCodFrameCount": 2,
            "provisionalAreaThreshold": 0.5, "provisionalAreaThresholdFrameCount": 0,
        })
        self.assertEqual(
            diagnostic["indicatorAvailability"]["status"],
            "provisional_area_threshold_not_met",
        )
        self.assertEqual(diagnostic["indicatorAvailability"]["scope"], "aggregated_series")
        self.assertEqual(diagnostic["codDqfRawCountsOnEligibleCloudPixels"], {"0": 75, "6": 20, "14": 205})
        self.assertIn("cloudEligibleCoverageDiagnostic", result["slots"][0])
        self.assertEqual(
            summaries[0]["cloudEligibleCoverageDiagnostic"]["appliedMasks"]["solarZenith"]["excludedEligibleCloudPixelCount"],
            0,
        )

    def test_cod_support_threshold_is_provisional_and_never_passes_final_metric(self) -> None:
        exact_threshold = REGION.cod_indicator_availability(0.5, "single_slot")
        self.assertEqual(exact_threshold["status"], "provisional_area_threshold_met")
        self.assertEqual(exact_threshold["minimumValidSupportFraction"], 0.5)
        self.assertEqual(exact_threshold["finalMetricStatus"], "blocked")
        self.assertEqual(exact_threshold["validFrameCountStatus"], "not_assessed")
        self.assertIn("valid_frame_count_not_assessed", exact_threshold["finalMetricBlockers"])
        self.assertEqual(exact_threshold["appliedMasks"], {})
        self.assertIn("solar_angle_mask_not_assessed", exact_threshold["finalMetricBlockers"])
        self.assertEqual(exact_threshold["unappliedCorrections"], ["cloud_top_parallax"])

        missing = REGION.cod_indicator_availability(None, "single_slot")
        self.assertEqual(missing["status"], "blocked_invalid_or_missing_support_fraction")
        self.assertIsNone(missing["diagnosticSupportFraction"])
        for invalid in (float("nan"), float("inf"), -0.01, 1.01):
            with self.subTest(invalid=invalid):
                result = REGION.cod_indicator_availability(invalid, "aggregated_series")
                self.assertEqual(result["status"], "blocked_invalid_or_missing_support_fraction")
                self.assertEqual(result["scope"], "aggregated_series")
                self.assertIsNone(result["diagnosticSupportFraction"])

    def test_cod_frame_support_distinguishes_solar_eligibility_and_good_cod(self) -> None:
        diagnostic = REGION.cod_frame_support_diagnostic([
            {"eligibleCloudAreaM2": 0.0, "goodCodCloudAreaM2": 0.0,
             "areaWeightedCoverageFraction": None},
            {"eligibleCloudAreaM2": 10.0, "goodCodCloudAreaM2": 0.0,
             "areaWeightedCoverageFraction": 0.0},
            {"eligibleCloudAreaM2": 10.0, "goodCodCloudAreaM2": 6.0,
             "areaWeightedCoverageFraction": 0.6},
        ])
        self.assertEqual(diagnostic["slotCount"], 3)
        self.assertEqual(diagnostic["solarEligibleFrameCount"], 2)
        self.assertEqual(diagnostic["goodCodFrameCount"], 1)
        self.assertEqual(diagnostic["provisionalAreaThresholdFrameCount"], 1)


if __name__ == "__main__":
    unittest.main()
