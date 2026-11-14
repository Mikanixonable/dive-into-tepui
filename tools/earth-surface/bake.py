#!/usr/bin/env python3
"""地理入力から色・水域被覆・楕円体高・天体固定法線を生成し、全球タイルbundleを書き出す。"""

import argparse
from dataclasses import dataclass
import gzip
import hashlib
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import shutil
import struct
import sys

from common import contract_hash, source_file_paths
from real_renderer import RendererUnavailable

_spec = importlib.util.spec_from_file_location("earth_surface_fetch", Path(__file__).with_name("fetch-source.py"))
_fetch = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_fetch)

# ESTN/ESTB v3は天体固定XYZ法線RGB8とroughness A8を持つ。
_LAYOUT = json.loads(Path(__file__).with_name("layout.json").read_text())
EARTH_BASE_COLOR_Z = _LAYOUT["baseColorZoom"]
EARTH_TILE_MIN_Z = _LAYOUT["minZoom"]
EARTH_TILE_MAX_Z = _LAYOUT["maxZoom"]
EARTH_TILE_TEXELS = _LAYOUT["tileTexels"]
EARTH_TILE_GUTTER = _LAYOUT["gutter"]
TERRAIN_FORMAT_VERSION = 3
UINT8_SCALAR = 2
TERRAIN_WIDTH = EARTH_TILE_TEXELS + 2 * EARTH_TILE_GUTTER
TERRAIN_HEIGHT = TERRAIN_WIDTH
TERRAIN_CHANNELS = _LAYOUT["terrainChannels"]
TERRAIN_TEXELS = TERRAIN_WIDTH * TERRAIN_HEIGHT
TERRAIN_BYTES = TERRAIN_TEXELS * TERRAIN_CHANNELS
# ESTN/ESTBは同一の32bytesヘッダーstructを共有する。
TERRAIN_HEADER = struct.Struct("<4sHHHHBBIIBBII")
BASE_COLOR_Z = EARTH_BASE_COLOR_Z
BASE_COLOR_ROOT_COUNT = 2 ** (BASE_COLOR_Z + 1) * 2 ** BASE_COLOR_Z
BASE_COLOR_TILE_TEXELS = EARTH_TILE_TEXELS
BASE_COLOR_GUTTER_TEXELS = EARTH_TILE_GUTTER
BASE_COLOR_TILE_SIZE = BASE_COLOR_TILE_TEXELS + 2 * BASE_COLOR_GUTTER_TEXELS
BASE_COLOR_WIDTH = 2 ** (BASE_COLOR_Z + 1) * BASE_COLOR_TILE_TEXELS
BASE_COLOR_HEIGHT = 2 ** BASE_COLOR_Z * BASE_COLOR_TILE_TEXELS


# 全球の正規化されたWeb Mercatorではなく、計画書の経緯度四分木キーを列挙する。
def global_tile_keys(max_zoom=EARTH_TILE_MAX_Z):
    if type(max_zoom) is not int or not EARTH_BASE_COLOR_Z <= max_zoom <= EARTH_TILE_MAX_Z:
        raise ValueError(f"max_zoomは{EARTH_BASE_COLOR_Z}..{EARTH_TILE_MAX_Z}の整数が必要です")
    return [(z, x, y) for z in range(EARTH_TILE_MIN_Z, max_zoom + 1)
            for y in range(2 ** z) for x in range(2 ** (z + 1))]


def base_color_tile_keys():
    """8K base colorを組み立てるz4の一時タイルキーを返す。"""
    return [(BASE_COLOR_Z, x, y) for y in range(2 ** BASE_COLOR_Z)
            for x in range(2 ** (BASE_COLOR_Z + 1))]


def tile_urls(key):
    """タイルキーに対応する色と地形の相対URLを返す。"""
    z, x, y = key
    return f"tiles/{z}/{x}/{y}.jpg", f"tiles/{z}/{x}/{y}.bin.gz"


def global_tile_count(max_zoom=EARTH_TILE_MAX_Z):
    return len(global_tile_keys(max_zoom))


def tile_grid(z, x, y, gutter=EARTH_TILE_GUTTER):
    """タイル内側の固定texelとgutterを含むセル中心格子を返す。"""
    if (type(z) is not int or type(x) is not int or type(y) is not int
            or not (0 <= z <= EARTH_TILE_MAX_Z and 0 <= x < 2 ** (z + 1) and 0 <= y < 2 ** z)):
        raise ValueError("タイル座標が不正です")
    width = 180 / 2 ** z
    height = 180 / 2 ** z
    step = width / EARTH_TILE_TEXELS
    return Grid(-180 + x * width - gutter * step, 90 - (y + 1) * height - gutter * step,
                -180 + (x + 1) * width + gutter * step, 90 - y * height + gutter * step,
                EARTH_TILE_TEXELS + 2 * gutter, EARTH_TILE_TEXELS + 2 * gutter, True)


