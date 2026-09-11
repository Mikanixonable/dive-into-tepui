"""Source-adapter and deterministic fixture renderer contracts."""

import copy
import hashlib
import importlib.util
import json
from pathlib import Path
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

    def test_real_source_adapter_resolves_products_without_opening_files(self):
        adapter = real_renderer.RealSourceAdapter(self.manifest, "/tmp/earth-surface-raw")
        tile = adapter.tile_input((7, 3, 4))
        self.assertEqual(tile.key, (7, 3, 4))
        self.assertEqual(tile.color_paths[0].name, "A1.tif")
        self.assertEqual(tile.surface_paths[0].name, "N90W180.tif")
        self.assertEqual(tile.surface_paths[-1].name, "S75E165.tif")
        self.assertEqual(tile.gshhg_path.name, "global.zip")
        self.assertEqual(tile.era5_path.name, "global.nc")
        with self.assertRaises(real_renderer.RendererUnavailable) as error:
            adapter.climate_input(1, 2, 2)
        self.assertIn("ERA5", str(error.exception))

    def test_geotiff_window_maps_target_bounds_to_bounded_pixels(self):
        grid = bake.Grid(10, 40, 11, 41, 4, 4)
        window = real_renderer.geotiff_window_for_grid(
            grid, (0, .25, 0, 90, 0, -.25), 1440, 720)
        self.assertEqual(window, (40, 196, 4, 4))
        with self.assertRaises(ValueError):
            real_renderer.geotiff_window_for_grid(grid, (0, .25, 1, 90, 0, -.25), 1440, 720)
        with self.assertRaises(ValueError):
            real_renderer.geotiff_window_for_grid(
                bake.Grid(-20, 40, -19, 41, 4, 4), (0, .25, 0, 90, 0, -.25), 1440, 720)

    def test_array_adapter_is_small_reader_boundary(self):
        grid = bake.tile_grid(7, 3, 4)
        count = grid.width * grid.height
        tile = real_renderer.TileArrays(
            (7, 3, 4), grid, [[20, 40, 80]] * count, [100.] * count,
            [20.] * count, [])
        climates = {month: ([280.], [.5], [0.], [1.]) for month in range(1, 13)}
        adapter = real_renderer.ArraySourceAdapter([tile], climates)
        self.assertIs(adapter.tile_arrays((7, 3, 4)), tile)
        self.assertEqual(adapter.climate_input(1, 1, 1), ([280.], [.5], [0.], [1.]))
        with self.assertRaises(real_renderer.RendererUnavailable):
            adapter.tile_arrays((7, 4, 4))

    @unittest.skipUnless(importlib.util.find_spec("PIL") is not None, "Pillow unavailable")
    def test_array_renderer_connects_window_to_bake_and_encoders(self):
        grid = bake.tile_grid(7, 3, 4)
        count = grid.width * grid.height
        tile = real_renderer.TileArrays(
            (7, 3, 4), grid, [[20, 40, 80]] * count, [100.] * count,
            [20.] * count, [])
        climates = {month: ([280.], [.5], [0.], [1.]) for month in range(1, 13)}
        renderer = real_renderer.ArrayRenderer(
            self.manifest, real_renderer.ArraySourceAdapter([tile], climates))
        color, terrain = renderer.render_tile((7, 3, 4))
        self.assertTrue(color.startswith(b"\xff\xd8") and color.endswith(b"\xff\xd9"))
        bake.validate_terrain_tile(terrain, (7, 3, 4), hashlib.sha256(terrain).hexdigest())

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
        roughness = [value / 255 for value in memoryview(terrain[32:]).cast("B").tolist()[2::4]]
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
        from PIL import Image
        import io

        renderer = real_renderer.create_fixture_renderer(self.manifest, self.write_fixture())
        with tempfile.TemporaryDirectory() as directory:
            source_manifest = Path(directory) / "sources.json"
            source_manifest.write_text(json.dumps(self.manifest))
            output = Path(directory) / "bundle"
            color_output = io.BytesIO()
            Image.new("RGB", (260, 260), (1, 2, 3)).save(color_output, format="JPEG")
            color = color_output.getvalue()
            terrain_z4 = bytearray(bake.encode_terrain_tile([(0., 0., 1.)] * 67600, [.8] * 67600, 4, 0, 0))
            terrain_z0 = bytearray(bake.encode_terrain_tile([(0., 0., 1.)] * 67600, [.8] * 67600, 0, 0, 0))

            def render(key):
                payload = bytearray(terrain_z0 if key[0] == 0 else terrain_z4)
                payload[12] = key[0]
                payload[14:18] = key[1].to_bytes(4, "little")
                payload[18:22] = key[2].to_bytes(4, "little")
                return color, bytes(payload)

            base_color = io.BytesIO()
            Image.new("RGB", (8192, 4096), (1, 2, 3)).save(base_color, format="JPEG")
            result = bake.write_global_bundle(
                self.manifest, source_manifest, Path(directory) / "raw", output,
                render, renderer.climate_maps(), base_color=base_color.getvalue(), max_zoom=4,
                validate_inputs=False, data_provenance="synthetic_fixture")
            self.assertEqual(result["provenance"]["dataKind"], "synthetic_fixture")
            self.assertEqual(result["coverage"], {"kind": "sparse", "minZoom": 4, "maxZoom": 7, "expectedTiles": None})
            self.assertEqual(json.loads((output / "tile-index.json").read_text())["entries"].__len__(), 512)

    def test_fixture_rejects_wrong_provenance_and_missing_path(self):
        fixture = copy.deepcopy(self.fixture)
        fixture["provenance"] = "source"
        with self.assertRaises(ValueError) as error:
            real_renderer.create_fixture_renderer(self.manifest, self.write_fixture(fixture))
        self.assertIn("synthetic_fixture provenance", str(error.exception))
        with self.assertRaises(real_renderer.RendererUnavailable) as error:
            real_renderer.create_fixture_renderer(self.manifest, "/does/not/exist/fixture.json")
        self.assertIn("全球fixtureがありません", str(error.exception))

    def test_committed_fixture_matches_source_manifest(self):
        path = ROOT / "tools/earth-surface/fixture-global.json"
        renderer = real_renderer.create_fixture_renderer(self.manifest, path)
        self.assertEqual(renderer.adapter.tile_input((0, 0, 0)).color_srgb[0], [42, 92, 156])

    def test_real_renderer_reports_exact_unavailable_boundary(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(real_renderer.RendererUnavailable) as error:
                real_renderer.create_real_renderer(self.manifest, directory)
        message = str(error.exception)
        self.assertIn("実データrenderer", message)
        self.assertTrue("依存が不足" in message or "入力が不足" in message)


if __name__ == "__main__":
    unittest.main()
