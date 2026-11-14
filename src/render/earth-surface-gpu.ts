// 地球タイルのGPU機能検査、非公開層への色・地形の書込みとフレーム境界での公開を担う。
import {
  EARTH_BASE_LAYER, EARTH_TILE_EXTENT, EARTH_TILE_LAYERS,
} from './earth-surface-tile-key';
import { EARTH_PAGE_HEIGHT, EARTH_PAGE_WIDTH } from './earth-surface-layout';
import type { EarthTileKey } from './earth-surface-tile-key';
import type { EarthTileResident } from './earth-surface-tiles';
import type { DataArrayTexture, DataTexture } from 'three/webgpu';

// Three.js側の実テクスチャ。GPU固有の書込みはearth-surface-gpu-three.tsへ閉じ込める。
export interface EarthSurfaceGpuTextures {
  readonly color: DataArrayTexture;
  readonly terrain: DataArrayTexture;
  readonly pageTable: DataTexture;
}

export interface EarthSurfaceGpuCapabilities {
  readonly texture2dArray: boolean;
  readonly maxTextureArrayLayers: number;
  readonly colorSrgbLinear: boolean;
  readonly terrainRgba8Linear: boolean;
}

export interface EarthSurfaceGpuBackend {
  readonly capabilities: EarthSurfaceGpuCapabilities;
  readonly textures?: EarthSurfaceGpuTextures | null;
  // 解決時点で、後続の描画が書込みを読む順序を保証する。
  writeColor(layer: number, pixels: Uint8Array): Promise<void>;
  writeTerrain(layer: number, pixels: Uint8Array): Promise<void>;
  // フレーム境界で同期的に交換する。例外時は直前のページ表を維持する。
  swapPageTable(pixels: Uint8Array): void;
  dispose(): void;
}

export interface EarthLayerReservation extends EarthTileResident {
  readonly generation: number;
}

interface LayerSlot {
  readonly reservation: EarthLayerReservation;
  state: 'reserved' | 'uploading' | 'uploaded';
}

// 必須の線形標本化と配列層数がそろう場合に詳細タイルを利用できる。
export function supportsEarthSurfaceTiles(capabilities: EarthSurfaceGpuCapabilities): boolean {
  return capabilities.texture2dArray && capabilities.maxTextureArrayLayers >= EARTH_TILE_LAYERS
    && capabilities.colorSrgbLinear && capabilities.terrainRgba8Linear;
}

export class EarthSurfaceGpuAdapter {
  private readonly slots = new Map<number, LayerSlot>();
  private nextGeneration = 1;
  private published = new Set<number>();
  private staged: Uint8Array | null = null;
  private stagedLayers = new Set<number>();
  private lastFrame = -1;
  private disposed = false;
  private pendingUploads = 0;
  private resetEpoch = 0;

  // backendが報告する必須機能が不足した場合はadapterを組まず、呼び側は全球ベースへ戻す。
  public constructor(private readonly backend: EarthSurfaceGpuBackend) {
    if (!supportsEarthSurfaceTiles(backend.capabilities)) {
      throw new RangeError('Earth surface detail features unavailable');
    }
  }

  // material側が実テクスチャを読むための接点。fake backendではnullになる。
  public get textures(): EarthSurfaceGpuTextures | null { return this.backend.textures ?? null; }

  // 空いた層を予約する。予約の識別はreservation()から取得する。
  public reserveLayer(key: EarthTileKey, layer: number): void {
    this.requireActive();
    if (!Number.isInteger(layer) || layer < 0 || layer >= EARTH_TILE_LAYERS) throw new RangeError('Invalid Earth layer');
    if (this.slots.has(layer)) throw new Error('Earth layer is already reserved');
    this.slots.set(layer, { reservation: { key, layer, generation: this.nextGeneration++ }, state: 'reserved' });
  }

  // 未予約ならnull。返した識別子は解放後に再利用すると拒否される。
  public reservation(layer: number): EarthLayerReservation | null {
    return this.slots.get(layer)?.reservation ?? null;
  }

  // 色RGBA8/sRGBと地形RGBA8の同じ層への書込みがそろったとき、その予約を公開可能にする。
  public async uploadLayer(
    color: Uint8Array, terrain: Uint8Array, reservation: EarthLayerReservation,
  ): Promise<void> {
    this.requireActive();
    const slot = this.requireReservation(reservation);
    const uploadEpoch = this.resetEpoch;
    if (slot.state !== 'reserved') throw new Error('Earth layer is not writable');
    const componentCount = EARTH_TILE_EXTENT * EARTH_TILE_EXTENT * 4;
    if (color.length !== componentCount || terrain.length !== componentCount) throw new RangeError('Invalid Earth tile size');
    slot.state = 'uploading';
    this.pendingUploads++;
    try {
      // 片方が失敗しても他方のGPU書込みが終わるまで、その層を再利用可能にしない。
      const results = await Promise.allSettled([
        Promise.resolve().then(() => this.backend.writeColor(reservation.layer, color)),
        Promise.resolve().then(() => this.backend.writeTerrain(reservation.layer, terrain)),
      ]);
      if (this.disposed || uploadEpoch !== this.resetEpoch
        || this.slots.get(reservation.layer)?.reservation !== reservation) {
        if (this.slots.get(reservation.layer)?.reservation === reservation) {
          this.slots.delete(reservation.layer);
        }
        return;
      }
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      slot.state = 'uploaded';
    } catch (error) {
      slot.state = 'reserved';
      throw error;
    } finally {
      this.pendingUploads--;
      if (this.disposed && this.pendingUploads === 0) this.backend.dispose();
    }
  }

