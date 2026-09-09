// 地表タイルの索引解決と、通信・デコード・展開待機を独立に制限する要求キュー。
// 到着順を表示順とみなさず、世代と版内のタイル識別子を境界にする。
import { decodeEarthSurfaceTile, EarthSurfaceHttpError } from './earth-surface-decode';
import type { EarthSurfaceTilePayload } from './earth-surface-decode';
import { earthTileId, earthTileKey } from './earth-surface-tiles';
import type { EarthTileKey } from './earth-surface-tiles';

export interface EarthSurfaceTileIndexFile {
  readonly schemaVersion: 1;
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
}

function validSha256(value: string): boolean { return /^[0-9a-f]{64}$/.test(value); }

function file(value: unknown, name: string): EarthSurfaceTileFile {
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

function normalizeIndex(value: unknown, expectedDatasetId?: string): EarthSurfaceTileIndexFile {
  if (value === null || typeof value !== 'object') throw new EarthSurfaceRequestError('tile-index is not an object');
  const index = value as Partial<EarthSurfaceTileIndexFile>;
  if (index.schemaVersion !== 1 || typeof index.datasetId !== 'string' || !/^[a-z0-9-]+$/.test(index.datasetId)
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
  return { schemaVersion: 1, datasetId: index.datasetId, entries };
}

function assetUrl(baseUrl: string, path: string): string {
  if (baseUrl.length === 0) return path;
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

export class EarthSurfaceRequestError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EarthSurfaceRequestError';
  }
}

// tile-indexの取得と解決を一度だけ行う。URL/hashの組み立てを要求ごとに繰り返さない。
export class EarthSurfaceTileRequestSource {
  private readonly fetchImpl: typeof fetch;
  private readonly indexUrl: string | null;
  private readonly baseUrl: string;
  private readonly expectedDatasetId: string | undefined;
  private readonly entries = new Map<string, EarthSurfaceTileDescriptor>();
  private loadPromise: Promise<void> | null = null;
  private loaded = false;

  public constructor(indexOrInit: EarthSurfaceTileIndexFile | EarthSurfaceTileRequestSourceInit, baseUrl?: string) {
    if ('entries' in indexOrInit) {
      const index = normalizeIndex(indexOrInit);
      this.fetchImpl = fetch;
      this.indexUrl = null;
      this.baseUrl = baseUrl ?? '';
      this.expectedDatasetId = undefined;
      this.install(index);
      this.loaded = true;
    } else {
      this.fetchImpl = indexOrInit.fetchImpl ?? fetch;
      this.indexUrl = indexOrInit.tileIndexUrl;
      this.baseUrl = indexOrInit.baseUrl ?? new URL('.', indexOrInit.tileIndexUrl).toString();
      this.expectedDatasetId = indexOrInit.expectedDatasetId;
    }
  }

  public static async load(init: EarthSurfaceTileRequestSourceInit): Promise<EarthSurfaceTileRequestSource> {
    const source = new EarthSurfaceTileRequestSource(init);
    await source.ready();
    return source;
  }

  public async ready(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise === null) {
      this.loadPromise = this.loadIndex();
    }
    await this.loadPromise;
  }

  public urlFor(key: EarthTileKey): { readonly color: string; readonly terrain: string } | null {
    const descriptor = this.descriptorFor(key);
    return descriptor === null ? null : { color: descriptor.colorUrl, terrain: descriptor.terrainUrl };
  }

  public hashFor(key: EarthTileKey): { readonly color: string; readonly terrain: string } | null {
    const descriptor = this.descriptorFor(key);
    return descriptor === null ? null : { color: descriptor.colorSha256, terrain: descriptor.terrainSha256 };
  }

  public descriptorFor(key: EarthTileKey): EarthSurfaceTileDescriptor | null {
    if (!this.loaded) throw new Error('Earth surface tile-index is not loaded');
    return this.entries.get(earthTileId(key)) ?? null;
  }

  private async loadIndex(): Promise<void> {
    if (this.indexUrl === null) return;
    const response = await this.fetchImpl(this.indexUrl);
    if (!response.ok) throw new EarthSurfaceHttpError(response.status);
    let value: unknown;
    try { value = await response.json(); } catch (error) {
      throw new EarthSurfaceRequestError('Invalid Earth surface tile-index JSON', { cause: error });
    }
    this.install(normalizeIndex(value, this.expectedDatasetId));
    this.loaded = true;
  }

  private install(index: EarthSurfaceTileIndexFile): void {
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

export interface EarthSurfaceTileRequestMetrics {
  readonly httpReserved: number;
  readonly httpStarted: number;
  readonly httpReleased: number;
  readonly decodeReserved: number;
  readonly decodeStarted: number;
  readonly decodeReleased: number;
  readonly waitingReserved: number;
  readonly waitingReleased: number;
  readonly retries: number;
  readonly failures: ReadonlyMap<string, string>;
  readonly events: readonly EarthSurfaceTileRequestMetricEvent[];
}

export interface EarthSurfaceTileRequestMetricEvent {
  readonly type: 'reserve' | 'start' | 'release' | 'failure' | 'retry';
  readonly resource: 'http' | 'decode' | 'waiting' | 'tile';
  readonly id: string;
  readonly generation: number;
  readonly reason?: string;
}

export interface EarthSurfaceTileRequestQueueOptions {
  readonly fetchImpl?: typeof fetch;
  readonly decodeImage?: (bytes: Uint8Array, signal?: AbortSignal) => Promise<unknown>;
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
  readonly onMetric?: (event: EarthSurfaceTileRequestMetricEvent) => void;
}

interface PermitWaiter { readonly resolve: (release: () => void) => void; readonly reject: (error: unknown) => void; readonly signal?: AbortSignal; }

class PermitPool {
  private active = 0;
  private readonly waiting: PermitWaiter[] = [];

  public constructor(private readonly capacity: number) {}

  public acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new DOMException('Request was aborted', 'AbortError'));
    return new Promise((resolve, reject) => {
      const waiter: PermitWaiter = { resolve, reject, signal };
      this.waiting.push(waiter);
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < this.capacity && this.waiting.length > 0) {
      const waiter = this.waiting.shift()!;
      if (waiter.signal?.aborted) {
        waiter.reject(new DOMException('Request was aborted', 'AbortError'));
        continue;
      }
      this.active++;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        this.pump();
      });
    }
  }
}

