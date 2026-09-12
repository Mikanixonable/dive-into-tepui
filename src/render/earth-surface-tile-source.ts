// 地表タイル索引を検証し、正規化済みの要求記述へ解決する。
import { EARTH_SURFACE_TILE_INDEX_SCHEMA_VERSION } from './earth-surface-format';
import { EarthSurfaceHttpError, EarthSurfaceRequestError } from './earth-surface-request-errors';
import { EARTH_TILE_MIN_Z, earthTileId, earthTileKey } from './earth-surface-tile-key';
import type { EarthTileKey } from './earth-surface-tile-key';

export interface EarthSurfaceTileIndexFile {
  readonly schemaVersion: typeof EARTH_SURFACE_TILE_INDEX_SCHEMA_VERSION;
  readonly datasetId: string;
  readonly entries: readonly EarthSurfaceTileIndexEntry[];
}

export interface EarthSurfaceTileFile {
  readonly url: string;
  readonly sha256: string;
  readonly encodedBytes: number;
  readonly payloadBytes: number;
}

export interface EarthSurfaceTileIndexEntry {
  readonly key: string;
  readonly z: number;
  readonly x: number;
  readonly y: number;
  readonly color: EarthSurfaceTileFile;
  readonly terrain: EarthSurfaceTileFile;
}

export interface EarthSurfaceTileDescriptor {
  readonly key: EarthTileKey;
  readonly colorUrl: string;
  readonly terrainUrl: string;
  readonly colorSha256: string;
  readonly terrainSha256: string;
  readonly colorEncodedBytes: number;
  readonly terrainEncodedBytes: number;
}

export interface EarthSurfaceTileRequestSourceInit {
  readonly tileIndexUrl: string;
  readonly baseUrl?: string;
  readonly expectedDatasetId?: string;
  readonly fetchImpl?: typeof fetch;
  /** 旧配信物に含まれるz0..z3を読み飛ばす。現行形式では無効のままにする。 */
  readonly allowLegacyLowZoom?: boolean;
}

function validSha256(value: string): boolean { return /^[0-9a-f]{64}$/.test(value); }

// 1件の配信ファイルについて、相対URL・ハッシュ・サイズを検証する。
function file(value: unknown, name: string): EarthSurfaceTileFile {
  // URL形式、SHA-256、エンコード前後のサイズをまとめて検証する。
  if (value === null || typeof value !== 'object') throw new EarthSurfaceRequestError(`${name} is not an object`);
  const candidate = value as Partial<EarthSurfaceTileFile>;
  if (typeof candidate.url !== 'string' || candidate.url.length === 0
    || candidate.url.startsWith('http:') || candidate.url.startsWith('https:') || candidate.url.includes('?')
    || candidate.url.includes('#') || candidate.url.includes('\\') || candidate.url.startsWith('/')
    || candidate.url.split('/').some((part) => part === '.' || part === '..')) {
    throw new EarthSurfaceRequestError(`${name} has an invalid URL`);
  }
  if (typeof candidate.sha256 !== 'string' || !validSha256(candidate.sha256)) {
    throw new EarthSurfaceRequestError(`${name} has an invalid SHA-256`);
  }
  const encodedBytes = candidate.encodedBytes;
  const payloadBytes = candidate.payloadBytes;
  if (typeof encodedBytes !== 'number' || !Number.isSafeInteger(encodedBytes) || encodedBytes <= 0
    || typeof payloadBytes !== 'number' || !Number.isSafeInteger(payloadBytes) || payloadBytes <= 0) {
    throw new EarthSurfaceRequestError(`${name} has invalid byte lengths`);
  }
  return { url: candidate.url, sha256: candidate.sha256, encodedBytes, payloadBytes };
}