@dataclass(frozen=True)
class Grid:
    """セル中心で標本化する正距円筒格子。経緯度の単位は度。"""

    west: float
    south: float
    east: float
    north: float
    width: int
    height: int
    allow_gutter: bool = False

    # 小領域の有効範囲と正の格子寸法を検査する。
    def __post_init__(self):
        if not all(math.isfinite(value) for value in (self.west, self.south, self.east, self.north)):
            raise ValueError("格子座標は有限値が必要です")
        longitude_limit = 364 if self.allow_gutter else 360
        latitude_valid = (-92 <= self.south < self.north <= 92 if self.allow_gutter
                          else -90 <= self.south < self.north <= 90)
        if not (0 < self.east - self.west <= longitude_limit and latitude_valid):
            raise ValueError("格子の経緯度範囲が不正です")
        if any(type(value) is not int or not 1 <= value <= TERRAIN_WIDTH for value in (self.width, self.height)):
            raise ValueError(f"小領域格子は各辺1..{TERRAIN_WIDTH}セルが必要です")

    # 指定セルの西・南・東・北端を返す。
    def bounds(self, x, y):
        dx, dy = (self.east - self.west) / self.width, (self.north - self.south) / self.height
        return self.west + x * dx, self.north - (y + 1) * dy, self.west + (x + 1) * dx, self.north - y * dy

    # セル中心の経緯度をラジアンで返す。
    def center(self, x, y):
        west, south, east, north = self.bounds(x, y)
        return math.radians((west + east) / 2), math.radians((south + north) / 2)

    # 全球格子では日付変更線と極を連続化し、入力窓の外ではNoneを返す。
    def neighbor(self, x, y):
        global_longitude = self.east - self.west == 360
        if y == -1 and self.north == 90 and global_longitude and self.width % 2 == 0:
            x, y = x + self.width // 2, 0
        if y == self.height and self.south == -90 and global_longitude and self.width % 2 == 0:
            x, y = x + self.width // 2, self.height - 1
        if global_longitude:
            x %= self.width
        return (x, y) if 0 <= x < self.width and 0 <= y < self.height else None


# 単位球上の緯経度セル面積を返す。半径²は比の計算で相殺される。
def cell_area(bounds):
    west, south, east, north = bounds
    return math.radians(east - west) * (math.sin(math.radians(north)) - math.sin(math.radians(south)))


# 緯経度平面の線形辺で囲まれた多角形を、球面の面積要素で積分する。
def polygon_area(ring):
    area = 0.0
    for first, second in zip(ring, ring[1:] + ring[:1]):
        lon1, lat1 = map(math.radians, first)
        lon2, lat2 = map(math.radians, second)
        average_sin = (math.cos(lat1) - math.cos(lat2)) / (lat2 - lat1) if lat1 != lat2 else math.sin(lat1)
        area += (lon2 - lon1) * average_sin
    return abs(area)


# 一つの軸境界に沿って多角形を切り、球面積分できる輪郭を返す。
def clip_edge(ring, axis, boundary, keep_greater):
    result = []
    for start, end in zip(ring, ring[1:] + ring[:1]):
        start_inside = start[axis] >= boundary if keep_greater else start[axis] <= boundary
        end_inside = end[axis] >= boundary if keep_greater else end[axis] <= boundary
        if start_inside != end_inside:
            fraction = (boundary - start[axis]) / (end[axis] - start[axis])
            result.append(tuple(start[i] + fraction * (end[i] - start[i]) for i in range(2)))
        if end_inside:
            result.append(end)
    return result


# 日付変更線をまたぐ輪郭をセル付近へ展開して交差面積を求める。
def polygon_cell_area(coordinates, bounds):
    if len(coordinates) < 4 or coordinates[0] != coordinates[-1]:
        raise ValueError("GSHHG輪郭は閉じた4頂点以上が必要です")
    ring = [tuple(coordinates[0])]
    for previous, (lon, lat) in zip(coordinates, coordinates[1:]):
        if not math.isfinite(lon) or not math.isfinite(lat) or not -90 <= lat <= 90:
            raise ValueError("ポリゴン座標が不正です")
        delta = lon - previous[0]
        if 180 < abs(delta) < 360:
            delta -= math.copysign(360, delta)
        ring.append((ring[-1][0] + delta, lat))
    west, south, east, north = bounds
    start = math.floor((west - max(point[0] for point in ring)) / 360)
    end = math.ceil((east - min(point[0] for point in ring)) / 360)
    total = 0.0
    for shift in range(start, end + 1):
        clipped = [(lon + shift * 360, lat) for lon, lat in ring]
        for axis, boundary, greater in ((0, west, True), (0, east, False), (1, south, True), (1, north, False)):
            clipped = clip_edge(clipped, axis, boundary, greater)
        if len(clipped) >= 3:
            total += polygon_area(clipped)
    return total


