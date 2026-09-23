// 地球の地表配信データを描画および気候共有用の共通フォーマットへ正規化する。
// URLの組み立てとdatasetIdの固定だけを持ち、タイル要求やGPU資源は別のrender層が所有する。
import { EARTH_TILE_MAX_Z, EARTH_TILE_MIN_Z, earthSurfaceTileCount } from './earth-surface-tile-key';
import {
  EARTH_SURFACE_MANIFEST_SCHEMA_VERSION,
  EARTH_SURFACE_TERRAIN_FORMAT_VERSION,
  EARTH_TERRAIN_CHANNELS,
  EARTH_TERRAIN_HEIGHT,
  EARTH_TERRAIN_LAYOUT,
  EARTH_TERRAIN_OCTAHEDRAL_LAYOUT,
  EARTH_TERRAIN_WIDTH,
  type EarthSurfaceTerrainFormat,
} from './earth-surface-format';

export interface EarthSurfaceSource {
  readonly datasetId: string;
  readonly sourceManifestSha256: string;
  readonly colorCalibration: EarthSurfaceColorCalibration;
  readonly climateEncoding: EarthSurfaceClimateEncoding;
  readonly maxZoom: number;
  readonly baseUrl: string;
  readonly manifestUrl: string;
  readonly colorTileTemplate: string;
  readonly terrainTileTemplate: string;
  readonly terrainFormat: EarthSurfaceTerrainFormat;
  readonly baseColorUrl: string;
  readonly baseTerrainUrl: string;
  readonly climateMapUrls: readonly string[];
}

// 地表色の入力転送、面積平均後の表現、表示用RGBから拡散アルベドへ合わせる校正値。
// bondAlbedoは地表画像の平均輝度ではなく、地球を光源として扱うときの全地球測光値なので、
// diffuseAlbedoScaleとは別の値として持つ。
export interface EarthSurfaceColorCalibration {
  readonly inputEncoding: 'sRGB8';
  readonly aggregation: 'linear_rgb_area_mean';
  readonly outputEncoding: 'sRGB8';
  readonly diffuseAlbedoScale: number;
  readonly meanLinearRgb: readonly [number, number, number];
  readonly meanRec709Albedo: number;
  readonly bondAlbedo: number;
  readonly averageHue: readonly [number, number, number];
}

// schema 1と旧静的fallbackの校正。新しいBMNG配信物はmanifestの値を使い、これを再利用しない。
export const EARTH_SURFACE_LEGACY_COLOR_CALIBRATION: EarthSurfaceColorCalibration = {
  inputEncoding: 'sRGB8',
  aggregation: 'linear_rgb_area_mean',
  outputEncoding: 'sRGB8',
  diffuseAlbedoScale: 0.9102,
  meanLinearRgb: [0.10292704, 0.11685829, 0.19066737],
  meanRec709Albedo: 0.11922552,
  bondAlbedo: 0.306,
  averageHue: [0.9703, 0.9940, 1.1471],
};

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

interface EarthSurfaceAssetManifestBase {
  readonly datasetId: string;
  readonly sourceManifestSha256: string;
  readonly baseColor: string;
  readonly baseTerrain: string;
  readonly climateMaps: readonly string[];
  readonly climateEncoding: EarthSurfaceClimateEncoding;
  readonly attribution: readonly string[];
}

export interface EarthSurfaceAssetManifestV1 extends EarthSurfaceAssetManifestBase {
  readonly schemaVersion: 1;
  readonly terrainEncoding: EarthSurfaceLegacyTerrainEncoding;
  readonly tileIndexUrl: string;
  readonly coverage: EarthSurfaceLegacyCoverage;
}

export interface EarthSurfaceAssetManifestV3 extends EarthSurfaceAssetManifestBase {
  readonly schemaVersion: typeof EARTH_SURFACE_MANIFEST_SCHEMA_VERSION;
  readonly terrainEncoding: EarthSurfaceTerrainEncoding;
  readonly colorCalibration: EarthSurfaceColorCalibration;
  readonly tileTemplates: EarthSurfaceTileTemplates;
  readonly coverage: EarthSurfaceCoverage;
}

export type EarthSurfaceAssetManifest = EarthSurfaceAssetManifestV1 | EarthSurfaceAssetManifestV3;

export interface EarthSurfaceCoverage {
  readonly kind: 'complete';
  readonly minZoom: 5;
  readonly maxZoom: number;
  readonly expectedTiles: number;
}

export interface EarthSurfaceLegacyCoverage {
  readonly kind: 'complete';
  readonly maxZoom: 7;
  readonly expectedTiles: 43_690;
}

export interface EarthSurfaceTileTemplates {
  readonly color: 'tiles/{z}/{x}/{y}.jpg';
  readonly terrain: 'tiles/{z}/{x}/{y}.bin.gz';
}