// 生のtile-indexを検証し、現行要求で使うエントリへ正規化する。
function normalizeIndex(
  value: unknown, expectedDatasetId?: string, allowLegacyLowZoom = false,
): EarthSurfaceTileIndexFile {
  // schema・dataset・キー・ファイル記述を順に確認する。
  if (value === null || typeof value !== 'object') throw new EarthSurfaceRequestError('tile-index is not an object');
  const index = value as Partial<EarthSurfaceTileIndexFile>;
  if (index.schemaVersion !== EARTH_SURFACE_TILE_INDEX_SCHEMA_VERSION
    || typeof index.datasetId !== 'string' || !/^[a-z0-9-]+$/.test(index.datasetId)
    || !Array.isArray(index.entries) || index.entries.length === 0) {
    throw new EarthSurfaceRequestError('Invalid Earth surface tile-index');
  }
  if (expectedDatasetId !== undefined && index.datasetId !== expectedDatasetId) {
    throw new EarthSurfaceRequestError('Earth surface tile-index datasetId mismatch');
  }
  const entries: EarthSurfaceTileIndexEntry[] = [];
  const ids = new Set<string>();
  for (const valueEntry of index.entries) {
    if (valueEntry === null || typeof valueEntry !== 'object') throw new EarthSurfaceRequestError('Invalid tile-index entry');
    const entry = valueEntry as Partial<EarthSurfaceTileIndexEntry>;
    if (![entry.z, entry.x, entry.y].every(Number.isSafeInteger)
      || typeof entry.key !== 'string' || entry.key !== `${entry.z}/${entry.x}/${entry.y}`) {
      throw new EarthSurfaceRequestError('Invalid tile-index key');
    }
    const key = earthTileKey(entry.z!, entry.x!, entry.y!);
    if (key.z < EARTH_TILE_MIN_Z) {
      if (allowLegacyLowZoom) continue;
      throw new EarthSurfaceRequestError('Invalid tile-index key level');
    }
    if (earthTileId(key) !== entry.key || ids.has(entry.key)) throw new EarthSurfaceRequestError('Duplicate tile-index key');
    const raw = entry as unknown as Record<string, unknown>;
    const color = file(entry.color ?? {
      url: raw.colorUrl, sha256: raw.colorSha256,
      encodedBytes: raw.colorEncodedBytes, payloadBytes: raw.colorPayloadBytes,
    }, `tile-index ${entry.key} color`);
    const terrain = file(entry.terrain ?? {
      url: raw.terrainUrl, sha256: raw.terrainSha256,
      encodedBytes: raw.terrainEncodedBytes, payloadBytes: raw.terrainPayloadBytes,
    }, `tile-index ${entry.key} terrain`);
    if (!color.url.endsWith('.jpg') || !terrain.url.endsWith('.bin.gz')) {
      throw new EarthSurfaceRequestError('Invalid tile-index asset extension');
    }
    ids.add(entry.key);
    entries.push({ key: entry.key, z: key.z, x: key.x, y: key.y, color, terrain });
  }
  if (entries.length === 0) throw new EarthSurfaceRequestError('Earth surface tile-index has no z4+ entries');
  return { schemaVersion: EARTH_SURFACE_TILE_INDEX_SCHEMA_VERSION, datasetId: index.datasetId, entries };
}