# GSHHGの階層から陸被覆率とL5の明示的な氷被覆率を求める。
def coverage(grid, polygons):
    land, ice = [], []
    signs = {1: 1, 2: -1, 3: 1, 4: -1, 5: 1}
    for polygon in polygons:
        if polygon.get("level") not in range(1, 7):
            raise ValueError("GSHHGの階層が不正です")
    for y in range(grid.height):
        for x in range(grid.width):
            bounds = grid.bounds(x, y)
            land_area, ice_area = 0.0, 0.0
            for polygon in polygons:
                level = polygon["level"]
                if level == 6:
                    continue
                area = polygon_cell_area(polygon["coordinates"], bounds)
                land_area += signs[level] * area
                if level == 5:
                    ice_area += area
            denominator = cell_area(bounds)
            fraction, frozen = land_area / denominator, ice_area / denominator
            if not (-1e-9 <= frozen <= fraction + 1e-9 and -1e-9 <= fraction <= 1 + 1e-9):
                raise ValueError("GSHHG包含関係が重複または不整合です")
            fraction = min(1.0, max(0.0, fraction))
            frozen = min(1.0, max(0.0, frozen))
            land.append(1.0 if math.isclose(fraction, 1.0, abs_tol=1e-9) else fraction)
            ice.append(1.0 if math.isclose(frozen, 1.0, abs_tol=1e-9) else frozen)
    return land, ice


# 地理緯経度の東・北・上を、天体固定XYZへ変換する。
def basis(lon, lat):
    return ((math.cos(lon), 0.0, -math.sin(lon)),
            (-math.sin(lat) * math.sin(lon), math.cos(lat), -math.sin(lat) * math.cos(lon)),
            (math.cos(lat) * math.sin(lon), math.sin(lat), math.cos(lat) * math.cos(lon)))


# 任意の半軸に対し、指定した幾何法線を持つ楕円体上の位置[m]を返す。
def ellipsoid_position(up, axes):
    denominator = math.sqrt(sum((axis * value) ** 2 for axis, value in zip(axes, up)))
    return tuple(axis * axis * value / denominator for axis, value in zip(axes, up))


# 有限な非零ベクトルを単位化する。
def normalize(vector):
    length = math.sqrt(sum(value * value for value in vector))
    if not math.isfinite(length) or length == 0:
        raise ValueError("法線が有限な非零ベクトルではありません")
    return tuple(value / length for value in vector)


# 有効な陸上近傍を局所接平面へ投影して勾配を求める。
def slope(grid, x, y, direction, axis, heights, land, axes):
    center = y * grid.width + x
    origin = ellipsoid_position(basis(*grid.center(x, y))[2], axes)
    samples = []
    for sign in (-1, 1):
        neighbor = grid.neighbor(x + sign * direction[0], y + sign * direction[1])
        if neighbor is None:
            continue
        nx, ny = neighbor
        index = ny * grid.width + nx
        if land[index] <= 0 or heights[index] is None:
            continue
        position = ellipsoid_position(basis(*grid.center(nx, ny))[2], axes)
        distance = sum((value - start) * component for value, start, component in zip(position, origin, axis))
        if abs(distance) > 1e-8:
            samples.append((distance, heights[index]))
    if len(samples) == 2:
        denominator = samples[1][0] - samples[0][0]
        return (samples[1][1] - samples[0][1]) / denominator if abs(denominator) > 1e-8 else None
    if samples:
        return (samples[0][1] - heights[center]) / samples[0][0]
    return None


# 水底と欠測を陸上勾配から除き、部分セルは被覆率で幾何法線へ混合する。
def terrain_normals(grid, heights, land, axes):
    result = []
    for y in range(grid.height):
        for x in range(grid.width):
            index = y * grid.width + x
            east, north, up = basis(*grid.center(x, y))
            if land[index] <= 0 or heights[index] is None:
                result.append(up)
                continue
            dx = slope(grid, x, y, (1, 0), east, heights, land, axes)
            dy = slope(grid, x, y, (0, -1), north, heights, land, axes)
            if dx is None or dy is None:
                result.append(up)
                continue
            sloped = normalize(tuple(u - dx * e - dy * n for u, e, n in zip(up, east, north)))
            result.append(normalize(tuple(land[index] * tilted + (1 - land[index]) * geometric
                                          for tilted, geometric in zip(sloped, up))))
    return result


