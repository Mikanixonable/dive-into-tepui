// タイル要求の重複排除、HTTP/decode/展開済み待機の上限、再試行を管理する。
import { decodeEarthSurfaceTile } from './earth-surface-tile-decode';
import type { EarthSurfaceTilePayload } from './earth-surface-tile-decode';
import { decodeEarthTerrainOffThread } from './earth-surface-terrain-worker-client';
import { earthTileId } from './earth-surface-tile-key';
import type { EarthTileKey } from './earth-surface-tile-key';
import { EarthSurfaceTileRequestSource } from './earth-surface-tile-source';
import type { EarthSurfaceTileDescriptor } from './earth-surface-tile-source';
import { EarthSurfaceHttpError, EarthSurfaceRequestError } from './earth-surface-request-errors';

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

interface PermitWaiter {
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: unknown) => void;
  readonly signal?: AbortSignal;
}

class PermitPool {
  private active = 0;
  private readonly waiting: PermitWaiter[] = [];

  // 同時実行数だけpermitを発行し、解放時に待機要求を進める。
  public constructor(private readonly capacity: number) {}

  // キャンセル済みでなければ待機列へ入り、permitの解放関数を受け取る。
  public acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new DOMException('Request was aborted', 'AbortError'));
    return new Promise((resolve, reject) => {
      const waiter: PermitWaiter = { resolve, reject, signal };
      this.waiting.push(waiter);
      this.pump();
    });
  }

  // 空いた枠をFIFOで埋め、待機中にキャンセルされた要求は読み飛ばす。
  private pump(): void {
    // 待機列から実行枠へ要求を移す。
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

// 失敗イベントへ載せる短い理由を作る。
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Fetch/decodeのAbortErrorを判定する。
function isAbort(error: unknown): boolean { return error instanceof DOMException && error.name === 'AbortError'; }

// timeoutまたは一時的なHTTP/ネットワーク失敗だけを再試行する。
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
  private counters = {
    httpReserved: 0, httpStarted: 0, httpReleased: 0,
    decodeReserved: 0, decodeStarted: 0, decodeReleased: 0,
    waitingReserved: 0, waitingReleased: 0, retries: 0,
  };

  // indexの準備完了を共有し、要求処理へ渡す。
  public constructor(
    private readonly source: EarthSurfaceTileRequestSource,
    private readonly options: EarthSurfaceTileRequestQueueOptions = {},
  ) {
    // tile-indexの読み込みを共有し、最初の要求までに一度だけ準備する。
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sourceReady = source.ready();
  }

  // 現在の上限カウンターと失敗・イベントのスナップショットを返す。
  public get metrics(): EarthSurfaceTileRequestMetrics {
    return { ...this.counters, failures: new Map(this.permanentFailuresEntries()), events: this.eventLog.slice() };
  }

  // 同じキー・世代の要求を共有し、別世代なら旧要求を中断して置き換える。
  public request(key: EarthTileKey, generation: number, signal?: AbortSignal): Promise<EarthSurfaceTilePayload> {
    if (this.disposed) return Promise.reject(new DOMException('Earth surface queue is disposed', 'AbortError'));
    if (!Number.isSafeInteger(generation) || generation < 0) return Promise.reject(new RangeError('Invalid Earth tile generation'));
    return this.sourceReady.then(() => this.requestLoaded(key, generation, signal));
  }

  // 読み込み済みindexからdescriptorを引き、要求を実行キューへ登録する。
  private requestLoaded(key: EarthTileKey, generation: number, signal?: AbortSignal): Promise<EarthSurfaceTilePayload> {
    // 準備済みdescriptorを使って、キー単位の要求を作成または共有する。
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
    const item = {
      id, key, generation, controller, waitingRelease: null, done: false, timedOut: false,
      promise: Promise.resolve(null as unknown as EarthSurfaceTilePayload),
    } as QueueItem;
    item.promise = this.run(item, descriptor).finally(() => signal?.removeEventListener('abort', onAbort));
    this.items.set(id, item);
    return item.promise;
  }

  // 完了済みpayloadの待機permitを解放し、同じ要求を再利用しない。
  public release(key: EarthTileKey, generation?: number): void {
    const item = this.items.get(earthTileId(key));
    if (item === undefined || (generation !== undefined && item.generation !== generation)) return;
    this.releaseWaiting(item);
    if (item.done) this.items.delete(item.id);
  }

  // キーに紐づく要求だけを中断する。
  public abort(key: EarthTileKey | string): void {
    const item = this.items.get(typeof key === 'string' ? key : earthTileId(key));
    item?.controller.abort();
  }

  // 保留中の全要求を中断し、待機permitを返す。
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const item of this.items.values()) {
      item.controller.abort();
      this.releaseWaiting(item);
    }
    this.items.clear();
  }

  // decode・HTTP・待機の順に資源を予約し、失敗種別に応じて再試行する。
  private async run(item: QueueItem, descriptor: EarthSurfaceTileDescriptor): Promise<EarthSurfaceTilePayload> {
    const retries = this.options.maxRetries ?? 2;
    for (let attempt = 0; ; attempt++) {
      try {
        // decode permitの寿命をpayloadが待機列へ入るまで管理する。
        const permit = await this.decode.acquire(item.controller.signal);
        this.counters.decodeReserved++;
        this.emit({ type: 'reserve', resource: 'decode', id: item.id, generation: item.generation });
        let decodeReleased = false;
        // decode permitと対応するメトリクスを一度だけ解放する。
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
              decodeImage: this.options.decodeImage, decodeTerrain: decodeEarthTerrainOffThread,
              expectedColorSha256: descriptor.colorSha256,
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

  // HTTP permitを取得して実際のfetchを包み、完了時に必ず解放する。
  private limitedFetch(generation: number): typeof fetch {
    // 各fetchをHTTP permitとメトリクスで包む。
    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const id = String(input);
      const permit = await this.http.acquire(init?.signal ?? undefined);
      this.counters.httpReserved++;
      this.emit({ type: 'reserve', resource: 'http', id, generation });
      this.counters.httpStarted++;
      this.emit({ type: 'start', resource: 'http', id, generation });
      const fetchImpl = this.fetchImpl;
      try { return await fetchImpl(input, init); }
      finally {
        this.counters.httpReleased++;
        permit();
        this.emit({ type: 'release', resource: 'http', id, generation });
      }
    };
  }

  // decode済みpayloadが保持している待機permitを返す。
  private releaseWaiting(item: QueueItem): void {
    if (item.waitingRelease === null) return;
    item.waitingRelease();
    item.waitingRelease = null;
    this.counters.waitingReleased++;
    this.emit({ type: 'release', resource: 'waiting', id: item.id, generation: item.generation });
  }

  // 失敗理由を読み取り用のMapへ変換する。
  private *permanentFailuresEntries(): IterableIterator<[string, string]> {
    for (const [id, error] of this.permanentFailures) yield [id, reasonOf(error)];
  }

  // メトリクスを履歴へ保存し、購読者へ転送する。
  private emit(event: EarthSurfaceTileRequestMetricEvent): void {
    this.eventLog.push(event);
    this.options.onMetric?.(event);
  }
}
