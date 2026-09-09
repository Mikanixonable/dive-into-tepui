"""小領域の地理的不変条件と、取得・配信形式の破損検出を検証する。"""

import copy
import gzip
import hashlib
import io
import importlib.util
import json
import math
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

import bake

FETCH = bake._fetch
ROOT = Path(__file__).resolve().parents[2]


# 指定の階層と矩形領域を持つ閉じたGSHHG fixtureを返す。
def rectangle(west, south, east, north, level=1):
    return {"level": level, "coordinates": [[west, south], [east, south], [east, north], [west, north], [west, south]]}


# 三行三列の有限な陸上入力を、固定ソース契約へ結び付ける。
def region(manifest):
    return {"schemaVersion": 1, "kind": "earth-surface-region-fixture", "datasetId": manifest["datasetId"],
            "sourceManifestSha256": FETCH.contract_hash(manifest), "surfaceSourceId": "etopo-2022-v1-ice-surface",
            "geoidSourceId": "etopo-2022-v1-geoid", "axesM": [6378137, 6356752.314245, 6378137],
            "grid": {"west": -1.5, "south": -1.5, "east": 1.5, "north": 1.5, "width": 3, "height": 3},
            "colorSrgb": [[20, 60, 90]] * 9, "iceSurfaceM": [100.0] * 9, "geoidM": [20.0] * 9,
            "gshhgPolygons": [rectangle(-1.5, -1.5, 1.5, 1.5)]}


# 最小の非圧縮GeoTIFFを構成し、ディスクfixtureへ保存できるバイト列を返す。
def tiny_tiff():
    tags = {256: (4, [2]), 257: (4, [2]), 258: (3, [16]), 259: (3, [1]), 262: (3, [1]),
            273: (4, [0]), 277: (3, [1]), 278: (4, [2]), 279: (4, [8]),
            33550: (12, [1., 1., 0.]), 33922: (12, [0., 0., 0., 0., 2., 0.]),
            34735: (3, [1, 1, 0, 1, 2048, 0, 1, 4326]), 42113: (2, b"-99999\x00")}
    prefix_length = 8 + 2 + len(tags) * 12 + 4
    entries, extra = [], bytearray()
    for tag, (kind, values) in sorted(tags.items()):
        raw = values if kind == 2 else struct.pack("<" + str(len(values)) + {3: "H", 4: "I", 12: "d"}[kind], *values)
        if len(raw) <= 4:
            field = raw.ljust(4, b"\x00")
        else:
            field = struct.pack("<I", prefix_length + len(extra))
            extra.extend(raw)
        entries.append([tag, kind, len(values), field])
    for entry in entries:
        if entry[0] == 273:
            entry[3] = struct.pack("<I", prefix_length + len(extra))
    return b"II*\x00\x08\x00\x00\x00" + struct.pack("<H", len(entries)) + b"".join(struct.pack("<HHI4s", *entry) for entry in entries) + b"\x00" * 4 + extra + b"\x00" * 8


class Reply(io.BytesIO):
    """urllibのネットワーク実体をメモリ内の決定的な応答に置き換える。"""

    # statusとHTTPヘッダーを伴う読み取りストリームを作る。
    def __init__(self, data, status=200, headers=None):
        super().__init__(data)
        self.status = status
        self.headers = {"Content-Type": "image/tiff", "Content-Length": str(len(data)), "ETag": '"fixture"', **(headers or {})}


