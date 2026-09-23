// 地球詳細地表の実行時レイアウト。描画・ページ表・LOD選択はこの契約を共有する。
export const EARTH_BASE_COLOR_Z = 4;
export const EARTH_TILE_MIN_Z = 5;
export const EARTH_TILE_MAX_Z = 8;
export const EARTH_TILE_TEXELS = 256;
export const EARTH_TILE_GUTTER = 2;
export const EARTH_TILE_EXTENT = EARTH_TILE_TEXELS + 2 * EARTH_TILE_GUTTER;
// 親子fadeを含むGPU配列の物理層数。z8化してもタイル寸法と常駐層数は増やさない。
export const EARTH_TILE_LAYERS = 96;
export const EARTH_BASE_LAYER = 255;

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
