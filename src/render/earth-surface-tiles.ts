// 投影誤差から地域タイルを個別に選び、到着済みの詳細をページ表へ公開する。
import * as THREE from 'three/webgpu';
import {
  EARTH_BASE_LAYER, EARTH_TILE_MAX_Z, EARTH_TILE_MIN_Z,
  earthTileChildren, earthTileId, earthTileKey, earthTileNeighbors, earthTileParent,
  type EarthTileKey,
} from './earth-surface-tile-key';
import type { EarthTileProjection } from './earth-surface-tile-projection';
import type { EarthTileMetric } from './earth-surface-tile-projection';
import { EARTH_PAGE_HEIGHT, EARTH_PAGE_WIDTH } from './earth-surface-page-table';

const FADE_MS = 250; // 壁時計の描画時間 [ms]。
const SPLIT_ERROR_PX = 2;

export interface EarthTileResident {
  readonly key: EarthTileKey;
  readonly layer: number;
}

interface DisplayedTile extends EarthTileResident {
  readonly parentLayer: number;
  readonly fadeStartMs: number | null;
}

// 暗黙の全球基底と同じz4区画から可視性を絞り、z5全数の評価を避ける。
// 詳細選択の起点となるz4相当の全球区画を列挙する。
function selectionRoots(): readonly EarthTileKey[] {
  const z = EARTH_TILE_MIN_Z - 1;
  const rows = 2 ** z;
  return Array.from({ length: rows }, (_, y) => Array.from(
    { length: 2 * rows }, (_, x) => earthTileKey(z, x, y),
  )).flat();
}

// 投影優先度、LOD、IDの順に候補を安定ソートする。
function ordered(
  keys: Iterable<EarthTileKey>, metrics: ReadonlyMap<string, EarthTileMetric>,
): readonly EarthTileKey[] {
  return [...keys].sort((a, b) => {
    const priority = metrics.get(earthTileId(b))!.priority - metrics.get(earthTileId(a))!.priority;
    return priority || a.z - b.z || earthTileId(a).localeCompare(earthTileId(b));
  });
}

export class EarthSurfaceTiles {
  private displayed: readonly DisplayedTile[] = [];
  private fadeStarts = new Map<string, number>();
  private drawingTimeMs = 0;

  public get frontier(): readonly EarthTileResident[] { return this.displayed; }

  // 現在見える地域について、基底から目標LODまでの詳細キーを優先度順に返す。
  public requestCandidates(projection: EarthTileProjection): readonly EarthTileKey[] {
    const selection = this.visibleCandidates(projection);
    return ordered(selection.keys, selection.metrics);
  }

  // 可視地域の同段隣接を1タイル幅だけ返す。可視候補との重複は除く。
  public prefetchCandidates(
    projection: EarthTileProjection, visible = this.requestCandidates(projection),
  ): readonly EarthTileKey[] {
    // 可視候補に隣接する同LODタイルを先読み対象へ集める。
    const visibleIds = new Set(visible.map(earthTileId));
    const neighbors = new Map<string, EarthTileKey>();
    for (const key of visible) {
      for (const neighbor of earthTileNeighbors(key)) {
        const id = earthTileId(neighbor);
        if (!visibleIds.has(id)) neighbors.set(id, neighbor);
      }
    }
    const metrics = new Map<string, EarthTileMetric>();
    for (const neighbor of neighbors.values()) metrics.set(earthTileId(neighbor), projection.evaluate(neighbor));
    return ordered(neighbors.values(), metrics);
  }

  // 現在のページ表が参照する詳細層を返す。
  public pinnedLayers(): readonly number[] {
    const layers = new Set<number>();
    for (const tile of this.displayed) {
      layers.add(tile.layer);
      if (tile.parentLayer !== EARTH_BASE_LAYER) layers.add(tile.parentLayer);
    }
    return [...layers];
  }

  // 現在時刻で新着タイルの遷移が進行中かを返す。
  public hasActiveFades(timeMs = this.drawingTimeMs): boolean {
    return [...this.fadeStarts.values()].some((start) => timeMs <= start + FADE_MS);
  }

  // 配信版を切り替えるときに選択と遷移を全球基底へ戻す。
  public reset(): void {
    this.displayed = [];
    this.fadeStarts.clear();
    this.drawingTimeMs = 0;
  }