# fixtureの同一格子入力を検査して、独立して再検査できる中間結果を返す。
def bake_region(value, manifest):
    if value.get("schemaVersion") != 1 or value.get("kind") not in (
            "earth-surface-region-fixture", "earth-surface-region-window"):
        raise ValueError("小領域fixtureまたはwindow形式が必要です")
    if value.get("datasetId") != manifest["datasetId"] or value.get("sourceManifestSha256") != contract_hash(manifest):
        raise ValueError("fixtureとソースマニフェストの版が不一致です")
    if value.get("surfaceSourceId") != "etopo-2022-v1-ice-surface" or value.get("geoidSourceId") != "etopo-2022-v1-geoid":
        raise ValueError("ETOPO ice-surfaceと対応するgeoidが必要です")
    grid = Grid(**value["grid"])
    count = grid.width * grid.height
    axes = value["axesM"]
    if len(axes) != 3 or any(not math.isfinite(axis) or axis <= 0 for axis in axes):
        raise ValueError("楕円体半軸は正の有限値[m]が必要です")
    colors, surface, geoid = (value[name] for name in ("colorSrgb", "iceSurfaceM", "geoidM"))
    if any(len(field) != count for field in (colors, surface, geoid)):
        raise ValueError("入力セル数が格子寸法と不一致です")
    if any(len(pixel) != 3 or any(type(channel) is not int or not 0 <= channel <= 255 for channel in pixel) for pixel in colors):
        raise ValueError("colorSrgbはRGB8が必要です")

    # 水域の値はDEMの符号によらず地理マスクから決める。実データrendererは
    # GSHHGを空間索引で積分済みなので、同じセルで二重計算しない。
    if "landFraction" in value and "iceFraction" in value:
        land, ice = value["landFraction"], value["iceFraction"]
        if (len(land) != count or len(ice) != count
                or any(not math.isfinite(item) or not 0 <= item <= 1 for item in land + ice)):
            raise ValueError("事前計算されたGSHHG被覆率が不正です")
    else:
        land, ice = coverage(grid, value["gshhgPolygons"])
    nodata = {source["id"]: source["noData"] for source in manifest["sources"]}
    heights, orthometric = [], []
    for index, (height, geoid_height) in enumerate(zip(surface, geoid)):
        valid = (height is not None and geoid_height is not None
                 and math.isfinite(height) and math.isfinite(geoid_height)
                 and height != nodata[value["surfaceSourceId"]] and geoid_height != nodata[value["geoidSourceId"]])
        heights.append(height + geoid_height if land[index] > 0 and valid else None)
        orthometric.append((height if valid else None) if land[index] > 0 else 0.0)
    normals = terrain_normals(grid, heights, land, axes)
    classes = manifest["roughness"]
    roughness = [classes["water"] * (1 - dry) + classes["land"] * (dry - frozen) + classes["ice"] * frozen
                 for dry, frozen in zip(land, ice)]
    result = {"schemaVersion": 1, "datasetId": manifest["datasetId"], "kind": "earth-surface-region-intermediate",
              "provenance": "synthetic_fixture" if value["kind"] == "earth-surface-region-fixture" else "source_window",
              "sourceManifestSha256": value["sourceManifestSha256"],
              "grid": value["grid"], "axesM": axes, "colorSrgb": colors, "ellipsoidHeightM": heights,
              "orthometricHeightM": orthometric, "landFraction": land, "iceFraction": ice,
              "iceUnknownFraction": [max(0.0, dry - frozen) for dry, frozen in zip(land, ice)],
              "normals": normals, "roughness": roughness}
    return result


def encode_xyz_normal(normal):
    """単位法線を天体固定XYZのRGB8へ量子化する。"""
    if (len(normal) != 3 or any(not math.isfinite(component) for component in normal)
            or not math.isclose(sum(component ** 2 for component in normal), 1, abs_tol=1e-6)):
        raise ValueError("地形タイルに非単位法線があります")
    return tuple(max(0, min(255, int(round((component * 0.5 + 0.5) * 255))))
                 for component in normal)


