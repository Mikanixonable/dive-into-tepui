"""実データを有限メモリで全球タイル格子へ再格子化する部品。"""

from dataclasses import dataclass
import math
from pathlib import Path

import numpy as np


@dataclass(frozen=True)
class OutputGrid:
    """全球気候map用の正距円筒格子（タイルの260セル制約を持たない）。"""

    west: float
    south: float
    east: float
    north: float
    width: int
    height: int
    allow_gutter: bool = False

    def bounds(self, x, y):
        dx = (self.east - self.west) / self.width
        dy = (self.north - self.south) / self.height
        return self.west + x * dx, self.north - (y + 1) * dy, self.west + (x + 1) * dx, self.north - y * dy


def _cell_area(west, south, east, north):
    return math.radians(east - west) * (math.sin(math.radians(north)) - math.sin(math.radians(south)))


def _linear_to_srgb(value):
    return 12.92 * value if value <= 0.0031308 else 1.055 * value ** (1 / 2.4) - 0.055


@dataclass(frozen=True)
class _RasterInfo:
    path: Path
    dataset: object
    width: int
    height: int
    transform: tuple
    point: bool
    nodata: tuple

    @property
    def west(self):
        return self.transform[0]

    @property
    def east(self):
        return self.transform[0] + self.transform[1] * self.width

    @property
    def north(self):
        return self.transform[3]

    @property
    def south(self):
        return self.transform[3] + self.transform[5] * self.height