// 配信物の相対パスをtile-indexのbase URLへ解決する。
function assetUrl(baseUrl: string, path: string): string {
  if (baseUrl.length === 0) return path;
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

// tile-indexの取得と解決を一度だけ行う。URL/hashの組み立てを要求ごとに繰り返さない。
export class EarthSurfaceTileRequestSource {
  private readonly fetchImpl: typeof fetch;
  private readonly indexUrl: string | null;
  private readonly baseUrl: string;
  private readonly expectedDatasetId: string | undefined;
  private readonly allowLegacyLowZoom: boolean;
  private readonly entries = new Map<string, EarthSurfaceTileDescriptor>();
  private loadPromise: Promise<void> | null = null;
  private loaded = false;

  // 既読indexまたは遅延読み込み設定を受けてsourceを初期化する。
  public constructor(indexOrInit: EarthSurfaceTileIndexFile | EarthSurfaceTileRequestSourceInit, baseUrl?: string) {
    // 既読データは直ちに登録し、設定形式はreadyまでI/Oを遅延する。
    if ('entries' in indexOrInit) {
      const index = normalizeIndex(indexOrInit);
      this.fetchImpl = fetch;
      this.indexUrl = null;
      this.baseUrl = baseUrl ?? '';
      this.expectedDatasetId = undefined;
      this.allowLegacyLowZoom = false;
      this.install(index);
      this.loaded = true;
    } else {
      this.fetchImpl = indexOrInit.fetchImpl ?? fetch;
      this.indexUrl = indexOrInit.tileIndexUrl;
      this.baseUrl = indexOrInit.baseUrl ?? new URL('.', indexOrInit.tileIndexUrl).toString();
      this.expectedDatasetId = indexOrInit.expectedDatasetId;
      this.allowLegacyLowZoom = indexOrInit.allowLegacyLowZoom ?? false;
    }
  }

  // indexを読み終えたsourceを返す。
  public static async load(init: EarthSurfaceTileRequestSourceInit): Promise<EarthSurfaceTileRequestSource> {
    const source = new EarthSurfaceTileRequestSource(init);
    await source.ready();
    return source;
  }

  // 未読ならindex読込を一度だけ開始し、その完了を待つ。
  public async ready(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise === null) this.loadPromise = this.loadIndex();
    await this.loadPromise;
  }

  // キーに対応する色・地形URLを返す。
  public urlFor(key: EarthTileKey): { readonly color: string; readonly terrain: string } | null {
    const descriptor = this.descriptorFor(key);
    return descriptor === null ? null : { color: descriptor.colorUrl, terrain: descriptor.terrainUrl };
  }

  // キーに対応する色・地形ハッシュを返す。
  public hashFor(key: EarthTileKey): { readonly color: string; readonly terrain: string } | null {
    const descriptor = this.descriptorFor(key);
    return descriptor === null ? null : { color: descriptor.colorSha256, terrain: descriptor.terrainSha256 };
  }

  // 読み込み済みindexから要求用descriptorを返す。
  public descriptorFor(key: EarthTileKey): EarthSurfaceTileDescriptor | null {
    if (!this.loaded) throw new Error('Earth surface tile-index is not loaded');
    return this.entries.get(earthTileId(key)) ?? null;
  }

  // index JSONを取得・検証し、URL解決済みdescriptorを登録する。
  private async loadIndex(): Promise<void> {
    // 同じPromiseを共有するready経由の読み込みだけを行う。
    if (this.indexUrl === null) return;
    const fetchImpl = this.fetchImpl;
    const response = await fetchImpl(this.indexUrl);
    if (!response.ok) throw new EarthSurfaceHttpError(response.status);
    let value: unknown;
    try { value = await response.json(); } catch (error) {
      throw new EarthSurfaceRequestError('Invalid Earth surface tile-index JSON', { cause: error });
    }
    this.install(normalizeIndex(value, this.expectedDatasetId, this.allowLegacyLowZoom));
    this.loaded = true;
  }

  // 正規化済みindexの各ファイルURLをdescriptor mapへ登録する。
  private install(index: EarthSurfaceTileIndexFile): void {
    // 要求時にURLを再計算しないよう、ここで解決して保持する。
    for (const entry of index.entries) {
      const key = earthTileKey(entry.z, entry.x, entry.y);
      this.entries.set(entry.key, {
        key,
        colorUrl: assetUrl(this.baseUrl, entry.color.url),
        terrainUrl: assetUrl(this.baseUrl, entry.terrain.url),
        colorSha256: entry.color.sha256,
        terrainSha256: entry.terrain.sha256,
        colorEncodedBytes: entry.color.encodedBytes,
        terrainEncodedBytes: entry.terrain.encodedBytes,
      });
    }
  }
}
