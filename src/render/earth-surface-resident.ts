// 地表タイルの要求、同一層への色・地形投入、ページ表公開を1フレーム境界へ束ねる。
import {
  EarthSurfaceTiles,
} from './earth-surface-tiles';
import { EARTH_BASE_LAYER, EARTH_TILE_LAYERS, earthTileId } from './earth-surface-tile-key';
import type { EarthTileKey } from './earth-surface-tile-key';
import type { EarthTileResident } from './earth-surface-tiles';
import type { EarthTileProjection } from './earth-surface-tile-projection';
import { closeEarthSurfaceImage } from './earth-surface-tile-decode';
import { EarthSurfaceGpuAdapter } from './earth-surface-gpu';
import type { EarthLayerReservation, EarthSurfaceGpuTextures } from './earth-surface-gpu';
import { EarthSurfaceTileRequestQueue } from './earth-surface-tile-queue';

export type EarthSurfaceColorToRgba8 =
  (color: unknown, key: EarthTileKey) => Uint8Array | Promise<Uint8Array>;

export interface EarthSurfaceResidentCoordinatorDependencies {
  readonly tiles: EarthSurfaceTiles;
  readonly queue: EarthSurfaceTileRequestQueue;
  readonly gpu: EarthSurfaceGpuAdapter;
  readonly colorToRgba8: EarthSurfaceColorToRgba8;
}

export interface EarthSurfaceResidentFrame {
  readonly projection: EarthTileProjection;
  readonly timeMs: number;
  readonly generation: number;
  readonly signal?: AbortSignal;
  // 省略時はcoordinatorが単調増加する番号を割り当てる。
  readonly frame?: number;
}

export interface EarthSurfaceResidentFrameResult {
  readonly frontier: readonly EarthTileResident[];
  readonly requested: readonly EarthTileKey[];
  readonly published: boolean;
}

interface PendingTile {
  readonly key: EarthTileKey;
  readonly generation: number;
  readonly kind: 'visible' | 'prefetch';
  promise: Promise<void>;
}

interface ResidentTile {
  readonly key: EarthTileKey;
  readonly reservation: EarthLayerReservation;
  state: 'uploading' | 'uploaded';
  lastUsedFrame: number;
}

const MAX_PENDING_TILES = 8;
const MAX_PREFETCH_PENDING_TILES = 2;

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function pageLayers(table: Uint8Array): ReadonlySet<number> {
  const layers = new Set<number>();
  for (let offset = 0; offset < table.length; offset += 4) {
    const layer = table[offset]!;
    const parent = table[offset + 1]!;
    if (layer !== EARTH_BASE_LAYER) layers.add(layer);
    if (parent !== EARTH_BASE_LAYER) layers.add(parent);
  }
  return layers;
}

export class EarthSurfaceResidentCoordinator {
  private readonly pending = new Map<string, PendingTile>();
  private readonly residents = new Map<string, ResidentTile>();
  private readonly tasks = new Set<Promise<void>>();
  private activeGeneration = -1;
  private nextFrame = 0;
  private recentFailureReason: string | null = null;
  private residentRevision = 0;
  private lastResidentRevision = -1;
  private lastProjection: EarthTileProjection | null = null;
  private lastGeneration = -1;
  private lastTimeMs: number | null = null;
  private synchronized = false;
  private lastResult: EarthSurfaceResidentFrameResult = { frontier: [], requested: [], published: false };
  private disposed = false;

  public constructor(private readonly dependencies: EarthSurfaceResidentCoordinatorDependencies) {}

  // EarthSurfaceの材質が同じGPUテクスチャを読むための接点。選択・公開状態はcoordinatorが所有する。
  public get textures(): EarthSurfaceGpuTextures | null { return this.dependencies.gpu.textures; }

  // 描画に利用可能なアップロード済みresidentの最高z。
  public get residentMaxZ(): number | null {
    let maxZ: number | null = null;
    for (const resident of this.residents.values()) {
      if (resident.state !== 'uploaded') continue;
      maxZ = maxZ === null ? resident.key.z : Math.max(maxZ, resident.key.z);
    }
    return maxZ;
  }