class BakeTests(unittest.TestCase):
    # 正本のソース契約を各テストの入力として読む。
    def setUp(self):
        self.manifest = FETCH.load_manifest(ROOT / "assets-src/earth-surface/sources.json")

    # 標高基準の加算と海面下の陸地保存を検証する。
    def test_geoid_and_negative_land(self):
        value = region(self.manifest)
        value["iceSurfaceM"] = [-420.0] * 9
        result = bake.bake_region(value, self.manifest)
        self.assertEqual(result["ellipsoidHeightM"], [-400.0] * 9)
        self.assertEqual(result["orthometricHeightM"], [-420.0] * 9)
        self.assertEqual(result["landFraction"], [1.0] * 9)

    # 海底の高さを変えても沿岸陸の法線と水域の気候標高が変化しない。
    def test_seabed_does_not_tilt_land(self):
        value = region(self.manifest)
        value["gshhgPolygons"] = [rectangle(-0.5, -1.5, 1.5, 1.5)]
        for index in (0, 3, 6):
            value["iceSurfaceM"][index] = -10000
        first = bake.bake_region(value, self.manifest)
        value["iceSurfaceM"][0] = 10000
        second = bake.bake_region(value, self.manifest)
        self.assertEqual(first["normals"], second["normals"])
        self.assertEqual(first["orthometricHeightM"][3], 0)
        self.assertEqual(first["normals"][4], (0., 0., 1.))

    # NoDataは正高ゼロへ化けず、幾何法線へ戻る。
    def test_nodata_fallback(self):
        value = region(self.manifest)
        for missing in (None, -99999, float("nan")):
            value["iceSurfaceM"][4] = missing
            result = bake.bake_region(value, self.manifest)
            self.assertIsNone(result["ellipsoidHeightM"][4])
            self.assertIsNone(result["orthometricHeightM"][4])
            self.assertEqual(result["normals"][4], (0., 0., 1.))

    # 緯度帯の被覆率は平面積比ではなくsin緯度の差に従う。
    def test_spherical_coverage(self):
        grid = bake.Grid(0, 0, 2, 60, 1, 1)
        land, _ = bake.coverage(grid, [rectangle(0, 0, 2, 30)])
        self.assertAlmostEqual(land[0], math.sin(math.pi / 6) / math.sin(math.pi / 3))

    # 湖・湖中島・島内池の包含関係と日付変更線を検証する。
    def test_hierarchy_and_longitude_wrap(self):
        grid = bake.Grid(179, -1, 181, 1, 2, 1)
        land, _ = bake.coverage(grid, [rectangle(179, -1, -179, 1)])
        self.assertEqual(land, [1., 1.])
        grid = bake.Grid(0, 0, 4, 1, 4, 1)
        polygons = [rectangle(0, 0, 4, 1), rectangle(1, 0, 4, 1, 2),
                    rectangle(2, 0, 4, 1, 3), rectangle(3, 0, 4, 1, 4)]
        self.assertEqual(bake.coverage(grid, polygons)[0], [1., 0., 1., 0.])

    # L5とL6は排他的に選び、明示された氷被覆を保存する。
    def test_antarctic_ice_front(self):
        grid = bake.Grid(-1, -90, 1, -89, 1, 1)
        polygons = [rectangle(-1, -90, 1, -89, level) for level in (5, 6)]
        self.assertEqual(bake.coverage(grid, polygons), ([1.], [1.]))

    # 地理基底に沿う解析的勾配と正距円筒の極近傍を検証する。
    def test_analytic_slope_and_poles(self):
        grid = bake.Grid(-1.5, -1.5, 1.5, 1.5, 3, 3)
        axes = [6378137, 6356752.314245, 6378137]
        heights = [0.01 * bake.ellipsoid_position(bake.basis(*grid.center(x, y))[2], axes)[0]
                   for y in range(3) for x in range(3)]
        normal = bake.terrain_normals(grid, heights, [1.] * 9, axes)[4]
        expected = bake.normalize((-0.01, 0., 1.))
        for actual, theory in zip(normal, expected):
            self.assertAlmostEqual(actual, theory, places=12)
        globe = bake.Grid(-180, -90, 180, 90, 4, 2)
        self.assertEqual(globe.neighbor(-1, 0), (3, 0))
        self.assertEqual(globe.neighbor(0, -1), (2, 0))
        self.assertEqual(globe.neighbor(0, 2), (2, 1))
        normals = bake.terrain_normals(globe, [0.] * 8, [1.] * 8, axes)
        self.assertTrue(all(math.isclose(sum(component ** 2 for component in vector), 1.) for vector in normals))

    # sRGBの黒白を線形平均し、欠測と範囲不足を拒否する。
    def test_regrid_color_and_missing(self):
        source, target = bake.Grid(0, 0, 2, 1, 2, 1), bake.Grid(0, 0, 2, 1, 1, 1)
        self.assertEqual(bake.regrid_color([[0, 0, 0], [255, 255, 255]], source, target), [(188, 188, 188)])
        with self.assertRaises(ValueError):
            bake.regrid_mean([None, 1.], source, target)
        with self.assertRaises(ValueError):
            bake.regrid_mean([1., 1.], source, bake.Grid(0, 0, 3, 1, 1, 1))

    # ERA5の年月・全UTC時刻・変数範囲を固定する。
    def test_era5_complete_month(self):
        records = [{"year": year, "month": 7, "hourUtc": hour, "2m_temperature": 280., "total_cloud_cover": .4}
                   for year in range(1991, 2021) for hour in range(24)]
        self.assertEqual(bake.era5_month_mean(records, 7), (280., .4))
        with self.assertRaises(ValueError):
            bake.era5_month_mean(records[:-1], 7)
        records[0]["total_cloud_cover"] = 1.1
        with self.assertRaises(ValueError):
            bake.era5_month_mean(records, 7)

    # 別版・bed product・別ソース契約のfixtureを拒否する。
    def test_input_identity(self):
        for key, invalid in (("datasetId", "other"), ("surfaceSourceId", "bed_elev"), ("sourceManifestSha256", "0" * 64)):
            value = region(self.manifest)
            value[key] = invalid
            with self.assertRaises(ValueError):
                bake.bake_region(value, self.manifest)

    # ESTNの長さ・キー・scalar・payload hashを配信前に検査する。
    def test_terrain_header_and_gzip(self):
        payload = bake.encode_terrain_tile([(0., 0., 1.)] * 67600, [.8] * 67600, 7, 3, 4)
        digest = hashlib.sha256(payload).hexdigest()
        bake.validate_terrain_tile(payload, (7, 3, 4), digest)
        self.assertEqual(gzip.decompress(gzip.compress(payload, mtime=0)), payload)
        self.assertEqual(len(payload), 32 + 260 * 260 * 8)
        for offset in (4, 8, 12, 23, 24, 28):
            broken = bytearray(payload)
            broken[offset] ^= 1
            with self.assertRaises(ValueError):
                bake.validate_terrain_tile(broken, (7, 3, 4), hashlib.sha256(broken).hexdigest())
        with self.assertRaises(ValueError):
            bake.validate_terrain_tile(payload[:-1], (7, 3, 4), digest)

    # 全球z0..z7のキー数と経度連続性を固定する。
    def test_global_tile_coverage(self):
        keys = bake.global_tile_keys()
        self.assertEqual(len(keys), 43690)
        self.assertEqual(keys[0], (0, 0, 0))
        self.assertEqual(keys[-1], (7, 255, 127))
        self.assertEqual(len(set(keys)), len(keys))
        self.assertEqual(bake.tile_grid(7, 0, 0).width, 260)
        self.assertAlmostEqual(bake.tile_grid(7, 0, 0).west, -180 - 2 * (180 / 128 / 256))

    # z=0の2枚をESTBへまとめ、壊れたpayloadを拒否する。
    def test_base_estb(self):
        payloads = [bake.encode_terrain_tile([(0., 0., 1.)] * 67600, [.8] * 67600, 0, x, 0) for x in (0, 1)]
        base = bake.encode_base_terrain(payloads)
        self.assertEqual(bake.validate_base_terrain(base)["payloadBytes"], len(base) - 32)
        with self.assertRaises(ValueError):
            bake.validate_base_terrain(base[:-1])

    # 気候mapは固定レンジをRGBA8へ写像し、水域の標高0mを明示的に受け入れる。
    @unittest.skipUnless(importlib.util.find_spec("PIL") is not None, "Pillow unavailable")
    def test_climate_png(self):
        count = 1024 * 512
        png = bake.encode_climate_rgba([280.] * count, [.5] * count, [0.] * count, [0.] * count)
        self.assertTrue(png.startswith(b"\x89PNG\r\n\x1a\n"))
        self.assertEqual(png, bake.encode_climate_rgba([280.] * count, [.5] * count, [0.] * count, [0.] * count))
        with self.assertRaises(ValueError):
            bake.encode_climate_rgba([280.] * count, [.5] * count, [-1001.] * count, [0.] * count)


