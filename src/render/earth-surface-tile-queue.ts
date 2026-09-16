// タイル要求の重複排除、HTTP/decode/展開済み待機の上限、再試行を管理する。
import { decodeEarthSurfaceTileBytes, downloadEarthSurfaceTile } from './earth-surface-tile-decode';
import type { EarthSurfaceTilePayload } from './earth-surface-tile-decode';
import { decodeEarthTerrainOffThread } from './earth-surface-terrain-worker-client';
import { earthTileId } from './earth-surface-tile-key';
import type { EarthTileKey } from './earth-surface-tile-key';
import { EarthSurfaceTileSource } from './earth-surface-tile-source';
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
  readonly abort: () => void;
}

class PermitPool {
  private active = 0;
  private readonly waiting: PermitWaiter[] = [];

  public constructor(private readonly capacity: number) {}

  // 空き枠を待ち、返却関数を一度だけ発行する。
  public acquire(signal?: AbortSignal): Promise<() => void> {
    // 中断可能な待機者を登録し、pumpで枠を受け取る。
    if (signal?.aborted) return Promise.reject(new DOMException('Request was aborted', 'AbortError'));
    return new Promise((resolve, reject) => {
      // 待機列から自身を取り除いて失敗させる。
      const abort = (): void => {
        const index = this.waiting.indexOf(waiter);
        if (index === -1) return;
        this.waiting.splice(index, 1);
        reject(new DOMException('Request was aborted', 'AbortError'));
      };
      const waiter: PermitWaiter = { resolve, reject, signal, abort };
      this.waiting.push(waiter);
      signal?.addEventListener('abort', abort, { once: true });
      this.pump();
    });
  }