def decode_xyz_normal(encoded):
    """天体固定XYZのRGB8を単位法線へ復号する。"""
    if len(encoded) != 3 or any(type(value) is not int or not 0 <= value <= 255 for value in encoded):
        raise ValueError("XYZ法線はRGB8が必要です")
    return normalize(tuple(2 * value / 255 - 1 for value in encoded))


# 有効なタイル座標と4 byte/texelから、32bytes固定ヘッダーを含む本文を作る。
def encode_terrain_tile(normals, roughness, z, x, y):
    if any(type(value) is not int for value in (z, x, y)) or not (0 <= z <= EARTH_TILE_MAX_Z and 0 <= x < 2 ** (z + 1) and 0 <= y < 2 ** z):
        raise ValueError("タイル座標が不正です")
    if len(normals) != TERRAIN_TEXELS or len(roughness) != len(normals):
        raise ValueError("地形タイルはガター込み260×260が必要です")
    body = bytearray()
    for normal, material in zip(normals, roughness):
        red, green, blue = encode_xyz_normal(normal)
        if not math.isfinite(material) or not 0 <= material <= 1:
            raise ValueError("roughnessは0..1が必要です")
        body.extend((red, green, blue, max(0, min(255, int(round(material * 255))))))
    return TERRAIN_HEADER.pack(b"ESTN", TERRAIN_FORMAT_VERSION, 32, TERRAIN_WIDTH, TERRAIN_HEIGHT,
                               z, 0, x, y, TERRAIN_CHANNELS, UINT8_SCALAR, len(body), 0) + body


# 形式・座標・長さ・hashを確かめ、法線と量子化値を検査する。
def validate_terrain_tile(payload, key, expected_sha):
    if len(payload) < 32 or hashlib.sha256(payload).hexdigest() != expected_sha:
        raise ValueError("地形本文の長さまたはhashが不一致です")
    magic, version, header_bytes, width, height, z, reserved, x, y, channels, scalar, data_bytes, reserved2 = TERRAIN_HEADER.unpack_from(payload)
    if (magic, version, header_bytes, width, height, channels, scalar, reserved, reserved2) != (b"ESTN", TERRAIN_FORMAT_VERSION, 32, TERRAIN_WIDTH, TERRAIN_HEIGHT, TERRAIN_CHANNELS, UINT8_SCALAR, 0, 0):
        raise ValueError("地形ヘッダーが不正です")
    if (z, x, y) != tuple(key) or not (0 <= z <= EARTH_TILE_MAX_Z and x < 2 ** (z + 1) and y < 2 ** z):
        raise ValueError("地形ヘッダーのキーが不一致です")
    if data_bytes != TERRAIN_BYTES or len(payload) != 32 + data_bytes:
        raise ValueError("地形本文のバイト数が不一致です")
    for red, green, blue, material in struct.iter_unpack("<4B", payload[32:]):
        normal = decode_xyz_normal((red, green, blue))
        if not all(math.isfinite(component) for component in normal) or not 0 <= material <= 255:
            raise ValueError("地形本文に無効な法線またはroughnessがあります")


def encode_base_terrain(terrain_payloads):
    """z=0の2枚のESTN本文をまとめたESTB。header後はESTN payloadを順番に格納する。"""
    if len(terrain_payloads) != 2:
        raise ValueError("base ESTBはz=0の2枚のroot payloadが必要です")
    for x, payload in enumerate(terrain_payloads):
        validate_terrain_tile(payload, (0, x, 0), hashlib.sha256(payload).hexdigest())
    body = b"".join(terrain_payloads)
    header = TERRAIN_HEADER.pack(b"ESTB", TERRAIN_FORMAT_VERSION, 32, TERRAIN_WIDTH, TERRAIN_HEIGHT, 0, 0, 2, 1,
                                 TERRAIN_HEADER.unpack_from(terrain_payloads[0])[9],
                                 UINT8_SCALAR, len(body), 0)
    return header + body


def validate_base_terrain(payload, expected_root_count=2):
    if len(payload) < TERRAIN_HEADER.size:
        raise ValueError("ESTB headerが短すぎます")
    magic, version, header_bytes, width, height, z, reserved, columns, rows, channels, scalar, data_bytes, reserved2 = TERRAIN_HEADER.unpack_from(payload)
    if (magic, version, header_bytes, width, height, z, reserved, columns, rows, channels, scalar, reserved2) != (
            b"ESTB", TERRAIN_FORMAT_VERSION, 32, TERRAIN_WIDTH, TERRAIN_HEIGHT, 0, 0, 2, 1,
            TERRAIN_CHANNELS, UINT8_SCALAR, 0):
        raise ValueError("ESTB headerが不正です")
    expected = expected_root_count * TERRAIN_HEADER.size + expected_root_count * TERRAIN_BYTES
    if data_bytes != expected or len(payload) != TERRAIN_HEADER.size + expected:
        raise ValueError("ESTB payload長が不正です")
    return {"rootColumns": columns, "rootRows": rows, "payloadBytes": data_bytes}


