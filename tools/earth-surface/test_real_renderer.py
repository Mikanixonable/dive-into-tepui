"""Source-adapter and deterministic fixture renderer contracts."""

import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest

import bake
import real_renderer


ROOT = Path(__file__).resolve().parents[2]


def contract_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                      ensure_ascii=False, allow_nan=False).encode()).hexdigest()


class RendererTests(unittest.TestCase):
    def setUp(self):
        self.manifest = bake._fetch.load_manifest(ROOT / "assets-src/earth-surface/sources.json")
        self.fixture = {
            "schemaVersion": 1,
            "kind": "earth-surface-global-fixture",
            "provenance": "synthetic_fixture",
            "datasetId": self.manifest["datasetId"],
            "sourceManifestSha256": contract_hash(self.manifest),
            "surfaceSourceId": "etopo-2022-v1-ice-surface",
            "geoidSourceId": "etopo-2022-v1-geoid",
            "gshhgPolygons": [],
            "tiles": [
                {"key": [0, 0, 0], "colorSrgb": [10, 20, 30], "iceSurfaceM": 100, "geoidM": 20},
                {"key": [0, 1, 0], "colorSrgb": [30, 20, 10], "iceSurfaceM": 100, "geoidM": 20},
            ],
            "climate": {"default": {"temperatureK": 280, "cloudFraction": .5,
                                      "orthometricElevationM": 0, "landFraction": 1}},
        }

    def write_fixture(self, fixture=None):
        path = Path(tempfile.mkdtemp()) / "fixture.json"
        path.write_text(json.dumps(self.fixture if fixture is None else fixture))
        return path

    def test_adapter_coordinates_and_window_contract(self):
        grid = bake.tile_grid(0, 0, 0)
        self.assertEqual(grid.width, 260)
        self.assertAlmostEqual(grid.west, -180 - 2 * 180 / 256)
        renderer = real_renderer.create_fixture_renderer(self.manifest, self.write_fixture())
        self.assertEqual(renderer.adapter.tile_input((0, 0, 0)).color_srgb[0], [10, 20, 30])
        with self.assertRaises(real_renderer.RendererUnavailable) as error:
            renderer.render_tile((1, 0, 0))
        self.assertIn("fixtureにタイルがありません", str(error.exception))

    @unittest.skipUnless(importlib.util.find_spec("PIL") is not None, "Pillow unavailable")
    def test_tile_coordinates_and_window_contract(self):
        self.assertEqual(bake.tile_grid(0, 0, 0).width, 260)
        self.assertAlmostEqual(bake.tile_grid(0, 0, 0).west, -180 - 2 * 180 / 256)
        renderer = real_renderer.create_fixture_renderer(self.manifest, self.write_fixture())
        self.assertEqual(renderer.adapter.tile_input((0, 0, 0)).color_srgb[0], [10, 20, 30])
        with self.assertRaises(real_renderer.RendererUnavailable) as error:
            renderer.render_tile((1, 0, 0))
        self.assertIn("fixtureにタイルがありません", str(error.exception))
        color, terrain = renderer.render_tile((0, 0, 0))
        self.assertTrue(color.startswith(b"\xff\xd8") and color.endswith(b"\xff\xd9"))
        bake.validate_terrain_tile(terrain, (0, 0, 0), hashlib.sha256(terrain).hexdigest())

    @unittest.skipUnless(importlib.util.find_spec("PIL") is not None, "Pillow unavailable")
    def test_gshhg_mask_controls_water_roughness(self):
        fixture = copy.deepcopy(self.fixture)
        fixture["gshhgPolygons"] = [{"level": 1, "coordinates": [
            [-180, -90], [-90, -90], [-90, 90], [-180, 90], [-180, -90]
        ]}]
        renderer = real_renderer.create_fixture_renderer(self.manifest, self.write_fixture(fixture))
        _, terrain = renderer.render_tile((0, 0, 0))
        roughness = [values[3] for values in struct.iter_unpack("<4e", terrain[32:])]
        self.assertTrue(any(value < .1 for value in roughness))
        self.assertTrue(any(value > .7 for value in roughness))

    @unittest.skipUnless(importlib.util.find_spec("PIL") is not None, "Pillow unavailable")
    def test_color_terrain_and_climate_encoding_are_deterministic(self):
        renderer = real_renderer.create_fixture_renderer(self.manifest, self.write_fixture())
        first = renderer.render_tile((0, 0, 0))
        second = renderer.render_tile((0, 0, 0))
        self.assertEqual(first, second)

        small_manifest = copy.deepcopy(self.manifest)
        small_manifest["climateMap"] = {"width": 2, "height": 1, "channels": 4,
                                         "encoding": self.manifest["climateMap"]["encoding"],
                                         "waterOrthometricElevationM": 0}
        small_fixture = copy.deepcopy(self.fixture)
        small_fixture["sourceManifestSha256"] = contract_hash(small_manifest)
        small_fixture["climate"] = {"default": {
            "temperatureK": [180, 330], "cloudFraction": [0, 1],
            "orthometricElevationM": [-1000, 9000], "landFraction": [0, 1]}}
        small = real_renderer.create_fixture_renderer(small_manifest, self.write_fixture(small_fixture))
        png = small.climate_maps()[0]
        from PIL import Image
        import io
        self.assertEqual(list(Image.open(io.BytesIO(png)).getdata()), [(0, 0, 0, 0), (255, 255, 255, 255)])

    @unittest.skipUnless(importlib.util.find_spec("PIL") is not None, "Pillow unavailable")
    def test_fixture_renderer_writes_explicit_synthetic_bundle(self):
        renderer = real_renderer.create_fixture_renderer(self.manifest, self.write_fixture())
        with tempfile.TemporaryDirectory() as directory:
            source_manifest = Path(directory) / "sources.json"
            source_manifest.write_text(json.dumps(self.manifest))
            output = Path(directory) / "bundle"
            result = bake.write_global_bundle(
                self.manifest, source_manifest, Path(directory) / "raw", output,
                renderer.render_tile, renderer.climate_maps(), max_zoom=0,
                validate_inputs=False, data_provenance="synthetic_fixture")
            self.assertEqual(result["provenance"]["dataKind"], "synthetic_fixture")
            self.assertEqual(json.loads((output / "tile-index.json").read_text())["entries"].__len__(), 2)

    def test_fixture_rejects_wrong_provenance_and_missing_path(self):
        fixture = copy.deepcopy(self.fixture)
        fixture["provenance"] = "source"
        with self.assertRaises(ValueError) as error:
            real_renderer.create_fixture_renderer(self.manifest, self.write_fixture(fixture))
        self.assertIn("synthetic_fixture provenance", str(error.exception))
        with self.assertRaises(real_renderer.RendererUnavailable) as error:
            real_renderer.create_fixture_renderer(self.manifest, "/does/not/exist/fixture.json")
        self.assertIn("全球fixtureがありません", str(error.exception))

    def test_real_renderer_reports_exact_unavailable_boundary(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(real_renderer.RendererUnavailable) as error:
                real_renderer.create_real_renderer(self.manifest, directory)
        message = str(error.exception)
        self.assertIn("実データrenderer", message)
        self.assertTrue("依存が不足" in message or "入力が不足" in message)


if __name__ == "__main__":
    unittest.main()
