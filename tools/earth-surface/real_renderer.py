#!/usr/bin/env python3
"""Source adapters and the deterministic Earth-surface fixture renderer.

The production renderer is deliberately a gate until the four source products
can be read and composed together.  The fixture renderer is useful for testing
the complete writer contract without presenting synthetic values as Earth
data.
"""

from dataclasses import dataclass
import hashlib
import importlib.util
import json
import math
from pathlib import Path


class RendererUnavailable(RuntimeError):
    """A renderer cannot honestly produce a requested bundle."""


def _contract_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                      ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def _bake():
    # bake imports this module only for the CLI path, so importing lazily keeps
    # the source-adapter boundary usable from focused Python tests as well.
    import bake
    return bake


class SourceAdapter:
    """The data boundary consumed by a tile/climate renderer."""

    def tile_input(self, key):
        raise NotImplementedError

    def climate_input(self, month, width, height):
        raise NotImplementedError


def _finite(value, label):
    if not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"fixtureの{label}は有限数が必要です")
    return value


def _field(tile, name, count, *, channels=None):
    """Expand a compact fixture constant or validate a complete cell field."""
    if name not in tile:
        raise ValueError(f"fixtureタイルに{ name }がありません")
    value = tile[name]
    if channels is not None:
        if isinstance(value, list) and len(value) == channels and all(
                type(channel) is int and 0 <= channel <= 255 for channel in value):
            return [list(value) for _ in range(count)]
        if (not isinstance(value, list) or len(value) != count or
                any(not isinstance(pixel, list) or len(pixel) != channels or
                    any(type(channel) is not int or not 0 <= channel <= 255 for channel in pixel)
                    for pixel in value)):
            raise ValueError(f"fixtureタイルの{name}はRGB8定数またはセル配列が必要です")
        return [list(pixel) for pixel in value]
    if isinstance(value, (int, float)):
        _finite(value, name)
        return [value] * count
    if not isinstance(value, list) or len(value) != count:
        raise ValueError(f"fixtureタイルの{name}はセル数と一致する配列が必要です")
    return [_finite(item, name) if item is not None else None for item in value]


@dataclass(frozen=True)
class FixtureTile:
    key: tuple
    color_srgb: list
    ice_surface_m: list
    geoid_m: list


class FixtureSourceAdapter(SourceAdapter):
    """Validated, compact JSON adapter for a synthetic small bundle."""

    def __init__(self, manifest, fixture):
        if fixture.get("schemaVersion") != 1 or fixture.get("kind") != "earth-surface-global-fixture":
            raise ValueError("全球fixture形式が必要です")
        if fixture.get("provenance") != "synthetic_fixture":
            raise ValueError("全球fixtureはsynthetic_fixture provenanceが必要です")
        if fixture.get("datasetId") != manifest["datasetId"]:
            raise ValueError("全球fixtureとソースmanifestのdatasetIdが不一致です")
        if fixture.get("sourceManifestSha256") != _contract_hash(manifest):
            raise ValueError("全球fixtureとソースmanifestの版が不一致です")
        if fixture.get("surfaceSourceId") != "etopo-2022-v1-ice-surface" or fixture.get("geoidSourceId") != "etopo-2022-v1-geoid":
            raise ValueError("全球fixtureはETOPO ice-surfaceと対応するgeoidが必要です")
        self.manifest = manifest
        self.polygons = fixture.get("gshhgPolygons", [])
        if not isinstance(self.polygons, list):
            raise ValueError("全球fixtureのGSHHGポリゴンが不正です")
        self._tiles = {}
        for tile in fixture.get("tiles", []):
            key = tuple(tile.get("key", ()))
            if len(key) != 3 or any(type(value) is not int for value in key):
                raise ValueError("fixtureタイルのkeyが不正です")
            z, x, y = key
            if not (0 <= z <= 7 and 0 <= x < 2 ** (z + 1) and 0 <= y < 2 ** z):
                raise ValueError(f"fixtureタイルの座標が不正です: {key}")
            if key in self._tiles:
                raise ValueError(f"fixtureタイルが重複しています: {key}")
            count = 260 * 260
            self._tiles[key] = FixtureTile(
                key, _field(tile, "colorSrgb", count, channels=3),
                _field(tile, "iceSurfaceM", count), _field(tile, "geoidM", count))
        if not self._tiles:
            raise ValueError("全球fixtureにタイルがありません")
        self._climate = fixture.get("climate", {})
        if not isinstance(self._climate, dict):
            raise ValueError("全球fixtureのclimateが不正です")

    @classmethod
    def from_path(cls, manifest, path):
        fixture_path = Path(path)
        if not fixture_path.is_file():
            raise RendererUnavailable(f"全球fixtureがありません: {fixture_path}")
        try:
            fixture = json.loads(fixture_path.read_text())
        except (OSError, ValueError) as error:
            raise RendererUnavailable(f"全球fixtureを読み込めません: {fixture_path}") from error
        return cls(manifest, fixture)

    def tile_input(self, key):
        try:
            return self._tiles[tuple(key)]
        except KeyError as error:
            raise RendererUnavailable(f"fixtureにタイルがありません: {tuple(key)}") from error

    def climate_input(self, month, width, height):
        if not 1 <= month <= 12:
            raise ValueError("monthは1..12が必要です")
        count = width * height
        entry = self._climate.get(str(month), self._climate.get("default", self._climate))
        if not isinstance(entry, dict):
            raise ValueError(f"fixtureの気候mapが不正です: {month}")
        return tuple(_climate_field(entry, name, count) for name in (
            "temperatureK", "cloudFraction", "orthometricElevationM", "landFraction"))


