// 地球の地表配信物をゲームへ渡すための、描画・気候共有契約。
// URLの組み立てとdatasetIdの固定だけを持ち、タイル要求やGPU資源はrender側が所有する。

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
  readonly schemaVersion: 1;
  readonly datasetId: string;
  readonly sourceManifestSha256: string;
  readonly terrainEncoding: EarthSurfaceTerrainEncoding;
  readonly baseColor: string;
  readonly baseTerrain: string;
  readonly tileIndexUrl: string;
  readonly climateMaps: readonly string[];
  readonly climateEncoding: EarthSurfaceClimateEncoding;
  readonly attribution: readonly string[];
}

// manifestが宣言するESTN/ESTB v2のチャンネル配置と固定値。
export interface EarthSurfaceTerrainEncoding {
  readonly formatVersion: 2;
  readonly layout: 'octahedral-rg8-roughness-r8-material-class-a8';
  readonly width: 260;
  readonly height: 260;
  readonly channels: 4;
  readonly scalar: 'UInt8';
  readonly materialClasses: {
    readonly water: 0;
    readonly land: 1;
    readonly ice: 2;
    readonly unknown: 255;
  };
}

function relativeAsset(baseUrl: string, path: string): string {
  if (path.length === 0 || path.startsWith('/') || path.includes('\\')
    || path.split('/').some((part) => part === '..' || part === '.') || path.includes('?') || path.includes('#')) {
    throw new Error('Invalid Earth surface asset path');
  }
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

function requireDatasetId(datasetId: string): void {
  if (!/^[a-z0-9-]+$/.test(datasetId)) throw new Error('Invalid Earth surface datasetId');
}

// 配信用索引から、同じdatasetIdを共有する地球の入力を作る。
export function earthSurfaceSourceFromManifest(
  baseUrl: string, manifestUrl: string, manifest: EarthSurfaceAssetManifest,
): EarthSurfaceSource {
  if (manifest.schemaVersion !== 1) throw new Error('Unsupported Earth surface manifest schema');
  requireDatasetId(manifest.datasetId);
  // runtimeのデコーダと異なるwire形式を、取得を始める前に拒否する。
  const terrain = manifest.terrainEncoding;
  if (terrain?.formatVersion !== 2 || terrain.layout !== 'octahedral-rg8-roughness-r8-material-class-a8'
    || terrain.width !== 260 || terrain.height !== 260 || terrain.channels !== 4 || terrain.scalar !== 'UInt8'
    || terrain.materialClasses?.water !== 0 || terrain.materialClasses.land !== 1
    || terrain.materialClasses.ice !== 2 || terrain.materialClasses.unknown !== 255) {
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
  };
}

// 別配信物が同じ地表・気候版を指すことを検査する。地理資源を混在させないための境界。
export function assertEarthSurfaceDataset(source: EarthSurfaceSource, datasetId: string): void {
  requireDatasetId(datasetId);
  if (source.datasetId !== datasetId) throw new Error('Earth surface datasetId mismatch');
}