def _decode_jpeg(data, size, label):
    """指定寸法・RGBモードのJPEGを検証して、閉じた画像を返す。"""
    if not isinstance(data, (bytes, bytearray)):
        raise ValueError(f"{label}はJPEG bytesが必要です")
    try:
        from PIL import Image
    except ImportError as error:
        raise RuntimeError("地表base colorのJPEG処理にはPillowが必要です") from error
    try:
        image = Image.open(io.BytesIO(bytes(data)))
    except (OSError, ValueError) as error:
        raise ValueError(f"{label}をJPEGとして読み込めません") from error
    with image:
        if image.format != "JPEG":
            raise ValueError(f"{label}はJPEGが必要です")
        if image.size != size:
            raise ValueError(f"{label}は{size[0]}x{size[1]}が必要です")
        if image.mode != "RGB":
            raise ValueError(f"{label}はRGBモードが必要です")
        try:
            image.load()
        except (OSError, ValueError) as error:
            raise ValueError(f"{label}をJPEGとしてデコードできません") from error
        return image.copy()


def encode_base_color(tile_colors, base_color=None):
    """z4の512枚からgutterを除いた8192x4096の全球RGB JPEGを作る。"""
    if base_color is not None:
        try:
            data = bytes(base_color)
        except (TypeError, ValueError) as error:
            raise ValueError("base_colorはJPEG bytesが必要です") from error
        _decode_jpeg(data, (BASE_COLOR_WIDTH, BASE_COLOR_HEIGHT), "base_color").close()
        return data
    if len(tile_colors) != BASE_COLOR_ROOT_COUNT:
        raise ValueError("base colorにはz4の512枚のtile JPEGが必要です")
    image = None
    try:
        from PIL import Image
        image = Image.new("RGB", (BASE_COLOR_WIDTH, BASE_COLOR_HEIGHT))
        interior = (BASE_COLOR_GUTTER_TEXELS, BASE_COLOR_GUTTER_TEXELS,
                    BASE_COLOR_GUTTER_TEXELS + BASE_COLOR_TILE_TEXELS,
                    BASE_COLOR_GUTTER_TEXELS + BASE_COLOR_TILE_TEXELS)
        columns = 2 ** (BASE_COLOR_Z + 1)
        for index, color in enumerate(tile_colors):
            x, y = index % columns, index // columns
            tile = _decode_jpeg(color, (BASE_COLOR_TILE_SIZE, BASE_COLOR_TILE_SIZE),
                                f"z={BASE_COLOR_Z}/{x}/{y} color")
            try:
                image.paste(tile.crop(interior), (x * BASE_COLOR_TILE_TEXELS, y * BASE_COLOR_TILE_TEXELS))
            finally:
                tile.close()
        output = io.BytesIO()
        image.save(output, format="JPEG", quality=90, optimize=False,
                   progressive=False, subsampling=0)
        return output.getvalue()
    finally:
        if image is not None:
            image.close()

def climate_channel(value, minimum, maximum):
    if not math.isfinite(value) or not minimum <= value <= maximum:
        raise ValueError("気候値が契約範囲外です")
    return round(255 * (value - minimum) / (maximum - minimum))


def encode_climate_rgba(temperature, cloud, elevation, land, width=1024, height=512):
    """気候4チャンネルを決定的なRGBA8 PNGの画素列へ変換する。"""
    count = width * height
    if any(len(channel) != count for channel in (temperature, cloud, elevation, land)):
        raise ValueError("気候mapの配列寸法が不一致です")
    pixels = bytearray()
    for values in zip(temperature, cloud, elevation, land):
        pixels.extend((climate_channel(values[0], 180, 330), climate_channel(values[1], 0, 1),
                       climate_channel(values[2], -1000, 9000), climate_channel(values[3], 0, 1)))
    try:
        from PIL import Image
    except ImportError as error:
        raise RuntimeError("気候mapのPNG出力にはPillowが必要です") from error
    image = Image.frombytes("RGBA", (width, height), bytes(pixels))
    output = io.BytesIO()
    image.save(output, format="PNG", optimize=False, compress_level=9)
    return output.getvalue()


class GlobalInputError(RuntimeError):
    """全球生成に必要な入力または実データrendererが不足している。"""


