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


@dataclass(frozen=True)
class RealTileSources:
    """Files and target window selected for one production tile."""

    key: tuple
    grid: object
    color_paths: tuple
    surface_paths: tuple
    geoid_paths: tuple
    gshhg_path: Path
    era5_path: Path


def geotiff_window_for_grid(grid, geo_transform, raster_width, raster_height):
    """Return the bounded pixel window intersecting a WGS84 target grid.

    GeoTIFF inputs in the source contract are north-up.  The returned window
    is conservative at both edges so a later area regrid never reads outside
    the file.  Longitude wrapping is handled by selecting the source file;
    this function only maps one unwrapped source interval.
    """
    if len(geo_transform) < 6 or geo_transform[2] != 0 or geo_transform[4] != 0:
        raise ValueError("GeoTIFFは回転のないnorth-up geotransformが必要です")
    origin_x, pixel_x, _, origin_y, _, pixel_y = geo_transform[:6]
    if not (math.isfinite(origin_x) and math.isfinite(origin_y)
            and math.isfinite(pixel_x) and math.isfinite(pixel_y)
            and pixel_x > 0 and pixel_y < 0
            and type(raster_width) is int and type(raster_height) is int
            and raster_width > 0 and raster_height > 0):
        raise ValueError("GeoTIFFのgeotransformまたは寸法が不正です")
    source_west, source_east = origin_x, origin_x + pixel_x * raster_width
    source_north, source_south = origin_y, origin_y + pixel_y * raster_height
    west = max(grid.west, source_west)
    east = min(grid.east, source_east)
    south = max(grid.south, source_south)
    north = min(grid.north, source_north)
    if not west < east or not south < north:
        raise ValueError("GeoTIFFと要求窓が交差していません")
    left = max(0, math.floor((west - origin_x) / pixel_x))
    right = min(raster_width, math.ceil((east - origin_x) / pixel_x))
    top = max(0, math.floor((origin_y - north) / -pixel_y))
    bottom = min(raster_height, math.ceil((origin_y - south) / -pixel_y))
    if not (left < right and top < bottom):
        raise ValueError("GeoTIFFの要求窓が空です")
    return left, top, right - left, bottom - top


def _source_paths(manifest, raw_root, source):
    """Resolve a source's declared local files without opening them."""
    root = Path(raw_root) / source["id"]
    suffix = {"geotiff": ".tif", "zip": ".zip", "netcdf": ".nc"}
    explicit = source.get("inputFiles")
    if explicit:
        return tuple(root / item for item in explicit)
    if source.get("regions"):
        return tuple(root / f"{region}{suffix[source['format']]}" for region in source["regions"])
    if source.get("regionGridDegrees"):
        return tuple(root / f"{'N' if latitude >= 0 else 'S'}{abs(latitude):02d}"
                     f"{'E' if longitude >= 0 else 'W'}{abs(longitude):03d}{suffix[source['format']]}"
                     for latitude in range(90, -90, -15)
                     for longitude in range(-180, 180, 15))
    return (root / f"global{suffix[source['format']]}",)


class RealSourceAdapter(SourceAdapter):
    """Local source boundary for production inputs.

    This adapter resolves and validates the file/window boundary.  Numerical
    composition remains in the renderer so BMNG linear-RGB, ETOPO vertical
    datums, GSHHG coverage, and ERA5 time aggregation cannot be mixed here.
    """

    def __init__(self, manifest, raw_root):
        bake = _bake()
        sources = {source["id"]: source for source in manifest["sources"]}
        required = {"bmng-july-2004", "etopo-2022-v1-ice-surface",
                    "etopo-2022-v1-geoid", "gshhg-2.3.7", "era5-monthly-1991-2020"}
        if set(sources) != required:
            raise RendererUnavailable("実データrendererのsource manifestが必要製品と一致しません")
        self.manifest = manifest
        self.raw_root = Path(raw_root)
        self.paths = {source_id: _source_paths(manifest, raw_root, source)
                      for source_id, source in sources.items()}
        self._bake = bake

    def tile_input(self, key):
        grid = self._bake.tile_grid(*key)
        return RealTileSources(
            tuple(key), grid,
            self.paths["bmng-july-2004"],
            self.paths["etopo-2022-v1-ice-surface"],
            self.paths["etopo-2022-v1-geoid"],
            self.paths["gshhg-2.3.7"][0],
            self.paths["era5-monthly-1991-2020"][0])

    def climate_input(self, month, width, height):
        raise RendererUnavailable(
            "ERA5の月別window再格子化はRealSourceAdapterの次段で実装が必要です")


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
        if not isinstance(fixture, dict):
            raise ValueError("全球fixtureはJSONオブジェクトが必要です")
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
            if not isinstance(tile, dict):
                raise ValueError("fixtureタイルはJSONオブジェクトが必要です")
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
        self.adapter = RealSourceAdapter(manifest, raw_root)

    def render_tile(self, _key):
        raise RendererUnavailable(
            "実データrendererのBMNG/ETOPO/GSHHG window合成は未接続です。"
            "fixtureを実データとして扱わず、線形RGB・標高datum・面積被覆の合成を実装してください")

    def climate_maps(self):
        raise RendererUnavailable(
            "実データrendererのERA5月別window再格子化は未接続です。"
            "fixtureを実データとして扱わず、1991-2020全UTC時刻の平均を実装してください")


def create_fixture_renderer(manifest, fixture_path):
    return FixtureRenderer(manifest, FixtureSourceAdapter.from_path(manifest, fixture_path))


def create_real_renderer(manifest, raw_root):
    return RealDataRenderer(manifest, raw_root)
