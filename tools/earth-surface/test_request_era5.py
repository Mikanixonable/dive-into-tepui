import unittest
import importlib.util
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location("request_era5", Path(__file__).with_name("request-era5.py"))
request = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(request)


class RequestEra5Tests(unittest.TestCase):
    def test_request_matches_source_contract(self):
        value = request.request_definition()
        self.assertEqual(value["product_type"], "monthly_averaged_reanalysis")
        self.assertEqual(value["variable"], ["2m_temperature", "total_cloud_cover"])
        self.assertEqual(value["year"], [str(year) for year in range(1991, 2021)])
        self.assertEqual(value["month"], [f"{month:02d}" for month in range(1, 13)])
        self.assertNotIn("time", value)
        self.assertEqual(value["data_format"], "netcdf")


if __name__ == "__main__":
    unittest.main()