  // 恒久queue失敗を優先し、なければcoordinatorが捕捉した直近タイル失敗を返す。
  public get failureReason(): string | null {
    const permanentFailures = this.dependencies.queue.metrics.failures;
    const latestPermanent = [...permanentFailures].at(-1);
    return latestPermanent === undefined
      ? this.recentFailureReason
      : `tile ${latestPermanent[0]}: ${latestPermanent[1]}`;
  }

  // 現在公開可能なページを先に交換し、その後に不要層を回収して要求を発行する。
  // したがって到着途中の色・地形は次フレームまでページ表へ現れない。
  public sync(input: EarthSurfaceResidentFrame): EarthSurfaceResidentFrameResult {
    if (this.disposed) return { frontier: [], requested: [], published: false };
    if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
      throw new RangeError('Invalid Earth tile generation');
    }
    if (!Number.isFinite(input.timeMs)) throw new RangeError('Invalid Earth drawing time');
    const frame = input.frame ?? this.nextFrame;
    if (!Number.isSafeInteger(frame) || frame < 0) throw new RangeError('Invalid Earth frame');
    this.nextFrame = Math.max(this.nextFrame, frame + 1);
    if (this.activeGeneration !== -1 && this.activeGeneration !== input.generation) this.cancelOldRequests(input.generation);
    this.activeGeneration = input.generation;

    const fadeTimeChanged = this.lastTimeMs !== input.timeMs
      && (this.dependencies.tiles.hasActiveFades(input.timeMs)
        || (this.lastTimeMs !== null && this.dependencies.tiles.hasActiveFades(this.lastTimeMs)));
    const dirty = !this.synchronized
      || this.lastGeneration !== input.generation
      || this.lastProjection !== input.projection
      || this.lastResidentRevision !== this.residentRevision
      || fadeTimeChanged;
    if (!dirty) {
      this.lastTimeMs = input.timeMs;
      return { frontier: this.lastResult.frontier, requested: [], published: false };
    }

    const visible = this.dependencies.tiles.requestCandidates(input.projection);
    const prefetch = this.dependencies.tiles.prefetchCandidates(input.projection, visible);
    const residents = this.dependencies.gpu.mode === 'tiles' ? this.dependencies.gpu.uploadedTiles() : [];
    this.dependencies.tiles.sync(input.projection, residents, input.timeMs, visible);
    this.lastProjection = input.projection;
    this.lastGeneration = input.generation;
    this.lastTimeMs = input.timeMs;
    this.lastResidentRevision = this.residentRevision;
    this.synchronized = true;
    if (this.dependencies.gpu.mode === 'base') {
      this.lastResult = {
        frontier: this.dependencies.tiles.frontier.slice(), requested: [], published: false,
      };
      return this.lastResult;
    }
    const page = this.dependencies.tiles.pageTable();
    this.touchPinned(page);
    this.dependencies.gpu.stagePageTable(page);
    const published = this.dependencies.gpu.publishFrame(frame);