class RasterCatalog:
    """同一規則のGeoTIFF群をtarget gridへ面積加重で読む。"""

    def __init__(self, paths, *, color=False):
        try:
            from osgeo import gdal
        except ImportError as error:
            raise RuntimeError("実データ再格子化にはGDALが必要です") from error
        gdal.UseExceptions()
        # GDALの既定キャッシュは入力GeoTIFF総量に比例して膨らむため、
        # タイル単位のストリーミングを維持できる上限へ固定する。
        gdal.SetCacheMax(256 * 1024 * 1024)
        self.color = color
        self.entries = []
        for path in paths:
            dataset = gdal.Open(str(path), gdal.GA_ReadOnly)
            if dataset is None:
                raise ValueError(f"GeoTIFFを開けません: {path}")
            transform = dataset.GetGeoTransform()
            if (len(transform) != 6 or transform[2] != 0 or transform[4] != 0
                    or transform[1] <= 0 or transform[5] >= 0):
                raise ValueError(f"north-up GeoTIFFが必要です: {path}")
            projection = dataset.GetProjectionRef()
            if "4326" not in projection and "WGS 84" not in projection:
                raise ValueError(f"GeoTIFFのCRSがEPSG:4326ではありません: {path}")
            metadata = dataset.GetMetadataItem("AREA_OR_POINT")
            bands = tuple(dataset.GetRasterBand(index) for index in range(1, dataset.RasterCount + 1))
            self.entries.append(_RasterInfo(Path(path), dataset, dataset.RasterXSize, dataset.RasterYSize,
                                             transform, metadata == "Point",
                                             tuple(band.GetNoDataValue() for band in bands)))
        if not self.entries:
            raise ValueError("再格子化するGeoTIFFがありません")
        channels = self.entries[0].dataset.RasterCount
        if color and channels != 3:
            raise ValueError("BMNGはRGB 3バンドが必要です")
        if not color and channels != 1:
            raise ValueError("地形GeoTIFFは1バンドが必要です")
        if any(entry.dataset.RasterCount != channels for entry in self.entries):
            raise ValueError("GeoTIFF群のバンド数が不一致です")
        self.channels = channels

    @staticmethod
    def _axis_cells(entry, axis, start, count):
        transform = entry.transform
        if axis == "x":
            origin, step = transform[0], transform[1]
            extent = (entry.west, entry.east)
        else:
            origin, step = transform[3], transform[5]
            extent = (entry.south, entry.north)
        cells = []
        for index in range(start, start + count):
            center = origin + (index + (0.5 if not entry.point else 0.0)) * step
            half = abs(step) / 2
            low, high = center - half, center + half
            low, high = max(low, extent[0]), min(high, extent[1])
            if low < high:
                cells.append((low, high))
            else:
                cells.append((min(extent), max(extent)))
        return cells

    @staticmethod
    def _candidate_range(entry, grid, shift):
        px, py = entry.transform[1], entry.transform[5]
        x0 = max(0, int(math.floor((grid.west - shift - entry.west) / px)) - 2)
        x1 = min(entry.width, int(math.ceil((grid.east - shift - entry.west) / px)) + 2)
        row_step = -py
        y0 = max(0, int(math.floor((entry.north - grid.north) / row_step)) - 2)
        y1 = min(entry.height, int(math.ceil((entry.north - grid.south) / row_step)) + 2)
        return x0, x1, y0, y1

    @staticmethod
    def _overlaps(interval, cells, shift=0.0, spherical=False):
        low, high = interval
        result = []
        if not cells:
            return result
        step = (abs(cells[2][0] - cells[1][0]) if len(cells) > 2
                else abs(cells[1][0] - cells[0][0]) if len(cells) > 1
                else abs(cells[0][1] - cells[0][0]))
        ascending = len(cells) == 1 or cells[1][0] >= cells[0][0]
        if ascending:
            first = max(0, int(math.floor((low - cells[0][0] - shift) / step)) - 2)
            last = min(len(cells), int(math.ceil((high - cells[0][0] - shift) / step)) + 2)
        else:
            first = max(0, int(math.floor((cells[0][1] - high + shift) / step)) - 2)
            last = min(len(cells), int(math.ceil((cells[0][1] - low + shift) / step)) + 2)
        for index in range(first, last):
            cell_low, cell_high = cells[index]
            cell_low += shift
            cell_high += shift
            overlap_low, overlap_high = max(low, cell_low), min(high, cell_high)
            if overlap_low < overlap_high:
                weight = (math.sin(math.radians(overlap_high)) - math.sin(math.radians(overlap_low))
                          if spherical else overlap_high - overlap_low)
                result.append((index, weight))
        return result

    def _aggregate_fast(self, grid, *, linear=False):
        """低LOD用のGDAL平均。source pixelが多数入るセルだけで使う。"""
        from osgeo import gdal
        result = np.zeros((grid.height, grid.width, self.channels), dtype=np.float64)
        filled = np.zeros((grid.height, grid.width), dtype=bool)
        for entry in self.entries:
            for shift in (-360.0, 0.0, 360.0):
                columns = [x for x in range(grid.width)
                           if entry.west + shift < grid.bounds(x, 0)[2]
                           and entry.east + shift > grid.bounds(x, 0)[0]]
                rows = [y for y in range(grid.height)
                        if entry.south < grid.bounds(0, y)[3]
                        and entry.north > grid.bounds(0, y)[1]]
                if not columns or not rows:
                    continue
                x0, x1, y0, y1 = self._candidate_range(entry, grid, shift)
                if x0 >= x1 or y0 >= y1:
                    continue
                values = entry.dataset.ReadAsArray(x0, y0, x1 - x0, y1 - y0,
                                                   buf_xsize=len(columns), buf_ysize=len(rows),
                                                   resample_alg=gdal.GRA_Average)
                if values is None:
                    raise ValueError(f"GeoTIFFの低LOD windowを読めません: {entry.path}")
                values = np.asarray(values)
                if self.channels == 1:
                    values = values[..., None]
                else:
                    values = np.moveaxis(values, 0, -1)
                for row, target_y in enumerate(rows):
                    for column, target_x in enumerate(columns):
                        if filled[target_y, target_x]:
                            continue
                        result[target_y, target_x] = values[row, column]
                        filled[target_y, target_x] = True
        if getattr(grid, "allow_gutter", False) and not np.all(filled):
            valid_rows = [row for row in range(grid.height) if np.all(filled[row])]
            for row in range(grid.height):
                if np.all(filled[row]):
                    continue
                source_row = valid_rows[0] if row < valid_rows[0] else valid_rows[-1]
                result[row] = result[source_row]
                filled[row] = filled[source_row]
        if not np.all(filled):
            raise ValueError(f"低LOD GeoTIFF群がtarget gridを覆っていません: {np.count_nonzero(~filled)}セル")
        if linear:
            # GDAL平均はsRGB空間の低LOD近似であり、高LODの厳密経路とは別の品質境界。
            result = np.clip(result, 0, 255)
        if self.channels == 1:
            return result[:, :, 0].reshape(-1).tolist()
        return np.rint(result).astype(np.uint8).reshape(-1, self.channels).tolist()

    def aggregate(self, grid, *, linear=False, fast=False):
        """Return row-major channels, streaming one target row at a time."""
        if fast:
            return self._aggregate_fast(grid, linear=linear)
        result = np.zeros((grid.height, grid.width, self.channels), dtype=np.float64)
        area = np.zeros((grid.height, grid.width, self.channels), dtype=np.float64)
        for entry in self.entries:
            for shift in (-360.0, 0.0, 360.0):
                if entry.east + shift <= grid.west or entry.west + shift >= grid.east:
                    continue
                x0, x1, y0, y1 = self._candidate_range(entry, grid, shift)
                if x0 >= x1 or y0 >= y1:
                    continue
                read_width = x1 - x0
                x_cells = self._axis_cells(entry, "x", x0, x1 - x0)
                y_cells = self._axis_cells(entry, "y", y0, y1 - y0)
                column_weights = np.zeros((read_width, grid.width), dtype=np.float64)
                for target_x in range(grid.width):
                    target_west, _, target_east, _ = grid.bounds(target_x, 0)
                    overlaps = self._overlaps((target_west, target_east), x_cells,
                                              shift=shift, spherical=False)
                    for index, weight in overlaps:
                        column_weights[index, target_x] = weight
                for target_y in range(grid.height):
                    _, target_south, _, target_north = grid.bounds(0, target_y)
                    row_overlaps = self._overlaps((target_south, target_north), y_cells, spherical=True)
                    row_overlaps = [(y0 + index, weight) for index, weight in row_overlaps]
                    if not row_overlaps:
                        continue
                    row_min, row_max = min(index for index, _ in row_overlaps), max(index for index, _ in row_overlaps)
                    read_height = row_max - row_min + 1
                    read_width = x1 - x0
                    values = entry.dataset.ReadAsArray(x0, row_min, read_width, read_height)
                    if values is None:
                        raise ValueError(f"GeoTIFFのwindowを読めません: {entry.path}")
                    values = np.asarray(values)
                    if self.channels == 1:
                        values = values[..., None]
                    else:
                        values = np.moveaxis(values, 0, -1)
                    masks = np.zeros(values.shape, dtype=bool)
                    for channel, nodata in enumerate(entry.nodata):
                        if nodata is not None:
                            masks[..., channel] |= np.isclose(values[..., channel], nodata)
                    if linear:
                        normalized = values / 255.0
                        values = np.where(normalized <= 0.04045, normalized / 12.92,
                                          ((normalized + 0.055) / 1.055) ** 2.4)
                    finite = np.isfinite(values) & ~masks
                    values = np.where(finite, values, 0.0)
                    horizontal = np.einsum("rkc,kx->rxc", values, column_weights, optimize=True)
                    horizontal_area = np.einsum("rkc,kx->rxc", finite, column_weights, optimize=True)
                    rows = np.asarray([index - row_min for index, _ in row_overlaps], dtype=int)
                    weights = np.asarray([weight for _, weight in row_overlaps], dtype=np.float64)
                    result[target_y] += np.einsum("r,rxc->xc", weights, horizontal[rows])
                    area[target_y] += np.einsum("r,rxc->xc", weights, horizontal_area[rows])
        if np.any(area <= 0) and getattr(grid, "allow_gutter", False):
            valid_rows = [row for row in range(grid.height) if np.all(area[row] > 0)]
            if valid_rows:
                for row in range(grid.height):
                    if np.all(area[row] > 0):
                        continue
                    source_row = valid_rows[0] if row < valid_rows[0] else valid_rows[-1]
                    result[row] = result[source_row]
                    area[row] = area[source_row]
        if np.any(area <= 0):
            missing = int(np.count_nonzero(np.any(area <= 0, axis=2)))
            raise ValueError(f"GeoTIFF群がtarget gridを覆っていません: {missing}セル")
        output = result / area
        if linear:
            output = np.vectorize(_linear_to_srgb)(output) * 255
        if self.channels == 1:
            return output[:, :, 0].reshape(-1).tolist()
        return np.rint(np.clip(output, 0, 255)).astype(np.uint8).reshape(-1, self.channels).tolist()


