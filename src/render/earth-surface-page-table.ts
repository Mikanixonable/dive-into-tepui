// GPUページ表の寸法と、ページ表・タイル配列の標本化規則を定義する。
import * as THREE from 'three/webgpu';
import {
  EARTH_TILE_EXTENT, EARTH_TILE_GUTTER, EARTH_TILE_MAX_Z, EARTH_TILE_TEXELS,
} from './earth-surface-tile-key';

export const EARTH_PAGE_WIDTH = 2 ** (EARTH_TILE_MAX_Z + 1);
export const EARTH_PAGE_HEIGHT = 2 ** EARTH_TILE_MAX_Z;

// ページ表の1セルを最近傍で読む。経度の両端を同じセルへ畳み、南極は最終行へ置く。
export function earthPageAt(table: Uint8Array, u: number, v: number): readonly number[] {
  const x = Math.floor(THREE.MathUtils.euclideanModulo(u, 1) * EARTH_PAGE_WIDTH);
  const y = Math.min(EARTH_PAGE_HEIGHT - 1, Math.floor(THREE.MathUtils.clamp(v, 0, 1) * EARTH_PAGE_HEIGHT));
  return [...table.subarray((y * EARTH_PAGE_WIDTH + x) * 4, (y * EARTH_PAGE_WIDTH + x) * 4 + 4)];
}

// タイル標本化用UV。v=1は南端のガターを読み、北端へwrapさせない。
export function earthTileSampleUv(u: number, v: number, z: number): THREE.Vector2 {
  const tu = THREE.MathUtils.euclideanModulo(u * 2 ** (z + 1), 1);
  const tv = v === 1 ? 1 : THREE.MathUtils.euclideanModulo(v * 2 ** z, 1);
  return new THREE.Vector2(
    (EARTH_TILE_GUTTER + 0.5 + EARTH_TILE_TEXELS * tu) / EARTH_TILE_EXTENT,
    (EARTH_TILE_GUTTER + 0.5 + EARTH_TILE_TEXELS * tv) / EARTH_TILE_EXTENT,
  );
}