def _climate_field(entry, name, count):
    if name not in entry:
        raise ValueError(f"fixtureの気候値がありません: {name}")
    value = entry[name]
    if isinstance(value, (int, float)):
        return [_finite(value, name)] * count
    if not isinstance(value, list) or len(value) != count:
        raise ValueError(f"fixtureの気候値がセル数と一致しません: {name}")
    return [_finite(item, name) for item in value]


class FixtureRenderer:
    """Render validated fixture cells through bake.py's production encoders."""

    def __init__(self, manifest, adapter):
        self.manifest = manifest
        self.adapter = adapter

    def render_tile(self, key):
        bake = _bake()
        tile = self.adapter.tile_input(key)
        grid = bake.tile_grid(*key)
        region = {
            "schemaVersion": 1,
            "kind": "earth-surface-region-fixture",
            "datasetId": self.manifest["datasetId"],
            "sourceManifestSha256": _contract_hash(self.manifest),
            "surfaceSourceId": "etopo-2022-v1-ice-surface",
            "geoidSourceId": "etopo-2022-v1-geoid",
            "axesM": [6378137, 6356752.314245, 6378137],
            "grid": grid.__dict__,
            "colorSrgb": tile.color_srgb,
            "iceSurfaceM": tile.ice_surface_m,
            "geoidM": tile.geoid_m,
            "gshhgPolygons": self.adapter.polygons,
        }
        result = bake.bake_region(region, self.manifest)
        color = _encode_jpeg(tile.color_srgb, grid.width, grid.height)
        terrain = bake.encode_terrain_tile(result["normals"], result["roughness"], *key)
        return color, terrain

    def climate_maps(self):
        bake = _bake()
        climate = self.manifest["climateMap"]
        width, height = climate["width"], climate["height"]
        return [bake.encode_climate_rgba(*self.adapter.climate_input(month, width, height), width, height)
                for month in range(1, 13)]


def _encode_jpeg(pixels, width, height):
    try:
        from PIL import Image
    except ImportError as error:
        raise RendererUnavailable("fixture JPEG出力にはPillowが必要です") from error
    raw = bytes(channel for pixel in pixels for channel in pixel)
    image = Image.frombytes("RGB", (width, height), raw)
    import io
    output = io.BytesIO()
    image.save(output, format="JPEG", quality=90, optimize=False, progressive=False, subsampling=0)
    return output.getvalue()


class RealDataRenderer:
    """Production gate until source windows can be composed without fabrication."""

    def __init__(self, manifest, raw_root):
        self.manifest = manifest
        self.raw_root = Path(raw_root)
        missing_modules = [name for name in ("osgeo", "netCDF4", "shapefile", "PIL")
                           if importlib.util.find_spec(name) is None]
        if missing_modules:
            raise RendererUnavailable(
                "実データrendererの依存が不足しています: " + ", ".join(missing_modules))
        bake = _bake()
        missing_paths = [path for path in bake.global_input_paths(manifest, raw_root) if not path.is_file()]
        if missing_paths:
            preview = ", ".join(str(path) for path in missing_paths[:8])
            more = "" if len(missing_paths) <= 8 else f" (+{len(missing_paths) - 8}件)"
            raise RendererUnavailable(f"実データrendererの入力が不足しています: {preview}{more}")
        raise RendererUnavailable(
            "実データrendererのBMNG/ETOPO/GSHHG/ERA5 window合成は未接続です。"
            "fixtureを実データとして扱わず、入力取得後にwindow adapterを実装してください")

    def render_tile(self, _key):
        raise RendererUnavailable("実データrendererは利用できません")

    def climate_maps(self):
        raise RendererUnavailable("実データrendererは利用できません")


def create_fixture_renderer(manifest, fixture_path):
    return FixtureRenderer(manifest, FixtureSourceAdapter.from_path(manifest, fixture_path))


def create_real_renderer(manifest, raw_root):
    return RealDataRenderer(manifest, raw_root)