class FetchTests(unittest.TestCase):
    # 最小GeoTIFFのソース契約を作る。
    def setUp(self):
        self.source = {"id": "fixture", "format": "geotiff", "dimensions": [2, 2], "bands": 1,
                       "noData": -99999, "attribution": ["synthetic fixture"]}
        self.data = tiny_tiff()

    # HTML・破損TIFF・CRS/寸法/NoData不一致を拒否する。
    def test_source_format_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input.tif"
            path.write_bytes(self.data)
            FETCH.validate_file(path, self.source)
            for changes in ({"dimensions": [3, 2]}, {"noData": None}, {"bands": 3}):
                with self.assertRaises(FETCH.InvalidSource):
                    FETCH.validate_file(path, {**self.source, **changes})
            for invalid in (b"<!doctype html>redirect", self.data[:-1], b"II*\x00broken"):
                path.write_bytes(invalid)
                with self.assertRaises(FETCH.InvalidSource):
                    FETCH.validate_file(path, self.source)

    # 固定hashを検証し、同じファイルを再利用する。
    def test_download_and_reuse(self):
        digest = hashlib.sha256(self.data).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(FETCH.urllib.request, "urlopen", return_value=Reply(self.data)) as opened:
                first = FETCH.fetch_region(self.source, "one", "https://fixture/one", directory, "manifest", digest, len(self.data))
                second = FETCH.fetch_region(self.source, "one", "https://fixture/one", directory, "manifest", digest, len(self.data))
            self.assertEqual(first, second)
            self.assertEqual(first["hashVerification"], "pinned")
            self.assertEqual(opened.call_count, 1)

    # Rangeを理解するサーバの部分実体へ正しい残りを連結する。
    def test_resume(self):
        with tempfile.TemporaryDirectory() as directory:
            partial = Path(directory) / "fixture" / "one.tif.part"
            partial.parent.mkdir()
            partial.write_bytes(self.data[:100])
            saved = {"url": "https://fixture/one", "sourceManifestSha256": "manifest",
                     "sourceContractSha256": FETCH.contract_hash(self.source), "expectedSha256": None,
                     "expectedBytes": None, "validator": '"fixture"'}
            partial.with_suffix(".part.json").write_text(json.dumps(saved))
            reply = Reply(self.data[100:], 206, {"Content-Range": f"bytes 100-{len(self.data) - 1}/{len(self.data)}"})
            with patch.object(FETCH.urllib.request, "urlopen", return_value=reply) as opened:
                receipt = FETCH.fetch_region(self.source, "one", "https://fixture/one", directory, "manifest")
            self.assertEqual(opened.call_args.args[0].get_header("Range"), "bytes=100-")
            self.assertEqual(receipt["sha256"], hashlib.sha256(self.data).hexdigest())

    # hash違いの実体を確定先へ出さず、隔離する。
    def test_failed_hash_quarantine(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(FETCH.urllib.request, "urlopen", return_value=Reply(self.data)):
                with self.assertRaises(FETCH.InvalidSource):
                    FETCH.fetch_region(self.source, "one", "https://fixture/one", directory, "manifest", "0" * 64)
            self.assertFalse((Path(directory) / "fixture/one.tif").exists())
            self.assertEqual(len(list((Path(directory) / "fixture/rejected").glob("*/one.tif.part"))), 1)


if __name__ == "__main__":
    unittest.main()
