// 地球の地表配信物を描画・気候共有契約へ正規化する。
// URLの組み立てとdatasetIdの固定だけを持ち、タイル要求やGPU資源は別のrender層が所有する。
import { EARTH_TILE_MAX_Z, EARTH_TILE_MIN_Z } from './earth-surface-tile-key';
import {
  EARTH_SURFACE_TERRAIN_FORMAT_VERSION,
  EARTH_TERRAIN_CHANNELS,
  EARTH_TERRAIN_HEIGHT,
  EARTH_TERRAIN_LAYOUT,
  EARTH_TERRAIN_MATERIAL_CLASSES,
  EARTH_TERRAIN_WIDTH,
} from './earth-surface-format';

export interface EarthSurfaceSource {
  readonly datasetId: string;
  readonly sourceManifestSha256: string;
  readonly climateEncoding: EarthSurfaceClimateEncoding;
  readonly baseUrl: string;
  readonly manifestUrl: string;
  readonly tileIndexUrl: string;
  readonly baseColorUrl: string;
  readonly baseTerrainUrl: string;
  readonly climateMapUrls: readonly string[];
  /** 現行描画LODへ移行する前の配信物。z0..z3は要求対象から除外する。 */
  readonly legacyBundle?: boolean;
}

export interface EarthSurfaceClimateRange {
  readonly min: number;
  readonly max: number;
}

export interface EarthSurfaceClimateEncoding {
  readonly temperatureK: EarthSurfaceClimateRange;
  readonly cloudFraction: EarthSurfaceClimateRange;
  readonly orthometricElevation: EarthSurfaceClimateRange;
  readonly landFraction: EarthSurfaceClimateRange;
  readonly waterOrthometricElevationM: number;
}

export interface EarthSurfaceAssetManifest {
  readonly schemaVersion: 1 | 2;
  readonly datasetId: string;
  readonly sourceManifestSha256: string;
  readonly terrainEncoding: EarthSurfaceTerrainEncoding;
  readonly baseColor: string;
  readonly baseTerrain: string;
  readonly tileIndexUrl: string;
  readonly climateMaps: readonly string[];
  readonly climateEncoding: EarthSurfaceClimateEncoding;
  readonly coverage?: EarthSurfaceCoverage;
  readonly attribution: readonly string[];
}

export interface EarthSurfaceCoverage {
  readonly kind: 'complete' | 'sparse';
  readonly minZoom?: number;
  readonly maxZoom: 7;
  readonly expectedTiles: number | null;
}

// manifestが宣言するESTN/ESTB v2のチャンネル配置と固定値。
export interface EarthSurfaceTerrainEncoding {
  readonly formatVersion: typeof EARTH_SURFACE_TERRAIN_FORMAT_VERSION;
  readonly layout: typeof EARTH_TERRAIN_LAYOUT;
  readonly width: typeof EARTH_TERRAIN_WIDTH;
  readonly height: typeof EARTH_TERRAIN_HEIGHT;
  readonly channels: typeof EARTH_TERRAIN_CHANNELS;
  readonly scalar: 'UInt8';
  readonly materialClasses: {
    readonly water: typeof EARTH_TERRAIN_MATERIAL_CLASSES.water;
    readonly land: typeof EARTH_TERRAIN_MATERIAL_CLASSES.land;
    readonly ice: typeof EARTH_TERRAIN_MATERIAL_CLASSES.ice;
    readonly unknown: typeof EARTH_TERRAIN_MATERIAL_CLASSES.unknown;
  };
}

