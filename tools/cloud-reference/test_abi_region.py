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


if __name__ == "__main__":
    unittest.main()
