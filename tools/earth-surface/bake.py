#!/usr/bin/env python3
"""明示された小領域の地理入力から、色・水域被覆・楕円体高・天体固定法線を生成する。"""

import argparse
from dataclasses import dataclass
import gzip
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import struct
import sys

_spec = importlib.util.spec_from_file_location("earth_surface_fetch", Path(__file__).with_name("fetch-source.py"))
_fetch = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_fetch)

# Float16のwire識別子。本文はIEEE 754 binary16、little-endian。
FLOAT16_SCALAR = 1
TERRAIN_HEADER = struct.Struct("<4sHHHHBBIIBBII")


@dataclass(frozen=True)
class Grid:
    """セル中心で標本化する正距円筒格子。経緯度の単位は度。"""

    west: float
    south: float
    east: float
    north: float
    width: int
    height: int

    # 小領域の有効範囲と正の格子寸法を検査する。
    def __post_init__(self):
        if not all(math.isfinite(value) for value in (self.west, self.south, self.east, self.north)):
            raise ValueError("格子座標は有限値が必要です")
        if not (0 < self.east - self.west <= 360 and -90 <= self.south < self.north <= 90):
            raise ValueError("格子の経緯度範囲が不正です")
        if any(type(value) is not int or not 1 <= value <= 260 for value in (self.width, self.height)):
            raise ValueError("小領域格子は各辺1..260セルが必要です")

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


# 球面セル交差で面積平均する。欠測や入力窓の不足は明示的に失敗する。
def regrid_mean(values, source_grid, target_grid):
    if len(values) != source_grid.width * source_grid.height or any(value is None or not math.isfinite(value) for value in values):
        raise ValueError("再格子化の入力に欠測があります")
    if source_grid == target_grid:
        return list(values)
    result = []
    for y in range(target_grid.height):
        for x in range(target_grid.width):
            target = target_grid.bounds(x, y)
            weighted, area = 0.0, 0.0
            for sy in range(source_grid.height):
                for sx in range(source_grid.width):
                    source = source_grid.bounds(sx, sy)
                    shift = 360 * round(((target[0] + target[2]) - (source[0] + source[2])) / 720)
                    overlap = max(target[0], source[0] + shift), max(target[1], source[1]), min(target[2], source[2] + shift), min(target[3], source[3])
                    if overlap[0] < overlap[2] and overlap[1] < overlap[3]:
                        weight = cell_area(overlap)
                        weighted += values[sy * source_grid.width + sx] * weight
                        area += weight
            if not math.isclose(area, cell_area(target), rel_tol=1e-9, abs_tol=1e-15):
                raise ValueError("再格子化の入力範囲が不足しています")
            result.append(weighted / area)
    return result


# sRGB8の色を線形RGBで面積平均し、sRGB8へ戻す。
def regrid_color(pixels, source_grid, target_grid):
    channels = []
    for channel in range(3):
        values = [pixel[channel] / 255 for pixel in pixels]
        linear = [value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4 for value in values]
        averaged = regrid_mean(linear, source_grid, target_grid)
        channels.append([round(255 * (12.92 * value if value <= 0.0031308 else 1.055 * value ** (1 / 2.4) - 0.055)) for value in averaged])
    return list(zip(*channels))


# 1991–2020の同月・全UTC24時刻がそろった2変数の平均を返す。
def era5_month_mean(records, month):
    expected = {(year, hour) for year in range(1991, 2021) for hour in range(24)}
    samples = {}
    for record in records:
        if record["month"] != month:
            raise ValueError("ERA5の月番号が不一致です")
        key = record["year"], record["hourUtc"]
        if key not in expected or key in samples:
            raise ValueError("ERA5の時刻が重複または期間外です")
        temperature, cloud = record["2m_temperature"], record["total_cloud_cover"]
        if temperature is None or cloud is None or not math.isfinite(temperature) or temperature <= 0 or not math.isfinite(cloud) or not 0 <= cloud <= 1:
            raise ValueError("ERA5の変数が欠測または単位範囲外です")
        samples[key] = temperature, cloud
    if not 1 <= month <= 12 or samples.keys() != expected:
        raise ValueError("ERA5は1991–2020各年の全24時刻が必要です")
    return tuple(math.fsum(samples[key][axis] for key in sorted(samples)) / len(expected) for axis in range(2))


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
    if value.get("schemaVersion") != 1 or value.get("kind") != "earth-surface-region-fixture":
        raise ValueError("小領域fixture形式が必要です")
    if value.get("datasetId") != manifest["datasetId"] or value.get("sourceManifestSha256") != _fetch.contract_hash(manifest):
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

    # 水域の値はDEMの符号によらず地理マスクから決める。
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
              "provenance": "synthetic_fixture", "sourceManifestSha256": value["sourceManifestSha256"],
              "grid": value["grid"], "axesM": axes, "colorSrgb": colors, "ellipsoidHeightM": heights,
              "orthometricHeightM": orthometric, "landFraction": land, "iceFraction": ice,
              "iceUnknownFraction": [max(0.0, dry - frozen) for dry, frozen in zip(land, ice)],
              "normals": normals, "roughness": roughness}
    if "era5" in value:
        climate = value["era5"]
        source = next(item for item in manifest["sources"] if item["id"] == climate["sourceId"])
        if source["id"] != "era5-monthly-1991-2020" or source["product"] != "monthly_averaged_reanalysis_by_hour_of_day":
            raise ValueError("ERA5のproductが不一致です")
        temperature, cloud = era5_month_mean(climate["records"], climate["month"])
        result["climateMonth"] = {"month": climate["month"], "temperatureK": temperature, "cloudFraction": cloud}
    return result


