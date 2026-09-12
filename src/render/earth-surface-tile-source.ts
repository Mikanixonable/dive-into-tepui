// 完全な地表データセットについて、正規化済みキーから色・地形のURLを決定する。
import { EARTH_TILE_MAX_Z, EARTH_TILE_MIN_Z, earthTileId } from './earth-surface-tile-key';
import type { EarthTileKey } from './earth-surface-tile-key';

export interface EarthSurfaceTileDescriptor {
  readonly key: EarthTileKey;
  readonly colorUrl: string;
  readonly terrainUrl: string;
}

function resolveTemplate(template: string, key: EarthTileKey): string {
  return template
    .replace('{z}', String(key.z))
    .replace('{x}', String(key.x))
    .replace('{y}', String(key.y));
}

export class EarthSurfaceTileSource {
  public constructor(
    private readonly colorTemplate: string,
    private readonly terrainTemplate: string,
  ) {}

  // 配信範囲のキーを決定的なURLへ解決する。範囲外は基底表示へ戻すためnull。
  public descriptorFor(key: EarthTileKey): EarthSurfaceTileDescriptor | null {
    if (key.z < EARTH_TILE_MIN_Z || key.z > EARTH_TILE_MAX_Z) return null;
    return {
      key,
      colorUrl: resolveTemplate(this.colorTemplate, key),
      terrainUrl: resolveTemplate(this.terrainTemplate, key),
    };
  }

  public urlFor(key: EarthTileKey): { readonly color: string; readonly terrain: string } | null {
    const descriptor = this.descriptorFor(key);
    return descriptor === null ? null : { color: descriptor.colorUrl, terrain: descriptor.terrainUrl };
  }

  // URLに使う識別子と同じ正規化済みキー表現を返す。
  public idFor(key: EarthTileKey): string { return earthTileId(key); }
}