class RasterCoverage:
    """GSHHGをtarget gridのsupersample rasterへ焼き、階層の符号を合成する。"""

    def __init__(self, archive_path, factor=2):
        try:
            from osgeo import ogr
        except ImportError as error:
            raise RuntimeError("GSHHGの実データ生成にはGDALが必要です") from error
        self.factor = factor
        self.layers = []
        archive_path = Path(archive_path)
        for level in (1, 2, 3, 4, 5):
            uri = f"/vsizip/{archive_path}/GSHHS_shp/f/GSHHS_f_L{level}.shp"
            dataset = ogr.Open(uri)
            if dataset is None:
                raise ValueError(f"GSHHG shapefileを開けません: {uri}")
            self.layers.append((level, dataset, dataset.GetLayer(0)))

    def coverage(self, grid):
        from osgeo import gdal
        factor = self.factor
        width, height = grid.width * factor, grid.height * factor
        pixel_x = (grid.east - grid.west) / grid.width / factor
        pixel_y = (grid.north - grid.south) / grid.height / factor
        total = np.zeros((height, width), dtype=np.float64)
        ice = np.zeros_like(total)
        signs = {1: 1, 2: -1, 3: 1, 4: -1, 5: 1}
        for shift in (-360.0, 0.0, 360.0):
            for level, _, layer in self.layers:
                raster = gdal.GetDriverByName("MEM").Create("", width, height, 1, gdal.GDT_Byte)
                raster.SetGeoTransform((grid.west + shift, pixel_x, 0, grid.north, 0, -pixel_y))
                raster.GetRasterBand(1).Fill(0)
                error = gdal.RasterizeLayer(raster, [1], layer, burn_values=[1])
                if error:
                    raise ValueError(f"GSHHG level {level}のrasterizeに失敗しました")
                values = raster.GetRasterBand(1).ReadAsArray().astype(np.float64)
                total += signs[level] * values
                if level == 5:
                    ice += values
        if grid.north > 90 or grid.south < -90:
            valid_rows = [row for row in range(height)
                          if grid.south + (row + 0.5) * (grid.north - grid.south) / height < 90
                          and grid.south + (row + 0.5) * (grid.north - grid.south) / height > -90]
            if valid_rows:
                for row in range(height):
                    if row < valid_rows[0]:
                        total[row] = total[valid_rows[0]]
                        ice[row] = ice[valid_rows[0]]
                    elif row > valid_rows[-1]:
                        total[row] = total[valid_rows[-1]]
                        ice[row] = ice[valid_rows[-1]]
        total = np.clip(total, 0, 1).reshape(grid.height, factor, grid.width, factor).mean(axis=(1, 3))
        ice = np.clip(ice, 0, 1).reshape(grid.height, factor, grid.width, factor).mean(axis=(1, 3))
        return total.reshape(-1).tolist(), ice.reshape(-1).tolist()


