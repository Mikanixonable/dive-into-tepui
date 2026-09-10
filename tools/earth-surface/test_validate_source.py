"""Tests for local ERA5 and downloaded-source validation."""

import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest


ROOT = Path(__file__).resolve().parents[2]


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


validate = load_module("earth_surface_validate", "validate-source.py")
exporter = load_module("earth_surface_export", "export-manifest.py")


class FakeVariable:
    def __init__(self, dimensions, values, units=None, shape=None):
        self.dimensions = dimensions
        self._values = values
        self.units = units
        self.shape = shape or (len(values),)

    def __getitem__(self, _):
        return self._values


class FakeDataset:
    def __init__(self, variables):
        self.variables = variables
        self.dimensions = {"time": range(8640), "latitude": range(721), "longitude": range(1440)}

    def close(self):
        pass


def fake_netcdf(variable_changes=None):
    changes = variable_changes or {}
    times = list(range(8640))
    latitude = [90 - index * 0.25 for index in range(721)]
    longitude = [index * 0.25 for index in range(1440)]
    variables = {
        "time": FakeVariable(("time",), times, "hours since 1991-01-01 00:00:00"),
        "latitude": FakeVariable(("latitude",), latitude, "degrees_north"),
        "longitude": FakeVariable(("longitude",), longitude, "degrees_east"),
        "t2m": FakeVariable(("time", "latitude", "longitude"), [], "K", (8640, 721, 1440)),
        "tcc": FakeVariable(("time", "latitude", "longitude"), [], "1", (8640, 721, 1440)),
    }
    variables.update(changes)

    class Module:
        Dataset = lambda self, _path, _mode: FakeDataset(variables)

        @staticmethod
        def num2date(values, _units, calendar):
            del calendar
            result = []
            for index in values:
                month_index, hour = divmod(index, 24)
                year, month_index = divmod(month_index, 12)
                result.append(types.SimpleNamespace(year=1991 + year, month=month_index + 1, hour=hour))
            return result

    return Module()


class ValidateSourceTests(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads((ROOT / "assets-src/earth-surface/sources.json").read_text())

    def test_era5_export_accepts_canonical_grid_and_time(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "era5.nc"
            path.write_bytes(b"deterministic fixture")
            result = validate.validate_era5_export(path, self.manifest, fake_netcdf())
        self.assertEqual(result["dimensions"], {"time": 8640, "latitude": 721, "longitude": 1440})
        self.assertEqual(result["time"]["hoursUtc"], list(range(24)))
        self.assertEqual(result["variables"]["2m_temperature"]["name"], "t2m")
        self.assertEqual(len(result["sha256"]), 64)

    def test_era5_export_rejects_reversed_latitude(self):
        reversed_latitude = FakeVariable(
            ("latitude",), list(reversed([90 - index * 0.25 for index in range(721)])), "degrees_north")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "era5.nc"
            path.write_bytes(b"fixture")
            with self.assertRaisesRegex(validate.ValidationError, "座標順序"):
                validate.validate_era5_export(path, self.manifest,
                                              fake_netcdf({"latitude": reversed_latitude}))

    def test_era5_export_rejects_wrong_unit(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "era5.nc"
            path.write_bytes(b"fixture")
            wrong = FakeVariable(("time", "latitude", "longitude"), [], "C", (8640, 721, 1440))
            with self.assertRaisesRegex(validate.ValidationError, "単位"):
                validate.validate_era5_export(path, self.manifest, fake_netcdf({"t2m": wrong}))

    def test_era5_export_accepts_copernicus_cloud_fraction_units(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "era5.nc"
            path.write_bytes(b"fixture")
            for unit in ("(0 - 1)", "(0-1)", "0-1", "fraction", " 1 "):
                cloud = FakeVariable(("time", "latitude", "longitude"), [], unit,
                                     (8640, 721, 1440))
                result = validate.validate_era5_export(path, self.manifest,
                                                       fake_netcdf({"tcc": cloud}))
                self.assertEqual(result["variables"]["total_cloud_cover"]["units"], unit)

    def test_download_receipt_and_hash_are_checked_without_network(self):
        manifest = copy.deepcopy(self.manifest)
        manifest["sources"] = [{
            "id": "fixture", "format": "netcdf", "inputSha256": [], "regions": ["global"],
            "urlTemplate": "https://example.test/{region}.nc", "attribution": ["Fixture"]
        }]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "raw"
            target = root / "fixture" / "global.nc"
            target.parent.mkdir(parents=True)
            target.write_bytes(b"fixture payload")
            receipt = {
                "sourceId": "fixture", "region": "global", "bytes": target.stat().st_size,
                "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
                "sourceContractSha256": validate.contract_hash(manifest["sources"][0]),
                "sourceManifestSha256": validate.contract_hash(manifest),
                "url": "https://example.test/global.nc",
                "attribution": ["Fixture"],
            }
            target.with_suffix(".nc.json").write_text(json.dumps(receipt))
            result = validate.validate_source_files(manifest, root)
            self.assertEqual(len(result["files"]), 1)
            self.assertEqual(len(result["unpinned"]), 1)
            target.write_bytes(b"changed payload")
            with self.assertRaisesRegex(validate.ValidationError, "SHA-256"):
                validate.validate_source_files(manifest, root)

    def test_export_manifest_writes_hash_inventory(self):
        manifest = copy.deepcopy(self.manifest)
        manifest["sources"] = [{
            "id": "fixture", "format": "netcdf", "inputSha256": [], "regions": ["global"],
            "urlTemplate": "https://example.test/{region}.nc", "attribution": ["Fixture"]
        }]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "raw"
            manifest_path = Path(directory) / "sources.json"
            manifest_path.write_text(json.dumps(manifest))
            target = root / "fixture" / "global.nc"
            target.parent.mkdir(parents=True)
            target.write_bytes(b"fixture payload")
            target.with_suffix(".nc.json").write_text(json.dumps({
                "sourceId": "fixture", "region": "global", "bytes": target.stat().st_size,
                "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
                "sourceContractSha256": validate.contract_hash(manifest["sources"][0]),
                "sourceManifestSha256": validate.contract_hash(manifest),
                "url": "https://example.test/global.nc",
                "attribution": ["Fixture"],
            }))
            output = Path(directory) / "export.json"
            result = exporter.export_manifest(manifest_path, root, output)
            self.assertTrue(output.is_file())
            self.assertEqual(result["kind"], "earth-surface-source-export-manifest")
            self.assertEqual(result["files"][0]["sha256"], hashlib.sha256(b"fixture payload").hexdigest())


if __name__ == "__main__":
    unittest.main()