  // 色・地形の公開準備を終えた層を返す。表示側はこの集合からfrontierを選ぶ。
  public uploadedTiles(): readonly EarthTileResident[] {
    if (this.disposed) return [];
    return [...this.slots.values()].filter((slot) => slot.state === 'uploaded').map((slot) => slot.reservation);
  }

  // ページ表が参照する層を記録し、次のフレーム境界で公開する表を予約する。
  public stagePageTable(table: Uint8Array): void {
    this.requireActive();
    if (table.length !== EARTH_PAGE_WIDTH * EARTH_PAGE_HEIGHT * 4) throw new RangeError('Invalid Earth page table');
    const layers = new Set<number>();
    // 交換前に表が参照する層を集め、公開済みとみなして解放対象から外す。
    for (let offset = 0; offset < table.length; offset += 4) {
      const layer = table[offset]!;
      const parentLayer = table[offset + 1]!;
      if (layer !== EARTH_BASE_LAYER) layers.add(layer);
      if (parentLayer !== EARTH_BASE_LAYER) layers.add(parentLayer);
    }
    for (const layer of layers) this.requireUploaded(layer);
    this.staged = table.slice();
    this.stagedLayers = layers;
  }

  // 単調増加する描画フレーム番号ごとに最大1回交換する。交換した場合はtrue。
  public publishFrame(frame: number): boolean {
    if (this.disposed) return false;
    if (!Number.isInteger(frame) || frame < 0) throw new RangeError('Invalid Earth frame');
    if (frame <= this.lastFrame) return false;
    this.lastFrame = frame;
    if (this.staged === null) return false;
    // backendの交換が成功した時点で層の使用権も同時に移す。
    this.backend.swapPageTable(this.staged);
    this.published = this.stagedLayers;
    this.staged = null;
    this.stagedLayers = new Set();
    return true;
  }

  // 表示・遷移・次フレームの予約から外れ、GPU書込みが終わった層を解放する。
  public releaseLayer(reservation: EarthLayerReservation): void {
    const slot = this.requireReservation(reservation);
    if (this.published.has(reservation.layer) || this.stagedLayers.has(reservation.layer)
      || slot.state === 'uploading') throw new Error('Earth layer is still in use');
    this.slots.delete(reservation.layer);
  }

  // 公開ページをbaseへ戻し、完了済みの詳細層を再利用可能にする。upload中の層だけは
  // backendの書込み完了まで保持し、同じ層へ早すぎる再利用をしない。
  public reset(): void {
    // 予約世代と公開層をそろえてから、baseページ表をGPUへ反映する。
    if (this.disposed) return;
    this.resetEpoch++;
    this.staged = null;
    this.stagedLayers.clear();
    this.published.clear();
    this.lastFrame = -1;
    for (const [layer, slot] of this.slots) {
      if (slot.state !== 'uploading') this.slots.delete(layer);
    }
    this.backend.swapPageTable(
      new Uint8Array(EARTH_PAGE_WIDTH * EARTH_PAGE_HEIGHT * 4).fill(EARTH_BASE_LAYER),
    );
  }

  // 世代を無効にし、進行中のGPU書込みが完了した時点でbackendの資源を解放する。
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.slots.clear();
    this.staged = null;
    this.stagedLayers.clear();
    this.published.clear();
    if (this.pendingUploads === 0) this.backend.dispose();
  }

  // 詳細タイルを操作できる寿命を検査する。
  private requireActive(): void {
    if (this.disposed) throw new Error('Earth GPU backend is disposed');
  }

  // 予約実体の一致で、解放済み・別世代・別adapterの予約を拒否する。
  private requireReservation(reservation: EarthLayerReservation): LayerSlot {
    const slot = this.slots.get(reservation.layer);
    if (slot === undefined || slot.reservation !== reservation) throw new Error('Stale Earth layer reservation');
    return slot;
  }

  // 色と地形がそろった層の識別を返す。
  private requireUploaded(layer: number): EarthLayerReservation {
    const slot = this.slots.get(layer);
    if (slot?.state !== 'uploaded') throw new Error('Earth page references an incomplete layer');
    return slot.reservation;
  }
}