// 配信物の相対パスを検査し、manifestの親から絶対URLへ解決する。
function relativeAsset(baseUrl: string, path: string): string {
  if (path.length === 0 || path.startsWith('/') || path.includes('\\')
    || path.split('/').some((part) => part === '..' || part === '.') || path.includes('?') || path.includes('#')) {
    throw new Error('Invalid Earth surface asset path');
  }
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

// URLやファイル名へ使えるdatasetIdだけを受け入れる。
function requireDatasetId(datasetId: string): void {
  if (!/^[a-z0-9-]+$/.test(datasetId)) throw new Error('Invalid Earth surface datasetId');
}

// 配信用索引から、同じdatasetIdを共有する地球の入力を作る。
export function earthSurfaceSourceFromManifest(
  baseUrl: string, manifestUrl: string, manifest: EarthSurfaceAssetManifest,
): EarthSurfaceSource {
  if (manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2) {
    throw new Error('Unsupported Earth surface manifest schema');
  }
  const legacyBundle = manifest.schemaVersion === 1;
  requireDatasetId(manifest.datasetId);
  const coverage = manifest.coverage;
  if (coverage?.kind !== 'complete' && coverage?.kind !== 'sparse') {
    throw new Error('Invalid Earth surface coverage kind');
  }
  if (legacyBundle) {
    if (coverage.maxZoom !== EARTH_TILE_MAX_Z) {
      throw new Error('Legacy Earth surface coverage must end at z7');
    }
    if (coverage.kind === 'complete' && coverage.expectedTiles !== 43_690) {
      throw new Error('Complete legacy Earth surface coverage must contain 43690 tiles');
    }
    if (coverage.kind === 'sparse' && coverage.expectedTiles !== null) {
      throw new Error('Sparse legacy Earth surface coverage must not declare expected tiles');
    }
  } else {
    if (coverage.minZoom !== EARTH_TILE_MIN_Z || coverage.maxZoom !== EARTH_TILE_MAX_Z) {
      throw new Error('Earth surface coverage must be z4..z7');
    }
    if (coverage.kind === 'complete' && coverage.expectedTiles !== 43_520) {
      throw new Error('Complete Earth surface coverage must contain 43520 tiles');
    }
    if (coverage.kind === 'sparse' && coverage.expectedTiles !== null) {
      throw new Error('Sparse Earth surface coverage must not declare expected tiles');
    }
  }
  // runtimeのデコーダと異なるwire形式を、取得を始める前に拒否する。
  const terrain = manifest.terrainEncoding;
  if (terrain?.formatVersion !== EARTH_SURFACE_TERRAIN_FORMAT_VERSION || terrain.layout !== EARTH_TERRAIN_LAYOUT
    || terrain.width !== EARTH_TERRAIN_WIDTH || terrain.height !== EARTH_TERRAIN_HEIGHT
    || terrain.channels !== EARTH_TERRAIN_CHANNELS || terrain.scalar !== 'UInt8'
    || terrain.materialClasses?.water !== EARTH_TERRAIN_MATERIAL_CLASSES.water
    || terrain.materialClasses.land !== EARTH_TERRAIN_MATERIAL_CLASSES.land
    || terrain.materialClasses.ice !== EARTH_TERRAIN_MATERIAL_CLASSES.ice
    || terrain.materialClasses.unknown !== EARTH_TERRAIN_MATERIAL_CLASSES.unknown) {
    throw new Error('Unsupported Earth surface terrain encoding');
  }
  if (!/^[0-9a-f]{64}$/.test(manifest.sourceManifestSha256)) throw new Error('Invalid Earth surface source manifest hash');
  if (manifest.climateMaps.length !== 12) throw new Error('Earth surface requires 12 climate maps');
  for (const range of [manifest.climateEncoding.temperatureK, manifest.climateEncoding.cloudFraction,
    manifest.climateEncoding.orthometricElevation, manifest.climateEncoding.landFraction]) {
    if (!Number.isFinite(range.min) || !Number.isFinite(range.max) || range.min >= range.max) {
      throw new Error('Invalid Earth surface climate encoding');
    }
  }
  if (manifest.climateEncoding.waterOrthometricElevationM !== 0) {
    throw new Error('Earth surface water orthometric elevation must be 0');
  }
  if (manifest.climateEncoding.temperatureK.min !== 180 || manifest.climateEncoding.temperatureK.max !== 330
    || manifest.climateEncoding.cloudFraction.min !== 0 || manifest.climateEncoding.cloudFraction.max !== 1
    || manifest.climateEncoding.orthometricElevation.min !== -1000
    || manifest.climateEncoding.orthometricElevation.max !== 9000
    || manifest.climateEncoding.landFraction.min !== 0 || manifest.climateEncoding.landFraction.max !== 1) {
    throw new Error('Earth surface climate encoding ranges are not the contract ranges');
  }
  return {
    datasetId: manifest.datasetId,
    sourceManifestSha256: manifest.sourceManifestSha256,
    climateEncoding: manifest.climateEncoding,
    baseUrl,
    manifestUrl,
    tileIndexUrl: relativeAsset(baseUrl, manifest.tileIndexUrl),
    baseColorUrl: relativeAsset(baseUrl, manifest.baseColor),
    baseTerrainUrl: relativeAsset(baseUrl, manifest.baseTerrain),
    climateMapUrls: manifest.climateMaps.map((path) => relativeAsset(baseUrl, path)),
    legacyBundle: legacyBundle || undefined,
  };
}

// 別配信物が同じ地表・気候版を指すことを検査する。地理資源を混在させないための境界。
export function assertEarthSurfaceDataset(source: EarthSurfaceSource, datasetId: string): void {
  requireDatasetId(datasetId);
  if (source.datasetId !== datasetId) throw new Error('Earth surface datasetId mismatch');
}