  // 到着済みの可視タイルを個別に公開し、直近親または全球基底から遷移させる。
  public sync(
    projection: EarthTileProjection, residents: readonly EarthTileResident[], timeMs: number,
    visible = this.requestCandidates(projection),
  ): void {
    if (!Number.isFinite(timeMs)) throw new RangeError('Invalid Earth drawing time');
    this.drawingTimeMs = timeMs;
    // 到着済み候補だけを表示し、新着タイルには短いフェードを付ける。
    const visibleIds = new Set(visible.map(earthTileId));
    const available = new Map(residents.map((tile) => [earthTileId(tile.key), tile]));
    const previousIds = new Set(this.displayed.map((tile) => earthTileId(tile.key)));
    const nextStarts = new Map<string, number>();

    const displayed = residents
      .filter((tile) => visibleIds.has(earthTileId(tile.key)))
      .sort((a, b) => a.key.z - b.key.z || earthTileId(a.key).localeCompare(earthTileId(b.key)))
      .map((tile): DisplayedTile => {
        const id = earthTileId(tile.key);
        const previousStart = this.fadeStarts.get(id);
        const start = previousIds.has(id) ? previousStart ?? null : timeMs;
        const fading = start !== null && timeMs < start + FADE_MS;
        if (fading && start !== null) nextStarts.set(id, start);
        return {
          ...tile,
          parentLayer: fading ? this.parentLayer(tile.key, available) : EARTH_BASE_LAYER,
          fadeStartMs: fading ? start : null,
        };
      });
    this.displayed = displayed;
    this.fadeStarts = nextStarts;
  }

  // 現在の表示をz7セルへ展開する。細かいタイルほど後から同じ領域を上書きする。
  public pageTable(): Uint8Array {
    // z7セルへ展開し、細かい候補が親の値を上書きする。
    const table = new Uint8Array(EARTH_PAGE_WIDTH * EARTH_PAGE_HEIGHT * 4).fill(EARTH_BASE_LAYER);
    for (const tile of this.displayed) {
      const size = 2 ** (EARTH_TILE_MAX_Z - tile.key.z);
      const fade = tile.fadeStartMs === null
        ? 1 : THREE.MathUtils.clamp((this.drawingTimeMs - tile.fadeStartMs) / FADE_MS, 0, 1);
      for (let y = tile.key.y * size; y < (tile.key.y + 1) * size; y++) {
        for (let x = tile.key.x * size; x < (tile.key.x + 1) * size; x++) {
          table.set(
            [tile.layer, tile.parentLayer, tile.key.z, Math.round(fade * 255)],
            (y * EARTH_PAGE_WIDTH + x) * 4,
          );
        }
      }
    }
    return table;
  }

  // 可視性と投影誤差から詳細候補を再帰選択する。
  private visibleCandidates(
    projection: EarthTileProjection,
  ): { readonly keys: readonly EarthTileKey[]; readonly metrics: ReadonlyMap<string, EarthTileMetric> } {
    // 投影評価をキャッシュし、可視性と分割誤差で再帰選択する。
    const metrics = new Map<string, EarthTileMetric>();
    // 同じキーの投影評価を一度だけ計算する。
    const evaluate = (key: EarthTileKey): EarthTileMetric => {
      const id = earthTileId(key);
      const cached = metrics.get(id);
      if (cached !== undefined) return cached;
      const metric = projection.evaluate(key);
      metrics.set(id, metric);
      return metric;
    };
    const candidates: EarthTileKey[] = [];
    // 可視ノードを辿り、誤差が閾値を超えた領域だけ分割する。
    const visit = (key: EarthTileKey): void => {
      const metric = evaluate(key);
      if (!metric.visible) return;
      if (key.z >= EARTH_TILE_MIN_Z) candidates.push(key);
      if (key.z < EARTH_TILE_MIN_Z) {
        for (const child of earthTileChildren(key)) visit(child);
        return;
      }
      if (metric.errorPx <= SPLIT_ERROR_PX || key.z === EARTH_TILE_MAX_Z) return;
      for (const child of earthTileChildren(key)) visit(child);
    };
    for (const root of selectionRoots()) visit(root);
    return { keys: candidates, metrics };
  }

  // 親が到着済みならそのGPU層を、なければ全球base sentinelを返す。
  private parentLayer(key: EarthTileKey, available: ReadonlyMap<string, EarthTileResident>): number {
    const parent = earthTileParent(key);
    if (parent === null || parent.z < EARTH_TILE_MIN_Z) return EARTH_BASE_LAYER;
    return available.get(earthTileId(parent))?.layer ?? EARTH_BASE_LAYER;
  }
}