def _regular_axis_cells(values, *, longitude=False):
    values = np.asarray(values, dtype=float)
    if values.size < 2:
        raise ValueError("再格子化軸が短すぎます")
    step = abs(float(values[1] - values[0]))
    if longitude:
        return [(float(value - step / 2), float(value + step / 2)) for value in values]
    result = []
    for index, value in enumerate(values):
        low, high = value - step / 2, value + step / 2
        result.append((max(-90.0, low), min(90.0, high)))
    return result


def regrid_era5(data, latitudes, longitudes, grid):
    """ERA5の1か月分を球面セル面積でtarget gridへ変換する。"""
    source = np.asarray(np.ma.filled(data, np.nan), dtype=np.float64)
    lat_cells, lon_cells = _regular_axis_cells(latitudes), _regular_axis_cells(longitudes, longitude=True)
    output = np.full((grid.height, grid.width), np.nan, dtype=np.float64)
    for y in range(grid.height):
        _, south, _, north = grid.bounds(0, y)
        rows = [(index, math.sin(math.radians(min(north, high))) - math.sin(math.radians(max(south, low))))
                for index, (low, high) in enumerate(lat_cells) if low < north and high > south]
        for x in range(grid.width):
            west, _, east, _ = grid.bounds(x, y)
            cols = []
            for shift in (-360.0, 0.0, 360.0):
                native_west, native_east = west - shift, east - shift
                first = max(0, int(math.floor((native_west - lon_cells[0][0]) / (lon_cells[1][0] - lon_cells[0][0]))) - 2)
                last = min(len(lon_cells), int(math.ceil((native_east - lon_cells[0][0]) / (lon_cells[1][0] - lon_cells[0][0]))) + 2)
                for index in range(first, last):
                    low, high = lon_cells[index]
                    overlap_low, overlap_high = max(west, low + shift), min(east, high + shift)
                    if overlap_low < overlap_high:
                        cols.append((index, overlap_low, overlap_high))
            weighted, area = 0.0, 0.0
            for row, row_weight in rows:
                for col, col_low, col_high in cols:
                    value = source[row, col]
                    if math.isfinite(float(value)):
                        weight = row_weight * math.radians(col_high - col_low)
                        weighted += float(value) * weight
                        area += weight
            if area > 0:
                output[y, x] = weighted / area
    if np.any(~np.isfinite(output)):
        raise ValueError("ERA5の再格子化結果に欠測があります")
    return output.tolist()
