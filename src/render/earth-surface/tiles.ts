// 投影誤差から地域タイルを個別に選び、到着済みの詳細をページ表へ公開する。
import * as THREE from 'three/webgpu';
import {
  EARTH_BASE_LAYER, EARTH_TILE_MAX_Z, EARTH_TILE_MIN_Z,
  earthTileChildren, earthTileId, earthTileIndex, earthTileKey, earthTileNeighbors, earthTileParent,
  type EarthTileKey,
} from './tile-key';
import type { EarthTileProjection } from './tile-projection';
import { EARTH_PAGE_HEIGHT, EARTH_PAGE_WIDTH } from './layout';

const FADE_MS = 250; // 壁時計の描画時間 [ms]。
const SPLIT_ERROR_PX = 2;

export interface EarthTileResident {
  readonly key: EarthTileKey;
  readonly layer: number;
}

interface DisplayedTile extends EarthTileResident {
  readonly parentLayer: number;
  readonly fadeStartMs: number | null;
  // ページ表のセルへ書く遷移の進み 0..255。
  readonly fadeByte: number;
}

// 投影評価の優先度を添えた候補。
interface RankedTile {
  readonly key: EarthTileKey;
  readonly priority: number;
}

// 詳細選択の起点となるz4相当の全球区画。暗黙の全球基底と同じ区画から可視性を絞り、
// z5全数の評価を避ける。固定なので1回だけ構築する。
const SELECTION_ROOTS: readonly EarthTileKey[] = (() => {
  const z = EARTH_TILE_MIN_Z - 1;
  const rows = 2 ** z;
  return Array.from({ length: rows }, (_, y) => Array.from(
    { length: 2 * rows }, (_, x) => earthTileKey(z, x, y),
  )).flat();
})();

// 投影優先度、LOD、IDの順に候補を安定ソートする。
function ordered(tiles: RankedTile[]): readonly EarthTileKey[] {
  return tiles.sort((a, b) => b.priority - a.priority || a.key.z - b.key.z
    || earthTileId(a.key).localeCompare(earthTileId(b.key))).map((tile) => tile.key);
}

// 2つの表示が同じページ表を生むか。
function sameDisplay(a: readonly DisplayedTile[], b: readonly DisplayedTile[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!;
    const q = b[i]!;
    if (p.key.z !== q.key.z || p.key.x !== q.key.x || p.key.y !== q.key.y || p.layer !== q.layer
      || p.parentLayer !== q.parentLayer || p.fadeByte !== q.fadeByte) return false;
  }
  return true;
}

export class EarthSurfaceTiles {
  private displayed: readonly DisplayedTile[] = [];
  private fadeStarts = new Map<number, number>();
  private drawingTimeMs = 0;
  // 表示から組んだページ表のキャッシュ。表示が変わったら捨てる。
  private page: Uint8Array | null = null;
  private pageRevisionValue = 0;

  // 表示するタイルの最大段を受ける。配信範囲の外は投げる。
  public constructor(private readonly maxZoom: number = EARTH_TILE_MAX_Z) {
    if (!Number.isInteger(maxZoom) || maxZoom < EARTH_TILE_MIN_Z || maxZoom > EARTH_TILE_MAX_Z) {
      throw new RangeError('Invalid Earth surface display max zoom');
    }
  }

  public get frontier(): readonly EarthTileResident[] { return this.displayed; }

  // pageTable の中身が変わるたびに増える番号。
  public get pageRevision(): number { return this.pageRevisionValue; }

  // 現在見える地域について、基底から目標LODまでの詳細キーを優先度順に返す。
  public requestCandidates(projection: EarthTileProjection): readonly EarthTileKey[] {
    return ordered(this.visibleCandidates(projection));
  }

  // 可視地域の同段隣接を1タイル幅だけ返す。可視候補との重複は除く。
  public prefetchCandidates(
    projection: EarthTileProjection, visible = this.requestCandidates(projection),
  ): readonly EarthTileKey[] {
    // 可視候補に隣接する同LODタイルを先読み対象へ集める。
    const visibleIndices = new Set(visible.map(earthTileIndex));
    const neighbors = new Map<number, EarthTileKey>();
    for (const key of visible) {
      for (const neighbor of earthTileNeighbors(key)) {
        const index = earthTileIndex(neighbor);
        if (!visibleIndices.has(index)) neighbors.set(index, neighbor);
      }
    }
    return ordered([...neighbors.values()].map((key) => ({ key, priority: projection.evaluate(key).priority })));
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
    for (const start of this.fadeStarts.values()) {
      if (timeMs <= start + FADE_MS) return true;
    }
    return false;
  }

  // 配信版を切り替えるときに選択と遷移を全球基底へ戻す。
  public reset(): void {
    this.displayed = [];
    this.fadeStarts.clear();
    this.drawingTimeMs = 0;
    this.page = null;
    this.pageRevisionValue++;
  }