interface QueueItem {
  readonly id: string;
  readonly key: EarthTileKey;
  readonly generation: number;
  readonly controller: AbortController;
  promise: Promise<EarthSurfaceTilePayload>;
  waitingRelease: (() => void) | null;
  done: boolean;
  timedOut: boolean;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbort(error: unknown): boolean { return error instanceof DOMException && error.name === 'AbortError'; }

function isRetryable(error: unknown, timedOut: boolean): boolean {
  if (timedOut || error instanceof TypeError) return true;
  if (error instanceof EarthSurfaceHttpError) return error.status === 408 || error.status === 429 || error.status >= 500;
  return false;
}

// タイル単位を重複排除し、HTTP 6 / decode 2 / 展開済み待機 8を別々に数える。
export class EarthSurfaceTileRequestQueue {
  private readonly fetchImpl: typeof fetch;
  private readonly http = new PermitPool(6);
  private readonly decode = new PermitPool(2);
  private readonly waiting = new PermitPool(8);
  private readonly items = new Map<string, QueueItem>();
  private readonly permanentFailures = new Map<string, Error>();
  private readonly eventLog: EarthSurfaceTileRequestMetricEvent[] = [];
  private readonly sourceReady: Promise<void>;
  private disposed = false;
  private counters = { httpReserved: 0, httpStarted: 0, httpReleased: 0, decodeReserved: 0, decodeStarted: 0, decodeReleased: 0, waitingReserved: 0, waitingReleased: 0, retries: 0 };

  public constructor(private readonly source: EarthSurfaceTileRequestSource, private readonly options: EarthSurfaceTileRequestQueueOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sourceReady = source.ready();
  }

  public get metrics(): EarthSurfaceTileRequestMetrics {
    return { ...this.counters, failures: new Map(this.permanentFailuresEntries()), events: this.eventLog.slice() };
  }

  public request(key: EarthTileKey, generation: number, signal?: AbortSignal): Promise<EarthSurfaceTilePayload> {
    if (this.disposed) return Promise.reject(new DOMException('Earth surface queue is disposed', 'AbortError'));
    if (!Number.isSafeInteger(generation) || generation < 0) return Promise.reject(new RangeError('Invalid Earth tile generation'));
    return this.sourceReady.then(() => this.requestLoaded(key, generation, signal));
  }

  private requestLoaded(key: EarthTileKey, generation: number, signal?: AbortSignal): Promise<EarthSurfaceTilePayload> {
    if (this.disposed) return Promise.reject(new DOMException('Earth surface queue is disposed', 'AbortError'));
    const id = earthTileId(key);
    const permanent = this.permanentFailures.get(id);
    if (permanent !== undefined) return Promise.reject(permanent);
    const existing = this.items.get(id);
    if (existing !== undefined) {
      if (existing.generation === generation) return existing.promise;
      this.abort(id);
      this.releaseWaiting(existing);
      this.items.delete(id);
    }
    const descriptor = this.source.descriptorFor(key);
    if (descriptor === null) {
      const error = new EarthSurfaceRequestError(`No tile-index entry for ${id}`);
      this.permanentFailures.set(id, error);
      return Promise.reject(error);
    }
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const item = { id, key, generation, controller, waitingRelease: null, done: false, timedOut: false, promise: Promise.resolve(null as unknown as EarthSurfaceTilePayload) } as QueueItem;
    item.promise = this.run(item, descriptor).finally(() => signal?.removeEventListener('abort', onAbort));
    this.items.set(id, item);
    return item.promise;
  }