  // 待機列から中断されていない要求へ枠を配る。
  private pump(): void {
    // 利用可能な枠を待機者へ順番に渡す。
    while (this.active < this.capacity && this.waiting.length > 0) {
      const waiter = this.waiting.shift()!;
      waiter.signal?.removeEventListener('abort', waiter.abort);
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

// 失敗を診断表示用の文字列へ正規化する。
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// AbortErrorを再試行対象から分離する。
function isAbort(error: unknown): boolean { return error instanceof DOMException && error.name === 'AbortError'; }

// ネットワーク一時失敗だけを再試行対象にする。
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
  private disposed = false;
  private counters = {
    httpReserved: 0, httpStarted: 0, httpReleased: 0,
    decodeReserved: 0, decodeStarted: 0, decodeReleased: 0,
    waitingReserved: 0, waitingReleased: 0, retries: 0,
  };

  // 配信源と段ごとの同時実行設定を保持する。
  public constructor(
    private readonly source: EarthSurfaceTileSource,
    private readonly options: EarthSurfaceTileRequestQueueOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  // 現在の枠使用量、失敗、イベント履歴をスナップショットで返す。
  public get metrics(): EarthSurfaceTileRequestMetrics {
    return { ...this.counters, failures: new Map(this.permanentFailuresEntries()), events: this.eventLog.slice() };
  }

  // 世代付きタイル要求を重複排除して開始する。
  public request(key: EarthTileKey, generation: number, signal?: AbortSignal): Promise<EarthSurfaceTilePayload> {
    if (this.disposed) return Promise.reject(new DOMException('Earth surface queue is disposed', 'AbortError'));
    if (!Number.isSafeInteger(generation) || generation < 0) return Promise.reject(new RangeError('Invalid Earth tile generation'));
    return this.requestLoaded(key, generation, signal);
  }

  // 同一タイルの要求を共有し、世代が変われば旧要求を置き換える。
  private requestLoaded(key: EarthTileKey, generation: number, signal?: AbortSignal): Promise<EarthSurfaceTilePayload> {
    // 既存要求を共有し、世代交代時は旧項目を置き換える。
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
      const error = new EarthSurfaceRequestError(`Earth surface tile is outside coverage: ${id}`);
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

  // 呼び出し側の参照を解放し、完了済み項目を索引から外す。
  public release(key: EarthTileKey, generation?: number): void {
    const item = this.items.get(earthTileId(key));
    if (item === undefined || (generation !== undefined && item.generation !== generation)) return;
    this.releaseWaiting(item);
    if (item.done) this.items.delete(item.id);
  }

  // 指定タイルの取得と待機枠を中断する。
  public abort(key: EarthTileKey | string): void {
    const id = typeof key === 'string' ? key : earthTileId(key);
    const item = this.items.get(id);
    if (item === undefined) return;
    item.controller.abort();
    this.releaseWaiting(item);
    this.items.delete(id);
  }

  // キュー全体を停止し、保持中の取得を中断する。
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const item of this.items.values()) {
      item.controller.abort();
      this.releaseWaiting(item);
    }
    this.items.clear();
  }

  // HTTP、decode、展開済み待機の各枠を順に通過させる。
  private async run(item: QueueItem, descriptor: EarthSurfaceTileDescriptor): Promise<EarthSurfaceTilePayload> {
    const retries = this.options.maxRetries ?? 2;
    for (let attempt = 0; ; attempt++) {
      try {
        // 取得段は短時間で解放し、decode段の同時実行数を独立に制御する。
        const attemptController = new AbortController();
        const abortAttempt = (): void => attemptController.abort();
        item.controller.signal.addEventListener('abort', abortAttempt, { once: true });
        if (item.controller.signal.aborted) attemptController.abort();
        const timeout = this.options.timeoutMs === undefined ? null : setTimeout(() => {
          item.timedOut = true;
          attemptController.abort();
        }, this.options.timeoutMs);
        const request = {
          key: item.key, colorUrl: descriptor.colorUrl, terrainUrl: descriptor.terrainUrl,
          generation: item.generation, signal: attemptController.signal,
          fetchImpl: this.limitedFetch(item.generation),
          decodeImage: this.options.decodeImage, decodeTerrain: decodeEarthTerrainOffThread,
        };
        let bytes;
        try {
          bytes = await downloadEarthSurfaceTile(request);
        } catch (error) {
          attemptController.abort();
          if (timeout !== null) clearTimeout(timeout);
          item.controller.signal.removeEventListener('abort', abortAttempt);
          throw error;
        }
        let permit: () => void;
        try {
          permit = await this.decode.acquire(item.controller.signal);
        } catch (error) {
          if (timeout !== null) clearTimeout(timeout);
          item.controller.signal.removeEventListener('abort', abortAttempt);
          throw error;
        }
        this.counters.decodeReserved++;
        this.emit({ type: 'reserve', resource: 'decode', id: item.id, generation: item.generation });
        let decodeReleased = false;
        // decode枠を二重解放せずに返却する。
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
          let payload: EarthSurfaceTilePayload;
          try {
            payload = await decodeEarthSurfaceTileBytes(request, bytes);
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
        if (this.disposed || item.controller.signal.aborted || isAbort(error) && !item.timedOut) {
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

  // HTTP枠を計測しながらfetch実装へ委譲する。
  private limitedFetch(generation: number): typeof fetch {
    // HTTP枠の計測と返却をfetchの前後へ付加する。
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

  // 展開済み待機枠を解放する。
  private releaseWaiting(item: QueueItem): void {
    if (item.waitingRelease === null) return;
    item.waitingRelease();
    item.waitingRelease = null;
    this.counters.waitingReleased++;
    this.emit({ type: 'release', resource: 'waiting', id: item.id, generation: item.generation });
  }

  // 恒久失敗を公開用の文字列へ変換する。
  private *permanentFailuresEntries(): IterableIterator<[string, string]> {
    for (const [id, error] of this.permanentFailures) yield [id, reasonOf(error)];
  }

  // 計測イベントを履歴へ保存し、任意の監視へ通知する。
  private emit(event: EarthSurfaceTileRequestMetricEvent): void {
    this.eventLog.push(event);
    this.options.onMetric?.(event);
  }
}
