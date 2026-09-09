// 本番の地表配信先を受け取る薄い runtime 境界。
// 空の URL は開発時のフォールバックのために許容し、必須化するときだけ厳格に検査する。

const DATASET_ID = /^[a-z0-9-]+$/;

function configuredBaseUrl(): string {
  return typeof __EARTH_SURFACE_BASE_URL__ === 'string' ? __EARTH_SURFACE_BASE_URL__ : '';
}

function parseAbsoluteUrl(value: string): URL {
  try {
    return new URL(value);
  } catch (error) {
    throw new Error(`Earth surface base URL must be an absolute URL: ${value}`, { cause: error });
  }
}

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