def global_input_paths(manifest, raw_root):
    """manifestから必要入力のパスだけを列挙する。入力内容はメモリへ展開しない。"""
    return [path for source in manifest["sources"] for path in source_file_paths(raw_root, source)]


def require_global_inputs(manifest, raw_root):
    missing = [path for path in global_input_paths(manifest, raw_root) if not path.is_file()]
    if missing:
        preview = ", ".join(str(path) for path in missing[:8])
        more = "" if len(missing) <= 8 else f" (+{len(missing) - 8}件)"
        raise GlobalInputError(f"全球bundleの入力が不足しています: {preview}{more}")


def global_manifest(manifest, source_manifest_path, source_manifest_hash, climate_paths, coverage_kind="complete",
                    max_zoom=EARTH_TILE_MAX_Z, data_provenance="source"):
    """配信契約の正本を生成する。実体hashはtile writerが逐次追加する。"""
    attribution = []
    for source in manifest["sources"]:
        attribution.extend(source["attribution"])
    return {
        "schemaVersion": 3,
        "datasetId": manifest["datasetId"],
        "sourceManifestSha256": source_manifest_hash,
        "sourceManifest": source_manifest_path,
        "provenance": {"generator": "earth-surface-bundle/3", "sourceManifestHash": source_manifest_hash,
                        "dataKind": data_provenance},
        "colorCalibration": manifest["colorCalibration"],
        "terrainEncoding": {"formatVersion": TERRAIN_FORMAT_VERSION,
                             "layout": "normal-xyz-rgb8-roughness-a8",
                             "width": TERRAIN_WIDTH, "height": TERRAIN_HEIGHT,
                             "channels": TERRAIN_CHANNELS, "scalar": "UInt8",
                             "normalFrame": "body_fixed"},
        "climateMap": manifest["climateMap"],
        "controlRegions": manifest["controlRegions"],
        "coverage": {"kind": coverage_kind, "minZoom": EARTH_TILE_MIN_Z,
                      "maxZoom": max(EARTH_TILE_MIN_Z, max_zoom),
                      "expectedTiles": global_tile_count(max_zoom) if coverage_kind == "complete" else None},
        "baseColor": "base/earth.jpg",
        "baseTerrain": "base/earth.bin.gz",
        "tileTemplates": {"color": "tiles/{z}/{x}/{y}.jpg", "terrain": "tiles/{z}/{x}/{y}.bin.gz"},
        "climateMaps": climate_paths,
        "climateEncoding": {"temperatureK": {"min": 180, "max": 330}, "cloudFraction": {"min": 0, "max": 1},
                             "orthometricElevation": {"min": -1000, "max": 9000}, "landFraction": {"min": 0, "max": 1},
                             "waterOrthometricElevationM": 0},
        "attribution": sorted(set(attribution)),
    }