  public release(key: EarthTileKey, generation?: number): void {
    const item = this.items.get(earthTileId(key));
    if (item === undefined || (generation !== undefined && item.generation !== generation)) return;
    this.releaseWaiting(item);
    if (item.done) this.items.delete(item.id);
  }

  public abort(key: EarthTileKey | string): void {
    const item = this.items.get(typeof key === 'string' ? key : earthTileId(key));
    item?.controller.abort();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const item of this.items.values()) {
      item.controller.abort();
      this.releaseWaiting(item);
    }
    this.items.clear();
  }

  private async run(item: QueueItem, descriptor: EarthSurfaceTileDescriptor): Promise<EarthSurfaceTilePayload> {
    const retries = this.options.maxRetries ?? 2;
    for (let attempt = 0; ; attempt++) {
      try {
        const permit = await this.decode.acquire(item.controller.signal);
        this.counters.decodeReserved++;
        this.emit({ type: 'reserve', resource: 'decode', id: item.id, generation: item.generation });
        let decodeReleased = false;
        const releaseDecode = (): void => {
          if (decodeReleased) return;
          decodeReleased = true;
          this.counters.decodeReleased++;
          permit();
          this.emit({ type: 'release', resource: 'decode', id: item.id, generation: item.generation });
        };
        try {
          this.counters.decodeStarted++;
          this.emit({ type: 'start', resource: 'decode', id: item.id, generation: item.generation });
          const attemptController = new AbortController();
          const abortAttempt = (): void => attemptController.abort();
          item.controller.signal.addEventListener('abort', abortAttempt, { once: true });
          if (item.controller.signal.aborted) attemptController.abort();
          const timeout = this.options.timeoutMs === undefined ? null : setTimeout(() => {
            item.timedOut = true;
            attemptController.abort();
          }, this.options.timeoutMs);
          let payload: EarthSurfaceTilePayload;
          try {
            payload = await decodeEarthSurfaceTile({
              key: item.key, colorUrl: descriptor.colorUrl, terrainUrl: descriptor.terrainUrl,
              generation: item.generation, signal: attemptController.signal,
              fetchImpl: this.limitedFetch(item.generation),
              decodeImage: this.options.decodeImage, expectedColorSha256: descriptor.colorSha256,
              expectedTerrainSha256: descriptor.terrainSha256, expectedColorBytes: descriptor.colorEncodedBytes,
              expectedTerrainEncodedBytes: descriptor.terrainEncodedBytes,
            });
          } finally {
            if (timeout !== null) clearTimeout(timeout);
            item.controller.signal.removeEventListener('abort', abortAttempt);
          }
          releaseDecode();
          const waitingPermit = await this.waiting.acquire(item.controller.signal);
          this.counters.waitingReserved++;
          item.waitingRelease = waitingPermit;
          this.emit({ type: 'reserve', resource: 'waiting', id: item.id, generation: item.generation });
          item.done = true;
          return payload;
        } catch (error) {
          releaseDecode();
          throw error;
        }
      } catch (error) {
        if (this.disposed || isAbort(error) && !item.timedOut) {
          this.emit({ type: 'failure', resource: 'tile', id: item.id, generation: item.generation, reason: 'abort' });
          throw error;
        }
        if (attempt < retries && isRetryable(error, item.timedOut)) {
          item.timedOut = false;
          this.counters.retries++;
          this.emit({ type: 'retry', resource: 'tile', id: item.id, generation: item.generation, reason: reasonOf(error) });
          continue;
        }
        const failure = error instanceof Error ? error : new EarthSurfaceRequestError(reasonOf(error));
        this.permanentFailures.set(item.id, failure);
        this.emit({ type: 'failure', resource: 'tile', id: item.id, generation: item.generation, reason: reasonOf(error) });
        throw failure;
      }
    }
  }

  private limitedFetch(generation: number): typeof fetch {
    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const id = String(input);
      const permit = await this.http.acquire(init?.signal ?? undefined);
      this.counters.httpReserved++;
      this.emit({ type: 'reserve', resource: 'http', id, generation });
      this.counters.httpStarted++;
      this.emit({ type: 'start', resource: 'http', id, generation });
      try { return await this.fetchImpl(input, init); }
      finally {
        this.counters.httpReleased++;
        permit();
        this.emit({ type: 'release', resource: 'http', id, generation });
      }
    };
  }

  private releaseWaiting(item: QueueItem): void {
    if (item.waitingRelease === null) return;
    item.waitingRelease();
    item.waitingRelease = null;
    this.counters.waitingReleased++;
    this.emit({ type: 'release', resource: 'waiting', id: item.id, generation: item.generation });
  }

  private *permanentFailuresEntries(): IterableIterator<[string, string]> {
    for (const [id, error] of this.permanentFailures) yield [id, reasonOf(error)];
  }

  private emit(event: EarthSurfaceTileRequestMetricEvent): void {
    this.eventLog.push(event);
    this.options.onMetric?.(event);
  }
}

export { EarthSurfaceTileRequestQueue as EarthSurfaceRequestQueue };