  // 到着済みの可視タイルを個別に公開し、直近親または全球基底から遷移させる。
  public sync(
    projection: EarthTileProjection, residents: readonly EarthTileResident[], timeMs: number,
    visible = this.requestCandidates(projection),
  ): void {
    if (!Number.isFinite(timeMs)) throw new RangeError('Invalid Earth drawing time');
    this.drawingTimeMs = timeMs;
    // 到着済み候補だけを表示し、新着タイルには短いフェードを付ける。
    const visibleIndices = new Set(visible.map(earthTileIndex));
    const available = new Map(residents.map((tile) => [earthTileIndex(tile.key), tile]));
    const previousIndices = new Set(this.displayed.map((tile) => earthTileIndex(tile.key)));
    const nextStarts = new Map<number, number>();

    const displayed = residents
      .filter((tile) => visibleIndices.has(earthTileIndex(tile.key)))
      .map((tile) => ({ tile, id: earthTileId(tile.key) }))
      .sort((a, b) => a.tile.key.z - b.tile.key.z || a.id.localeCompare(b.id))
      .map(({ tile }): DisplayedTile => {
        const index = earthTileIndex(tile.key);
        const previousStart = this.fadeStarts.get(index);
        const start = previousIndices.has(index) ? previousStart ?? null : timeMs;
        const fading = start !== null && timeMs < start + FADE_MS;
        if (fading && start !== null) nextStarts.set(index, start);
        const fadeStartMs = fading ? start : null;
        const fade = fadeStartMs === null ? 1 : THREE.MathUtils.clamp((timeMs - fadeStartMs) / FADE_MS, 0, 1);
        return {
          ...tile,
          parentLayer: fading ? this.parentLayer(tile.key, available) : EARTH_BASE_LAYER,
          fadeStartMs,
          fadeByte: Math.round(fade * 255),
        };
      });
    if (!sameDisplay(displayed, this.displayed)) {
      this.page = null;
      this.pageRevisionValue++;
    }
    this.displayed = displayed;
    this.fadeStarts = nextStarts;
  }

  // 現在の表示を最高LODセルへ展開した表。細かいタイルほど後から同じ領域を上書きする。表示が
  // 変わるまで同じ配列を返すので、書き換えない。
  public pageTable(): Uint8Array {
    this.page ??= this.buildPageTable();
    return this.page;
  }

  // 全セルを全球基底で埋め、表示中のタイルを z の浅い順に、そのセルの行ごとに上書きする。
  private buildPageTable(): Uint8Array {
    const table = new Uint8Array(EARTH_PAGE_WIDTH * EARTH_PAGE_HEIGHT * 4).fill(EARTH_BASE_LAYER);
    const cells = new Uint32Array(table.buffer);
    // 1セル4バイトを、表と同じバイト順の32bit値へ詰める。
    const cell = new Uint8Array(4);
    const cellValue = new Uint32Array(cell.buffer);
    for (const tile of this.displayed) {
      const size = 2 ** (EARTH_TILE_MAX_Z - tile.key.z);
      cell.set([tile.layer, tile.parentLayer, tile.key.z, tile.fadeByte]);
      const x = tile.key.x * size;
      for (let y = tile.key.y * size; y < (tile.key.y + 1) * size; y++) {
        const row = y * EARTH_PAGE_WIDTH + x;
        cells.fill(cellValue[0]!, row, row + size);
      }
    }
    return table;
  }

  // 可視性と投影誤差から詳細候補を再帰選択する。区画は木を1度ずつ辿るので、各キーの投影評価は1回。
  private visibleCandidates(projection: EarthTileProjection): RankedTile[] {
    const candidates: RankedTile[] = [];
    // 可視ノードを辿り、誤差が閾値を超えた領域だけ分割する。
    const visit = (key: EarthTileKey): void => {
      const metric = projection.evaluate(key);
      if (!metric.visible) return;
      if (key.z >= EARTH_TILE_MIN_Z) candidates.push({ key, priority: metric.priority });
      if (key.z < EARTH_TILE_MIN_Z) {
        for (const child of earthTileChildren(key)) visit(child);
        return;
      }
      if (metric.errorPx <= SPLIT_ERROR_PX || key.z === this.maxZoom) return;
      for (const child of earthTileChildren(key)) visit(child);
    };
    for (const root of SELECTION_ROOTS) visit(root);
    return candidates;
  }

  // 親が到着済みならそのGPU層を、なければ全球base sentinelを返す。
  private parentLayer(key: EarthTileKey, available: ReadonlyMap<number, EarthTileResident>): number {
    const parent = earthTileParent(key);
    if (parent === null || parent.z < EARTH_TILE_MIN_Z) return EARTH_BASE_LAYER;
    return available.get(earthTileIndex(parent))?.layer ?? EARTH_BASE_LAYER;
  }
}