def write_global_bundle(manifest, source_manifest_path, raw_root, output_root, render_tile,
                        climate_maps, base_color=None, max_zoom=EARTH_TILE_MAX_Z, validate_inputs=True,
                        data_provenance="source"):
    """各タイルを一枚ずつ生成し、stagingへ書き込む全球bundle writer。"""
    if validate_inputs:
        require_global_inputs(manifest, raw_root)
    if type(max_zoom) is not int or not EARTH_BASE_COLOR_Z <= max_zoom <= EARTH_TILE_MAX_Z:
        raise ValueError(f"max_zoomは{EARTH_BASE_COLOR_Z}..{EARTH_TILE_MAX_Z}の整数が必要です")
    output = Path(output_root)
    staging = output.with_name(f"{output.name}.staging-{os.getpid()}")
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    source_hash = contract_hash(manifest)
    climate_paths = [f"climate/{month:02d}.png" for month in range(1, 13)]
    source_manifest_file = Path(source_manifest_path)
    if not source_manifest_file.is_file():
        raise GlobalInputError(f"source manifestがありません: {source_manifest_path}")
    coverage_kind = "complete" if max_zoom == EARTH_TILE_MAX_Z else "sparse"
    result_manifest = global_manifest(manifest, "sources.json", source_hash, climate_paths,
                                      coverage_kind, max_zoom, data_provenance)
    try:
        climate_values = list(climate_maps)
        if (len(climate_values) != 12 or any(not isinstance(value, (bytes, bytearray)) or not value
                                             or bytes(value[:8]) != b"\x89PNG\r\n\x1a\n" for value in climate_values)):
            raise ValueError("気候mapは12個のPNG bytesが必要です")
        for path, data in zip(climate_paths, climate_values):
            destination = staging / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
        (staging / "sources.json").write_bytes(source_manifest_file.read_bytes())

        base_color_tiles = []
        for key in base_color_tile_keys():
            color, _ = render_tile(key)
            if (not isinstance(color, (bytes, bytearray)) or len(color) < 4
                    or bytes(color[:2]) != b"\xff\xd8" or bytes(color[-2:]) != b"\xff\xd9"):
                raise ValueError(f"base color rendererがJPEGを返しませんでした: {key}")
            base_color_tiles.append(bytes(color))
        for key in global_tile_keys(max_zoom):
            color, terrain = render_tile(key)
            if (not isinstance(color, (bytes, bytearray)) or len(color) < 4
                    or bytes(color[:2]) != b"\xff\xd8" or bytes(color[-2:]) != b"\xff\xd9"):
                raise ValueError(f"color rendererがJPEGを返しませんでした: {key}")
            validate_terrain_tile(terrain, key, hashlib.sha256(terrain).hexdigest())
            color_url, terrain_url = tile_urls(key)
            color_path = staging / color_url
            terrain_path = staging / terrain_url
            color_path.parent.mkdir(parents=True, exist_ok=True)
            color_path.write_bytes(color)
            encoded = gzip.compress(terrain, mtime=0)
            terrain_path.write_bytes(encoded)
        if len(base_color_tiles) != BASE_COLOR_ROOT_COUNT:
            raise ValueError("base colorにはz4の512枚が必要です")
        base = staging / "base"
        base.mkdir(parents=True, exist_ok=True)
        base_color_data = encode_base_color(base_color_tiles, base_color)
        (base / "earth.jpg").write_bytes(base_color_data)
        base_roots = [render_tile((0, x, 0))[1] for x in (0, 1)]
        for x, terrain in enumerate(base_roots):
            validate_terrain_tile(terrain, (0, x, 0), hashlib.sha256(terrain).hexdigest())
        base_payload = encode_base_terrain(base_roots)
        (base / "earth.bin.gz").write_bytes(gzip.compress(base_payload, mtime=0))
        (staging / "earth-surface.json").write_text(json.dumps(result_manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n")
        (staging / "attribution.json").write_text(json.dumps({"datasetId": manifest["datasetId"], "attribution": result_manifest["attribution"]}, ensure_ascii=False, indent=2) + "\n")
        if output.exists():
            shutil.rmtree(output)
        staging.rename(output)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return result_manifest


# 実データまたはsynthetic fixtureから全球bundleを生成する入口。
def main():
    from real_renderer import create_fixture_renderer, create_real_renderer

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--global", action="store_true", dest="global_bundle",
                        help=f"z{EARTH_TILE_MIN_Z}..z{EARTH_TILE_MAX_Z}の全{global_tile_count()}タイルbundle生成入口。入力不足は生成前に失敗する")
    parser.add_argument("--fixture-global", metavar="PATH",
                        help="明示したsynthetic fixtureから小さなbundleを生成するテスト入口")
    parser.add_argument("--raw-root", default=".earth-surface/raw")
    parser.add_argument("--manifest", default="assets-src/earth-surface/sources.json")
    parser.add_argument("--output", default=".earth-surface/intermediate/region")
    parser.add_argument("--max-zoom", type=int, default=EARTH_TILE_MAX_Z)
    args = parser.parse_args()
    manifest = _fetch.load_manifest(args.manifest)
    if args.global_bundle and args.fixture_global:
        parser.error("--globalと--fixture-globalは併用できません")
    if args.fixture_global:
        renderer = create_fixture_renderer(manifest, args.fixture_global)
        climate_maps = renderer.climate_maps()
        write_global_bundle(manifest, args.manifest, args.raw_root, args.output,
                            renderer.render_tile, climate_maps, max_zoom=args.max_zoom,
                            validate_inputs=False, data_provenance="synthetic_fixture")
        print(f"fixture全球bundle生成完了: {args.output}")
        return
    if args.global_bundle:
        renderer = create_real_renderer(manifest, args.raw_root)
        write_global_bundle(manifest, args.manifest, args.raw_root, args.output,
                            renderer.render_tile, renderer.climate_maps(), max_zoom=args.max_zoom)
        print(f"全球bundle生成完了: {args.output}")
        return
    parser.error("--globalまたは--fixture-globalが必要です")


if __name__ == "__main__":
    try:
        main()
    except (GlobalInputError, RendererUnavailable, ValueError, KeyError, OSError) as error:
        print(f"earth-surface:bake: {error}", file=sys.stderr)
        sys.exit(1)
