// 地表タイルの固定レイアウトと、周期境界を含むキー操作を定義する。
import * as THREE from 'three/webgpu';
import { EARTH_TILE_MAX_Z } from './layout';
export {
  EARTH_BASE_COLOR_Z, EARTH_BASE_LAYER, EARTH_GLOBAL_TILE_COUNT,
  EARTH_TILE_EXTENT, EARTH_TILE_GUTTER, EARTH_TILE_LAYERS, EARTH_TILE_MAX_Z,
  EARTH_TILE_MIN_Z, EARTH_TILE_TEXELS, earthSurfaceTileCount,
} from './layout';

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

// 正規化済みキーを、earthTileId と1対1に対応する整数へ写す。x < 2^(z+1) ≤ 2^9、y < 2^z ≤ 2^8。
export function earthTileIndex(key: EarthTileKey): number {
  return (key.z << 17) | (key.y << 9) | key.x;
}

// 根ではnull、それ以外では直近の親を返す。
export function earthTileParent(key: EarthTileKey): EarthTileKey | null {
  return key.z === 0 ? null : earthTileKey(key.z - 1, Math.floor(key.x / 2), Math.floor(key.y / 2));
}

// 最大段では空、それ以外では4子を返す。正規化済みキーの子は正規化済みなので、そのまま組む。
export function earthTileChildren(key: EarthTileKey): readonly EarthTileKey[] {
  if (key.z === EARTH_TILE_MAX_Z) return [];
  const z = key.z + 1;
  const x = key.x * 2;
  const y = key.y * 2;
  return [{ z, x, y }, { z, x: x + 1, y }, { z, x, y: y + 1 }, { z, x: x + 1, y: y + 1 }];
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
