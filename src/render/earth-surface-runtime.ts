// 本番の地表配信先を受け取る薄い runtime 境界。
// 空の URL は開発時のフォールバックのために許容し、必須化するときだけ厳格に検査する。
import {
  earthSurfaceSourceFromManifest,
  type EarthSurfaceAssetManifest,
  type EarthSurfaceSource,
} from './earth-surface-source';
import { EarthSurfaceTileSource } from './earth-surface-tile-source';

const DATASET_ID = /^[a-z0-9-]+$/;
export type EarthSurfaceBootstrapState = 'loading' | 'ready' | 'error' | 'fallback';

export interface EarthSurfaceBootstrapResult {
  readonly state: Exclude<EarthSurfaceBootstrapState, 'loading'>;
  readonly source: EarthSurfaceSource | null;
  readonly tileSource: EarthSurfaceTileSource | null;
  readonly error: Error | null;
}

export interface EarthSurfaceBootstrapOptions {
  readonly manifestUrl?: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly fallback?: EarthSurfaceSource | null;
}

// ビルド時の配信先を読む。未定義の開発環境では空文字を返す。
function configuredBaseUrl(): string {
  return typeof __EARTH_SURFACE_BASE_URL__ === 'string' ? __EARTH_SURFACE_BASE_URL__ : '';
}

// ビルド時に個別指定されたmanifest URLを読む。
function configuredManifestUrl(): string {
  return typeof __EARTH_SURFACE_MANIFEST_URL__ === 'string' ? __EARTH_SURFACE_MANIFEST_URL__ : '';
}

// 本番設定へ渡すURLが絶対URLかを検査する。
function parseAbsoluteUrl(value: string): URL {
  try {
    return new URL(value);
  } catch (error) {
    throw new Error(`Earth surface base URL must be an absolute URL: ${value}`, { cause: error });
  }
}

// 開発用ホスト名を本番配信先から除外する。
function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '[::1]';
}

/** 開発では空文字を返し、設定された URL はそのまま返す。 */
export function earthSurfaceBaseUrl(): string {
  return configuredBaseUrl();
}

// Pagesのrepository subpathからmanifestを解決する。base URLが指定された場合も、
// dataset固有のURLを別設定せずmanifestの親を正本にする。
export function earthSurfaceManifestUrl(
  baseUrl = earthSurfaceBaseUrl(),
  documentBase = typeof document === 'undefined' ? null : document.baseURI,
): string | null {
  const manifestUrl = configuredManifestUrl();
  if (manifestUrl.length > 0) {
    return documentBase === null ? parseAbsoluteUrl(manifestUrl).toString()
      : new URL(manifestUrl, documentBase).toString();
  }
  if (baseUrl.length > 0) return new URL('earth-surface.json', requireEarthSurfaceBaseUrl(baseUrl)).toString();
  if (documentBase === null) return null;
  return new URL('earth-surface/earth-surface.json', documentBase).toString();
}

// fetchやJSONの失敗をBootstrapResultで扱えるErrorへ正規化する。
function errorOf(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

// manifestの整合性だけを起動時に検査する。画像のdecode/GPU機能検査は
// EarthSurfaceが表示される時点まで遅らせ、失敗時は呼び手が既存baseへ留まれる。
export async function bootstrapEarthSurface(
  options: EarthSurfaceBootstrapOptions = {},
): Promise<EarthSurfaceBootstrapResult> {
  const manifestUrl = options.manifestUrl === undefined
    ? earthSurfaceManifestUrl() : options.manifestUrl;
  if (manifestUrl === null || manifestUrl.length === 0) {
    return { state: 'fallback', source: options.fallback ?? null, tileSource: null, error: null };
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    // manifestを先に確定し、datasetIdとwire形式の検査まで成功した版だけをreadyにする。
    const response = await fetchImpl(manifestUrl);
    if (!response.ok) throw new Error('Earth surface manifest HTTP ' + response.status);
    const value = await response.json() as EarthSurfaceAssetManifest;
    const manifestBaseUrl = new URL('.', manifestUrl).toString();
    const source = earthSurfaceSourceFromManifest(manifestBaseUrl, manifestUrl, value);
    const tileSource = new EarthSurfaceTileSource(source.colorTileTemplate, source.terrainTileTemplate);
    return { state: 'ready', source, tileSource, error: null };
  } catch (error) {
    return { state: 'error', source: options.fallback ?? null, tileSource: null, error: errorOf(error) };
  }
}

/** 本番で使える地表配信 URL を返す。空文字と開発用 URL は拒否する。 */
export function requireEarthSurfaceBaseUrl(value = configuredBaseUrl()): string {
  if (value.length === 0) throw new Error('Earth surface base URL is required for production');
  const url = parseAbsoluteUrl(value);
  if (url.protocol !== 'https:') throw new Error('Earth surface base URL must use HTTPS');
  if (isLocalHostname(url.hostname)) throw new Error('Earth surface base URL must not target localhost');
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error('Earth surface base URL must not contain credentials');
  }
  return value.endsWith('/') ? value : `${value}/`;
}

/** 配信 manifest の datasetId を検査する。 */
export function requireEarthSurfaceDatasetId(datasetId: string): string {
  if (!DATASET_ID.test(datasetId)) throw new Error(`Invalid Earth surface datasetId: ${datasetId}`);
  return datasetId;
}
