// 地表タイルの固定レイアウトと、周期境界を含むキー操作を定義する。
import * as THREE from 'three/webgpu';

export const EARTH_TILE_MIN_Z = 5;
export const EARTH_TILE_MAX_Z = 7;
export const EARTH_TILE_TEXELS = 256;
export const EARTH_TILE_GUTTER = 2;
export const EARTH_TILE_EXTENT = EARTH_TILE_TEXELS + 2 * EARTH_TILE_GUTTER;
// 親子fadeを含むGPU配列の物理層数。WebGPUの最低保証256層内に収める。
export const EARTH_TILE_LAYERS = 96;
export const EARTH_BASE_LAYER = 255;

export interface EarthTileKey {
  readonly z: number;
  readonly x: number;
  readonly y: number;
}

// xを周期、yを極でクランプした整数キーを返す。
export function earthTileKey(z: number, x: number, y: number): EarthTileKey {
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > EARTH_TILE_MAX_Z) {
    throw new RangeError('Invalid Earth tile key');
  }
  const height = 2 ** z;
  return { z, x: THREE.MathUtils.euclideanModulo(x, 2 * height), y: THREE.MathUtils.clamp(y, 0, height - 1) };
}

// 正規化済みキーの識別子を返す。
export function earthTileId(key: EarthTileKey): string {
  return `${key.z}/${key.x}/${key.y}`;
}

// 根ではnull、それ以外では直近の親を返す。
export function earthTileParent(key: EarthTileKey): EarthTileKey | null {
  return key.z === 0 ? null : earthTileKey(key.z - 1, Math.floor(key.x / 2), Math.floor(key.y / 2));
}

// 最大段では空、それ以外では4子を返す。
export function earthTileChildren(key: EarthTileKey): readonly EarthTileKey[] {
  return key.z === EARTH_TILE_MAX_Z ? [] : [
    earthTileKey(key.z + 1, key.x * 2, key.y * 2),
    earthTileKey(key.z + 1, key.x * 2 + 1, key.y * 2),
    earthTileKey(key.z + 1, key.x * 2, key.y * 2 + 1),
    earthTileKey(key.z + 1, key.x * 2 + 1, key.y * 2 + 1),
  ];
}

// 表示木の根を返す。全球画像は暗黙のz4で、地域詳細はz5から始める。
export function earthTileRoots(): readonly EarthTileKey[] {
  const height = 2 ** EARTH_TILE_MIN_Z;
  return Array.from({ length: height }, (_, y) => Array.from({ length: 2 * height }, (_, x) =>
    earthTileKey(EARTH_TILE_MIN_Z, x, y))).flat();
}

// 同じ段の東西南北の隣接キー。極を越える辺は経度を半周ずらして反転する。
export function earthTileNeighbors(key: EarthTileKey): readonly EarthTileKey[] {
  const height = 2 ** key.z;
  return [
    earthTileKey(key.z, key.x - 1, key.y), earthTileKey(key.z, key.x + 1, key.y),
    earthTileKey(key.z, key.y === 0 ? key.x + height : key.x, key.y === 0 ? 0 : key.y - 1),
    earthTileKey(key.z, key.y === height - 1 ? key.x + height : key.x,
      key.y === height - 1 ? key.y : key.y + 1),
  ];
}
