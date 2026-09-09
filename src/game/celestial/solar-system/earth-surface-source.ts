// 地球の地表配信物をゲームへ渡すための、描画・気候共有契約。
// URLの組み立てとdatasetIdの固定だけを持ち、タイル要求やGPU資源はrender側が所有する。

export interface EarthSurfaceSource {
  readonly datasetId: string;
  readonly baseUrl: string;
  readonly manifestUrl: string;
  readonly baseColorUrl: string;
  readonly baseTerrainUrl: string;
  readonly climateMapUrls: readonly string[];
}

export interface EarthSurfaceAssetManifest {
  readonly datasetId: string;
  readonly baseColor: string;
  readonly baseTerrain: string;
  readonly climateMaps: readonly string[];
}

function relativeAsset(baseUrl: string, path: string): string {
  if (path.length === 0 || path.startsWith('/') || path.includes('..')) throw new Error('Invalid Earth surface asset path');
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

function requireDatasetId(datasetId: string): void {
  if (!/^[a-z0-9-]+$/.test(datasetId)) throw new Error('Invalid Earth surface datasetId');
}

// 配信用索引から、同じdatasetIdを共有する地球の入力を作る。
export function earthSurfaceSourceFromManifest(
  baseUrl: string, manifestUrl: string, manifest: EarthSurfaceAssetManifest,
): EarthSurfaceSource {
  requireDatasetId(manifest.datasetId);
  if (manifest.climateMaps.length !== 12) throw new Error('Earth surface requires 12 climate maps');
  return {
    datasetId: manifest.datasetId,
    baseUrl,
    manifestUrl,
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