// manifestが宣言するESTN/ESTBのチャンネル配置と固定値。
export interface EarthSurfaceTerrainEncoding {
  readonly formatVersion: typeof EARTH_SURFACE_TERRAIN_FORMAT_VERSION;
  readonly layout: typeof EARTH_TERRAIN_LAYOUT;
  readonly width: typeof EARTH_TERRAIN_WIDTH;
  readonly height: typeof EARTH_TERRAIN_HEIGHT;
  readonly channels: typeof EARTH_TERRAIN_CHANNELS;
  readonly scalar: 'UInt8';
}

export interface EarthSurfaceLegacyTerrainEncoding {
  readonly formatVersion: 2;
  readonly layout: typeof EARTH_TERRAIN_OCTAHEDRAL_LAYOUT;
  readonly width: typeof EARTH_TERRAIN_WIDTH;
  readonly height: typeof EARTH_TERRAIN_HEIGHT;
  readonly channels: typeof EARTH_TERRAIN_CHANNELS;
  readonly scalar: 'UInt8';
  readonly materialClasses: {
    readonly water: 0;
    readonly land: 1;
    readonly ice: 2;
    readonly unknown: 255;
  };
}

// 配信base配下の安全な相対アセットURLを作る。
function relativeAsset(baseUrl: string, path: string): string {
  if (path.length === 0 || path.startsWith('/') || path.includes('\\')
    || path.split('/').some((part) => part === '..' || part === '.') || path.includes('?') || path.includes('#')) {
    throw new Error('Invalid Earth surface asset path');
  }
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

// タイル変数を保ったまま配信baseへ解決する。
function relativeTileTemplate(baseUrl: string, template: string): string {
  const path = template.replace('{z}', 'LOD_Z').replace('{x}', 'TILE_X').replace('{y}', 'TILE_Y');
  return relativeAsset(baseUrl, path).replace('LOD_Z', '{z}').replace('TILE_X', '{x}').replace('TILE_Y', '{y}');
}

// datasetId を URL およびデータ仕様に適合する安全な文字列へ検証・制限する。
function requireDatasetId(datasetId: string): void {
  if (!/^[a-z0-9-]+$/.test(datasetId)) throw new Error('Invalid Earth surface datasetId');
}

// 気候入力の固定wire範囲を検査する。
function validateClimateEncoding(encoding: EarthSurfaceClimateEncoding): void {
  for (const range of [encoding.temperatureK, encoding.cloudFraction, encoding.orthometricElevation, encoding.landFraction]) {
    if (!Number.isFinite(range.min) || !Number.isFinite(range.max) || range.min >= range.max) {
      throw new Error('Invalid Earth surface climate encoding');
    }
  }
  if (encoding.waterOrthometricElevationM !== 0) {
    throw new Error('Earth surface water orthometric elevation must be 0');
  }
  if (encoding.temperatureK.min !== 180 || encoding.temperatureK.max !== 330
    || encoding.cloudFraction.min !== 0 || encoding.cloudFraction.max !== 1
    || encoding.orthometricElevation.min !== -1000 || encoding.orthometricElevation.max !== 9000
    || encoding.landFraction.min !== 0 || encoding.landFraction.max !== 1) {
    throw new Error('Earth surface climate encoding ranges are not the contract ranges');
  }
}

// 表示RGBを線形作業色へ戻す経路と、地表・全地球測光の校正値を検査する。
function validateColorCalibration(calibration: EarthSurfaceColorCalibration): void {
  if (calibration === null || calibration === undefined
    || calibration.inputEncoding !== 'sRGB8' || calibration.aggregation !== 'linear_rgb_area_mean'
    || calibration.outputEncoding !== 'sRGB8') {
    throw new Error('Unsupported Earth surface color calibration encoding');
  }
  const values = [...calibration.meanLinearRgb, ...calibration.averageHue,
    calibration.diffuseAlbedoScale, calibration.meanRec709Albedo, calibration.bondAlbedo];
  if (values.some((value) => !Number.isFinite(value))) throw new Error('Invalid Earth surface color calibration');
  if (calibration.diffuseAlbedoScale <= 0 || calibration.meanRec709Albedo <= 0
    || calibration.bondAlbedo <= 0 || calibration.bondAlbedo > 1
    || calibration.meanLinearRgb.some((value) => value < 0)
    || calibration.averageHue.some((value) => value < 0)) {
    throw new Error('Invalid Earth surface color calibration range');
  }
}

// 共通のmanifest項目を検査し、相対URLを解決できることを確認する。
function validateManifestBase(baseUrl: string, manifest: EarthSurfaceAssetManifestBase): void {
  if (!/^[0-9a-f]{64}$/.test(manifest.sourceManifestSha256)) {
    throw new Error('Invalid Earth surface source manifest hash');
  }
  if (manifest.climateMaps.length !== 12) throw new Error('Earth surface requires 12 climate maps');
  for (const path of [manifest.baseColor, manifest.baseTerrain, ...manifest.climateMaps]) relativeAsset(baseUrl, path);
  validateClimateEncoding(manifest.climateEncoding);
}

// terrainEncodingの共通寸法とscalarを検査する。
function validateTerrainGeometry(terrain: { readonly width: number; readonly height: number; readonly channels: number; readonly scalar: string }): void {
  if (terrain.width !== EARTH_TERRAIN_WIDTH || terrain.height !== EARTH_TERRAIN_HEIGHT
    || terrain.channels !== EARTH_TERRAIN_CHANNELS || terrain.scalar !== 'UInt8') {
    throw new Error('Unsupported Earth surface terrain encoding');
  }
}

// 配信用索引から、同じdatasetIdを共有する地球の入力を作る。
export function earthSurfaceSourceFromManifest(
  baseUrl: string, manifestUrl: string, manifest: EarthSurfaceAssetManifest,
): EarthSurfaceSource {
  if (manifest.schemaVersion !== 1 && manifest.schemaVersion !== EARTH_SURFACE_MANIFEST_SCHEMA_VERSION) {
    throw new Error('Unsupported Earth surface manifest schema');
  }
  requireDatasetId(manifest.datasetId);
  validateManifestBase(baseUrl, manifest);
  validateTerrainGeometry(manifest.terrainEncoding);
  if (manifest.schemaVersion === 1) {
    const terrain = manifest.terrainEncoding;
    if (manifest.coverage.kind !== 'complete' || manifest.coverage.maxZoom !== 7
      || manifest.coverage.expectedTiles !== 43_690 || terrain.formatVersion !== 2
      || terrain.layout !== EARTH_TERRAIN_OCTAHEDRAL_LAYOUT || terrain.materialClasses.water !== 0
      || terrain.materialClasses.land !== 1 || terrain.materialClasses.ice !== 2
      || terrain.materialClasses.unknown !== 255) {
      throw new Error('Unsupported Earth surface schema 1 manifest');
    }
    relativeAsset(baseUrl, manifest.tileIndexUrl);
    return {
      datasetId: manifest.datasetId,
      sourceManifestSha256: manifest.sourceManifestSha256,
      colorCalibration: EARTH_SURFACE_LEGACY_COLOR_CALIBRATION,
      climateEncoding: manifest.climateEncoding,
      maxZoom: 7,
      baseUrl,
      manifestUrl,
      colorTileTemplate: relativeTileTemplate(baseUrl, 'tiles/{z}/{x}/{y}.jpg'),
      terrainTileTemplate: relativeTileTemplate(baseUrl, 'tiles/{z}/{x}/{y}.bin.gz'),
      terrainFormat: EARTH_TERRAIN_OCTAHEDRAL_LAYOUT,
      baseColorUrl: relativeAsset(baseUrl, manifest.baseColor),
      baseTerrainUrl: relativeAsset(baseUrl, manifest.baseTerrain),
      climateMapUrls: manifest.climateMaps.map((path) => relativeAsset(baseUrl, path)),
    };
  }
  const terrain = manifest.terrainEncoding;
  const coverage = manifest.coverage;
  if (coverage.kind !== 'complete' || coverage.minZoom !== EARTH_TILE_MIN_Z
    || !Number.isInteger(coverage.maxZoom) || coverage.maxZoom < EARTH_TILE_MIN_Z
    || coverage.maxZoom > EARTH_TILE_MAX_Z
    || coverage.expectedTiles !== earthSurfaceTileCount(coverage.maxZoom)) {
    throw new Error(`Earth surface coverage must be complete z${EARTH_TILE_MIN_Z}..z${coverage.maxZoom}`);
  }
  if (manifest.tileTemplates.color !== 'tiles/{z}/{x}/{y}.jpg'
    || manifest.tileTemplates.terrain !== 'tiles/{z}/{x}/{y}.bin.gz'
    || terrain.formatVersion !== EARTH_SURFACE_TERRAIN_FORMAT_VERSION || terrain.layout !== EARTH_TERRAIN_LAYOUT) {
    throw new Error('Unsupported Earth surface current manifest');
  }
  validateColorCalibration(manifest.colorCalibration);
  return {
    datasetId: manifest.datasetId,
    sourceManifestSha256: manifest.sourceManifestSha256,
    colorCalibration: manifest.colorCalibration,
    climateEncoding: manifest.climateEncoding,
    maxZoom: coverage.maxZoom,
    baseUrl,
    manifestUrl,
    colorTileTemplate: relativeTileTemplate(baseUrl, manifest.tileTemplates.color),
    terrainTileTemplate: relativeTileTemplate(baseUrl, manifest.tileTemplates.terrain),
    terrainFormat: EARTH_TERRAIN_LAYOUT,
    baseColorUrl: relativeAsset(baseUrl, manifest.baseColor),
    baseTerrainUrl: relativeAsset(baseUrl, manifest.baseTerrain),
    climateMapUrls: manifest.climateMaps.map((path) => relativeAsset(baseUrl, path)),
  };
}

// 別配信物が同じ地表・気候版を指すことを検査する。地理資源を混在させないための境界。
export function assertEarthSurfaceDataset(source: EarthSurfaceSource, datasetId: string): void {
  requireDatasetId(datasetId);
  if (source.datasetId !== datasetId) throw new Error('Earth surface datasetId mismatch');
}