    const requested = this.requestCandidates(input, visible, prefetch);
    this.lastResult = {
      frontier: this.dependencies.tiles.frontier.slice(), requested, published,
    };
    return this.lastResult;
  }

  // 進行中のdecode・色変換・GPU投入が落ち着くまで待つ。テストと実装側の境界を同期APIへ漏らさない。
  public async settle(): Promise<void> {
    while (this.tasks.size > 0) await Promise.all([...this.tasks]);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.reset();
    this.dependencies.queue.dispose();
    this.dependencies.gpu.dispose();
  }

  // 進行中の取得だけを中断する。アップロード済みの層とページ選択は再表示へ保持する。
  public cancelPending(): void {
    for (const pending of this.pending.values()) {
      this.dependencies.queue.abort(pending.key);
      this.dependencies.queue.release(pending.key, pending.generation);
    }
    this.pending.clear();
  }

  // 非表示または配信版切り替え時に、要求・公開ページ・常駐層をbaseへ戻す。
  // queueとGPU backend自体は再表示で再利用するため、disposeとは分ける。
  public reset(): void {
    this.cancelPending();
    this.residents.clear();
    this.dependencies.tiles.reset();
    this.dependencies.gpu.reset();
    this.activeGeneration = -1;
    this.nextFrame = 0;
    this.recentFailureReason = null;
    this.residentRevision++;
    this.lastResidentRevision = -1;
    this.lastProjection = null;
    this.lastGeneration = -1;
    this.lastTimeMs = null;
    this.synchronized = false;
    this.lastResult = { frontier: [], requested: [], published: false };
  }

  private cancelOldRequests(generation: number): void {
    for (const [id, pending] of this.pending) {
      if (pending.generation === generation) continue;
      this.dependencies.queue.abort(pending.key);
      this.dependencies.queue.release(pending.key, pending.generation);
      if (this.pending.get(id) === pending) this.pending.delete(id);
    }
  }

  private requestCandidates(
    input: EarthSurfaceResidentFrame, visible: readonly EarthTileKey[], prefetch: readonly EarthTileKey[],
  ): readonly EarthTileKey[] {
    const wanted = new Set([...visible, ...prefetch].map((key) => earthTileId(key)));
    this.cancelObsoleteRequests(wanted);
    const known = new Set<string>([
      ...this.residents.keys(), ...this.pending.keys(),
    ]);
    this.evictForCandidates(visible, known);
    const freeLayers = this.freeLayerCount();
    const maxNewRequests = Math.min(freeLayers, Math.max(0, MAX_PENDING_TILES - this.pending.size));
    const requested: EarthTileKey[] = [];
    const prefetchPending = [...this.pending.values()].filter((pending) => pending.kind === 'prefetch').length;
    const maxNewPrefetch = Math.max(0, MAX_PREFETCH_PENDING_TILES - prefetchPending);
    const admit = (key: EarthTileKey, kind: PendingTile['kind']): void => {
      if (known.has(earthTileId(key)) || requested.length >= maxNewRequests) return;
      const id = earthTileId(key);
      requested.push(key);
      known.add(id);
      const pending: PendingTile = { key, generation: input.generation, kind, promise: Promise.resolve() };
      pending.promise = this.startRequest(pending, input.signal);
      this.pending.set(id, pending);
      this.tasks.add(pending.promise);
      void pending.promise.finally(() => this.tasks.delete(pending.promise));
    };
    for (const key of visible) admit(key, 'visible');
    let admittedPrefetch = 0;
    for (const key of prefetch) {
      if (admittedPrefetch >= maxNewPrefetch || requested.length >= maxNewRequests) break;
      const before = requested.length;
      admit(key, 'prefetch');
      if (requested.length > before) admittedPrefetch++;
    }
    return requested;
  }

  private cancelObsoleteRequests(wanted: ReadonlySet<string>): void {
    for (const [id, pending] of this.pending) {
      if (wanted.has(id)) continue;
      this.dependencies.queue.abort(pending.key);
      this.dependencies.queue.release(pending.key, pending.generation);
      if (this.pending.get(id) === pending) this.pending.delete(id);
    }
  }

  private startRequest(pending: PendingTile, signal?: AbortSignal): Promise<void> {
    return this.dependencies.queue.request(pending.key, pending.generation, signal).then(async (payload) => {
      try {
        if (this.disposed || pending.generation !== this.activeGeneration || payload.generation !== pending.generation
          || signal?.aborted) return;
        const color = await this.dependencies.colorToRgba8(payload.color, pending.key);
        if (this.disposed || pending.generation !== this.activeGeneration || signal?.aborted) return;
        const layer = this.findFreeLayer();
        if (layer === null) return;
        this.dependencies.gpu.reserveLayer(pending.key, layer);
        const reservation = this.dependencies.gpu.reservation(layer);
        if (reservation === null) throw new Error('Earth layer reservation disappeared');
        const resident: ResidentTile = { key: pending.key, reservation, state: 'uploading', lastUsedFrame: this.nextFrame };
        const id = earthTileId(pending.key);
        this.residents.set(id, resident);
        try {
          await this.dependencies.gpu.uploadLayer(color, payload.terrain, reservation);
          if (this.disposed || pending.generation !== this.activeGeneration || signal?.aborted) {
            if (!this.disposed && this.dependencies.gpu.reservation(layer) === reservation) {
              this.dependencies.gpu.releaseLayer(reservation);
            }
            if (this.residents.get(id) === resident) this.residents.delete(id);
            return;
          }
          if (this.dependencies.gpu.reservation(layer) !== reservation) {
            if (this.residents.get(id) === resident) this.residents.delete(id);
            return;
          }
          resident.state = 'uploaded';
        } catch (error) {
          if (this.residents.get(id) === resident) {
            this.residents.delete(id);
          }
          if (!this.disposed && this.dependencies.gpu.reservation(layer) === reservation) {
            this.dependencies.gpu.releaseLayer(reservation);
          }
          throw error;
        }
      } finally {
        closeEarthSurfaceImage(payload.color);
      }
    }).catch((error: unknown) => {
      // Queueの版内失敗はqueue自身が保持する。GPU投入・色変換の失敗は一時的な
      // backend状態でも起こり得るため、coordinator側では直近の診断だけへ記録する。
      if (this.disposed || isAbort(error) || signal?.aborted || pending.generation !== this.activeGeneration) return;
      if (!this.dependencies.queue.metrics.failures.has(earthTileId(pending.key))) {
        const reason = error instanceof Error ? error.message : String(error);
        this.recentFailureReason = `tile ${earthTileId(pending.key)}: ${reason}`;
      }
    }).finally(() => {
      this.residentRevision++;
      this.dependencies.queue.release(pending.key, pending.generation);
      if (this.pending.get(earthTileId(pending.key))?.promise === pending.promise) {
        this.pending.delete(earthTileId(pending.key));
      }
    });
  }

  private freeLayerCount(): number {
    let count = 0;
    for (let layer = 0; layer < EARTH_TILE_LAYERS; layer++) {
      if (this.dependencies.gpu.reservation(layer) === null) count++;
    }
    return count;
  }

  private findFreeLayer(): number | null {
    for (let layer = 0; layer < EARTH_TILE_LAYERS; layer++) {
      if (this.dependencies.gpu.reservation(layer) === null) return layer;
    }
    return null;
  }

  private touchPinned(table: Uint8Array): void {
    const pinned = new Set(this.dependencies.tiles.pinnedLayers());
    for (const layer of pageLayers(table)) pinned.add(layer);
    for (const resident of this.residents.values()) {
      if (pinned.has(resident.reservation.layer)) resident.lastUsedFrame = this.nextFrame;
    }
  }

  private evictForCandidates(candidates: readonly EarthTileKey[], known: ReadonlySet<string>): void {
    const unknown = candidates.filter((key) => !known.has(earthTileId(key))).length;
    const candidateIds = new Set(candidates.map((key) => earthTileId(key)));
    const pendingCapacity = Math.max(0, MAX_PENDING_TILES - this.pending.size);
    const available = this.freeLayerCount();
    const admitted = Math.min(unknown, pendingCapacity);
    const needed = Math.max(0, admitted - available);
    if (needed === 0) return;
    const pinned = new Set(this.dependencies.tiles.pinnedLayers());
    for (const layer of pageLayers(this.dependencies.tiles.pageTable())) pinned.add(layer);
    const evictable = [...this.residents.entries()]
      .filter(([id, resident]) => resident.state === 'uploaded' && !candidateIds.has(id)
        && !pinned.has(resident.reservation.layer))
      .sort((a, b) => a[1].lastUsedFrame - b[1].lastUsedFrame);
    for (const [id, resident] of evictable.slice(0, needed)) {
      this.dependencies.gpu.releaseLayer(resident.reservation);
      this.residents.delete(id);
      this.residentRevision++;
    }
  }
}

export { EarthSurfaceResidentCoordinator as EarthSurfaceResident };
