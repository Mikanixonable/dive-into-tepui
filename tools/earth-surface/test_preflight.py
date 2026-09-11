"""実データ取得前検査の副作用と容量計算を検証する。"""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

_spec = importlib.util.spec_from_file_location("preflight", Path(__file__).with_name("preflight.py"))
preflight = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(preflight)


class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads((Path(__file__).parents[2] / "assets-src/earth-surface/sources.json").read_text())

    def test_regions_cover_manifest(self):
        sources = {source["id"]: source for source in self.manifest["sources"]}
        self.assertEqual(len(preflight.regions_for(sources["bmng-july-2004"])), 8)
        self.assertEqual(len(preflight.regions_for(sources["etopo-2022-v1-ice-surface"])), 288)
        self.assertEqual(preflight.regions_for(sources["gshhg-2.3.7"]), ["global"])
        self.assertEqual(preflight.regions_for(sources["era5-monthly-1991-2020"]), ["global"])

    def test_estimate_exposes_uncompressed_lower_bound(self):
        result = preflight.estimate(self.manifest, [], ".earth-surface/raw")
        self.assertEqual(result["tileCount"], 43520)
        self.assertEqual(result["terrainPayloadBytesPerTile"], 270432)
        self.assertEqual(result["outputLowerBoundBytes"], 11769741504)
        self.assertEqual(result["inputBytesFromHEAD"], 0)

    def test_probe_records_headers_without_reading_body(self):
        class Response:
            status = 200
            headers = {"Content-Length": "42", "Content-Type": "image/tiff", "ETag": '"a"'}

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def geturl(self):
                return "https://example.test/data"

        with patch.object(preflight.urllib.request, "urlopen", return_value=Response()) as open_url:
            result = preflight.probe("https://example.test/data", 1)
        self.assertEqual(result["contentLength"], 42)
        self.assertEqual(result["etag"], '"a"')
        self.assertEqual(open_url.call_args.args[0].method, "HEAD")

    def test_report_probes_public_era5_mirror(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "report.json"
            with patch.object(preflight, "probe", return_value={
                    "status": 200, "contentLength": 1, "contentType": "application/x-netcdf",
                    "contentEncoding": "identity", "etag": None, "url": "https://example.test"}), \
                    patch.object(preflight, "dependency_report", return_value={
                        "pythonModules": {name: True for name in preflight.MODULES},
                        "commands": {name: "/usr/bin/" + name for name in preflight.COMMANDS}}):
                report = preflight.run(
                    Path(__file__).parents[2] / "assets-src/earth-surface/sources.json",
                    0, 1, 1, directory,
                )
            self.assertEqual(report["status"], "ready_for_acquisition")
            era5 = next(item for item in report["sources"] if item["sourceId"] == "era5-monthly-1991-2020")
            self.assertEqual(era5["regionsRequested"], 2)
            output.write_text(json.dumps(report))


if __name__ == "__main__":
    unittest.main()
