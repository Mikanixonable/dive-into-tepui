"""実データ再格子化の数値境界を検証する。"""

import unittest

import numpy as np

from real_source import OutputGrid, regrid_era5


class RegridTests(unittest.TestCase):
    def test_constant_field_is_preserved_across_wrap_and_poles(self):
        source = np.full((3, 4), 273.15, dtype=np.float64)
        grid = OutputGrid(-180, -90, 180, 90, 8, 4)
        result = regrid_era5(source, [90, 0, -90], [0, 90, 180, 270], grid)
        self.assertEqual(len(result), 4)
        self.assertEqual(len(result[0]), 8)
        self.assertTrue(np.allclose(result, 273.15))

    def test_longitude_wrap_uses_the_periodic_source_cell(self):
        source = np.array([[10, 20, 30, 40], [10, 20, 30, 40], [10, 20, 30, 40]], dtype=np.float64)
        grid = OutputGrid(-180, -90, 180, 90, 8, 2)
        result = regrid_era5(source, [90, 0, -90], [0, 90, 180, 270], grid)
        self.assertAlmostEqual(result[0][0], 30.0)
        self.assertAlmostEqual(result[0][1], 40.0)
        self.assertAlmostEqual(result[0][-1], 30.0)


if __name__ == "__main__":
    unittest.main()
