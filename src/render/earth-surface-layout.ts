// 地球詳細地表の実行時レイアウト。描画・ページ表・LOD選択はこの契約を共有する。
import { TEXTURE_RESOLUTION, type TextureResolution } from './deferred-texture';

export const EARTH_BASE_COLOR_Z = 4;
export const EARTH_TILE_MIN_Z = 5;
export const EARTH_TILE_MAX_Z = 8;
export const EARTH_TILE_TEXELS = 256;
export const EARTH_TILE_GUTTER = 2;
export const EARTH_TILE_EXTENT = EARTH_TILE_TEXELS + 2 * EARTH_TILE_GUTTER;
// 親子fadeを含むGPU配列の物理層数の上限。段ごとの実際の層数は earthTileLayersFor が返す。
// z8化してもタイル寸法と常駐層数は増やさない。
export const EARTH_TILE_LAYERS = 96;
export const EARTH_BASE_LAYER = 255;

// GPUページ表の寸法。各セルが1タイルを指し、経度の両端は同じセルへ畳む。
export const EARTH_PAGE_WIDTH = 2 ** (EARTH_TILE_MAX_Z + 1);
export const EARTH_PAGE_HEIGHT = 2 ** EARTH_TILE_MAX_Z;

// minZoomから指定maxZoomまでの全球タイル総数を返す。
export function earthSurfaceTileCount(maxZoom: number): number {
  if (!Number.isInteger(maxZoom) || maxZoom < EARTH_TILE_MIN_Z || maxZoom > EARTH_TILE_MAX_Z) {
    throw new RangeError('Invalid Earth surface max zoom');
  }
  let count = 0;
  for (let z = EARTH_TILE_MIN_Z; z <= maxZoom; z++) count += 2 ** (2 * z + 1);
  return count;
}

export const EARTH_GLOBAL_TILE_COUNT = earthSurfaceTileCount(EARTH_TILE_MAX_Z);

// テクスチャ解像度の段ごとのGPU配列の物理層数。同時に手元へ置ける詳細タイルの量であり、
// 段を下げるほど、視点を大きく動かした直後に粗い地表が見えている時間が長くなる。
export function earthTileLayersFor(resolution: TextureResolution): number {
  switch (resolution) {
    case TEXTURE_RESOLUTION.low: return 32;
    case TEXTURE_RESOLUTION.medium: return 64;
    default: return EARTH_TILE_LAYERS;
  }
}