# 有効なタイル座標と260²のRGBA16Fから、32bytes固定ヘッダーを含む本文を作る。
def encode_terrain_tile(normals, roughness, z, x, y):
    if any(type(value) is not int for value in (z, x, y)) or not (0 <= z <= 7 and 0 <= x < 2 ** (z + 1) and 0 <= y < 2 ** z):
        raise ValueError("タイル座標が不正です")
    if len(normals) != 260 * 260 or len(roughness) != len(normals):
        raise ValueError("地形タイルはガター込み260×260が必要です")
    body = bytearray()
    for normal, material in zip(normals, roughness):
        if len(normal) != 3 or any(not math.isfinite(component) for component in normal) or not math.isclose(sum(component ** 2 for component in normal), 1, abs_tol=1e-6):
            raise ValueError("地形タイルに非単位法線があります")
        if not math.isfinite(material) or not 0 <= material <= 1:
            raise ValueError("roughnessは0..1が必要です")
        body.extend(struct.pack("<4e", *normal, material))
    return TERRAIN_HEADER.pack(b"ESTN", 1, 32, 260, 260, z, 0, x, y, 4, FLOAT16_SCALAR, len(body), 0) + body


# 形式・座標・長さ・hashを確かめ、Float16の法線とroughnessを検査する。
def validate_terrain_tile(payload, key, expected_sha):
    if len(payload) < 32 or hashlib.sha256(payload).hexdigest() != expected_sha:
        raise ValueError("地形本文の長さまたはhashが不一致です")
    magic, version, header_bytes, width, height, z, reserved, x, y, channels, scalar, data_bytes, reserved2 = TERRAIN_HEADER.unpack_from(payload)
    if (magic, version, header_bytes, width, height, channels, scalar, reserved, reserved2) != (b"ESTN", 1, 32, 260, 260, 4, FLOAT16_SCALAR, 0, 0):
        raise ValueError("地形ヘッダーが不正です")
    if (z, x, y) != tuple(key) or not (0 <= z <= 7 and x < 2 ** (z + 1) and y < 2 ** z):
        raise ValueError("地形ヘッダーのキーが不一致です")
    if data_bytes != 260 * 260 * 8 or len(payload) != 32 + data_bytes:
        raise ValueError("地形本文のバイト数が不一致です")
    for nx, ny, nz, material in struct.iter_unpack("<4e", payload[32:]):
        if not all(math.isfinite(component) for component in (nx, ny, nz, material)) or not math.isclose(nx * nx + ny * ny + nz * nz, 1, abs_tol=0.002) or not 0 <= material <= 1:
            raise ValueError("地形本文に無効な法線またはroughnessがあります")


# fixtureを中間JSONとRGB8 PPMへ出力する。タイルキー指定時はESTN本文も検査して保存する。
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--manifest", default="assets-src/earth-surface/sources.json")
    parser.add_argument("--output", default=".earth-surface/intermediate/region")
    parser.add_argument("--tile", nargs=3, type=int, metavar=("Z", "X", "Y"))
    args = parser.parse_args()
    manifest = _fetch.load_manifest(args.manifest)
    raw = Path(args.input).read_bytes()
    value = json.loads(raw)
    result = bake_region(value, manifest)
    result["fixtureSha256"] = hashlib.sha256(raw).hexdigest()
    grid = Grid(**value["grid"])
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    ppm = f"P6\n{grid.width} {grid.height}\n255\n".encode() + bytes(channel for pixel in result["colorSrgb"] for channel in pixel)
    (output / "color.ppm").write_bytes(ppm)
    result["files"] = [{"url": "color.ppm", "mime": "image/x-portable-pixmap", "encodedBytes": len(ppm), "payloadBytes": len(ppm), "sha256": hashlib.sha256(ppm).hexdigest()}]
    if args.tile:
        z, x, y = args.tile
        span = 180 / 2 ** z
        texel = span / 256
        expected = (-180 + x * span - 2 * texel, 90 - (y + 1) * span - 2 * texel,
                    -180 + (x + 1) * span + 2 * texel, 90 - y * span + 2 * texel)
        if grid.width != 260 or grid.height != 260 or any(not math.isclose(actual, wanted, abs_tol=1e-10) for actual, wanted in zip((grid.west, grid.south, grid.east, grid.north), expected)):
            raise ValueError("入力格子が指定タイルの2texelガター付き領域ではありません")
        payload = encode_terrain_tile(result["normals"], result["roughness"], *args.tile)
        digest = hashlib.sha256(payload).hexdigest()
        validate_terrain_tile(payload, args.tile, digest)
        encoded = gzip.compress(payload, mtime=0)
        (output / "normal-material.bin").write_bytes(payload)
        (output / "normal-material.bin.gz").write_bytes(encoded)
        result["files"].extend({"url": name, "mime": "application/octet-stream", "encodedBytes": length,
                                "payloadBytes": len(payload), "sha256": digest}
                               for name, length in (("normal-material.bin", len(payload)), ("normal-material.bin.gz", len(encoded))))
    (output / "region.json").write_text(json.dumps(result, ensure_ascii=False, sort_keys=True, allow_nan=False) + "\n")
    print(f"生成完了: {output / 'region.json'}")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError) as error:
        print(f"earth-surface:bake: {error}", file=sys.stderr)
        sys.exit(1)
