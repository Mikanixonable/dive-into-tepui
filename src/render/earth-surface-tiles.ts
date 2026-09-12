// 地表タイルのLOD状態と親子fadeを所有する。
import * as THREE from 'three/webgpu';
import {
  EARTH_BASE_LAYER, EARTH_TILE_FRONTIER_LAYERS, EARTH_TILE_LAYERS, EARTH_TILE_MAX_Z, EARTH_TILE_MIN_Z,
  earthTileChildren, earthTileId, earthTileParent, earthTileRoots, earthTilesAdjacent,
  type EarthTileKey,
} from './earth-surface-tile-key';
import type { EarthTileMetric, EarthTileProjection } from './earth-surface-tile-projection';
import { EARTH_PAGE_HEIGHT, EARTH_PAGE_WIDTH } from './earth-surface-page-table';
const FADE_MS = 250; // 壁時計の描画時間 [ms]。
const SPLIT_ERROR_PX = 2;
const MERGE_ERROR_PX = 1;
const SPLIT_GROUPS_PER_SYNC = 4; // 1回のsyncで開始するsplit group数。

export interface EarthTileResident {
  readonly key: EarthTileKey;
  readonly layer: number;
}

interface TileLeaf extends EarthTileResident {
  readonly parentLayer: number;
  readonly fadeStartMs: number | null;
  readonly fadingOut: boolean;
}

interface SplitPlanGroup {
  readonly key: EarthTileKey;
  readonly parentId: string;
  readonly priority: number;
  readonly keys: readonly EarthTileKey[];
  readonly dependencies: Set<string>;
}

// ancestorがkeyの領域を含むかを答える。同じキーも含む。
function contains(ancestor: EarthTileKey, key: EarthTileKey): boolean {
  const scale = 2 ** (key.z - ancestor.z);
  return scale >= 1 && Math.floor(key.x / scale) === ancestor.x && Math.floor(key.y / scale) === ancestor.y;
}

// 安定して表示する葉を作る。base層の場合も、その葉の地理的な範囲を保つ。
function stableLeaf(key: EarthTileKey, layer: number): TileLeaf {
  return { key, layer, parentLayer: EARTH_BASE_LAYER, fadeStartMs: null, fadingOut: false };
}

// 親子の線形混合率。壁時計は開始時刻を下回っても0側で止める。
function fadeOf(leaf: TileLeaf, timeMs: number): number {
  if (leaf.fadeStartMs === null) return 1;
  const elapsed = THREE.MathUtils.clamp((timeMs - leaf.fadeStartMs) / FADE_MS, 0, 1);
  return leaf.fadingOut ? 1 - elapsed : elapsed;
}

export class EarthSurfaceTiles {
  private leaves: readonly TileLeaf[] = earthTileRoots().map((key) => stableLeaf(key, EARTH_BASE_LAYER));
  private visibleLeaves: readonly TileLeaf[] = [];
  private drawingTimeMs = 0;

  public get frontier(): readonly EarthTileResident[] { return this.visibleLeaves; }

  // 次の分割で必要になる層を返す。frontierの選択は変えず、要求側が親を表示したまま
  // 子を先行取得できるように候補だけを計算する。
  public requestCandidates(projection: EarthTileProjection): readonly EarthTileKey[] {
    const metrics = new Map<string, EarthTileMetric>();
    // 同一候補の投影評価をフレーム内で共有する。
    const evaluate = (key: EarthTileKey): EarthTileMetric => {
      const id = earthTileId(key);
      const value = metrics.get(id) ?? projection.evaluate(key);
      metrics.set(id, value);
      return value;
    };
    return this.orderSplitPlan(this.planSplitGroups(this.leaves, evaluate)).flatMap((group) => group.keys);
  }

  // 非表示へ移った葉はpinせず、可視frontierとfade中の層だけを返す。
  public pinnedLayers(): readonly number[] {
    return [...this.pinnedLeafLayers()];
  }

  // 現在時刻で親子fadeが進行中かを返す。fade中だけ時刻の変化がページ表を変える。
  public hasActiveFades(timeMs = this.drawingTimeMs): boolean {
    return this.leaves.some((leaf) => leaf.fadeStartMs !== null
      && timeMs <= leaf.fadeStartMs + FADE_MS);
  }

  // 非表示からの再表示や配信版切り替えは全球baseから再開する。
  public reset(): void {
    this.leaves = earthTileRoots().map((key) => stableLeaf(key, EARTH_BASE_LAYER));
    this.visibleLeaves = [];
    this.drawingTimeMs = 0;
  }

  // GPUへ公開済みの同版タイルを入力し、現在フレームの選択と親子遷移を確定する。
  public sync(projection: EarthTileProjection, residents: readonly EarthTileResident[], timeMs: number): void {
    if (!Number.isFinite(timeMs)) throw new RangeError('Invalid Earth drawing time');
    const available = new Map(residents.map((tile) => [earthTileId(tile.key), tile]));
    this.drawingTimeMs = timeMs;
    this.finishFades(timeMs);
    // coordinatorが画面外の層を再利用した場合、leafが持つ旧layerをそのまま
    // ページ表へ出さない。次の分割はbaseから再取得する。
    this.leaves = this.leaves.map((leaf) => {
      const resident = available.get(earthTileId(leaf.key));
      const parent = earthTileParent(leaf.key);
      const layerValid = leaf.layer === EARTH_BASE_LAYER || resident?.layer === leaf.layer;
      const parentValid = leaf.parentLayer === EARTH_BASE_LAYER
        || (parent !== null && available.get(earthTileId(parent))?.layer === leaf.parentLayer);
      if (!layerValid) return stableLeaf(leaf.key, EARTH_BASE_LAYER);
      if (!parentValid) return { ...leaf, parentLayer: EARTH_BASE_LAYER, fadeStartMs: null, fadingOut: false };
      return leaf;
    });
    const metric = new Map<string, EarthTileMetric>();
    // 同一フレームの選択と再均衡では同じ投影値を使う。
    const evaluate = (key: EarthTileKey): EarthTileMetric => {
      const id = earthTileId(key);
      const value = metric.get(id) ?? projection.evaluate(key);
      metric.set(id, value);
      return value;
    };

    // ベースからの最初の公開にも、通常の親子と同じ遷移時間を与える。
    this.leaves = this.leaves.map((leaf) => {
      const resident = available.get(earthTileId(leaf.key));
      if (leaf.layer !== EARTH_BASE_LAYER || resident === undefined || !evaluate(leaf.key).visible) return leaf;
      return { ...leaf, layer: resident.layer, fadeStartMs: timeMs };
    });
    this.beginMerges(available, evaluate, timeMs);
    this.beginSplits(available, evaluate, timeMs);
    this.visibleLeaves = this.leaves.filter((leaf) => evaluate(leaf.key).visible);
  }

  // 完了した遷移を確定する。統合では全子が同じ親への遷移を完了している。
  private finishFades(timeMs: number): void {
    const finished = new Map<string, TileLeaf>();
    this.leaves = this.leaves.flatMap((leaf) => {
      if (leaf.fadeStartMs === null || timeMs < leaf.fadeStartMs + FADE_MS) return [leaf];
      if (!leaf.fadingOut) return [stableLeaf(leaf.key, leaf.layer)];
      const parent = earthTileParent(leaf.key);
      if (parent === null) throw new Error('Earth root cannot merge');
      finished.set(earthTileId(parent), stableLeaf(parent, leaf.parentLayer));
      return [];
    }).concat([...finished.values()]);
  }

  // 誤差が統合閾値を下回り、隣接制約が保たれる4子を親へフェードする。
  private beginMerges(
    available: ReadonlyMap<string, EarthTileResident>, evaluate: (key: EarthTileKey) => EarthTileMetric, timeMs: number,
  ): void {
    const parents = new Map<string, EarthTileKey>();
    for (const leaf of this.leaves) {
      if (leaf.key.z <= EARTH_TILE_MIN_Z) continue;
      const parent = earthTileParent(leaf.key);
      if (parent !== null) parents.set(earthTileId(parent), parent);
    }
    // フェード開始時に、統合完了後の隣接条件まで満たす親を選ぶ。
    for (const [id, parent] of parents) {
      const resident = available.get(id);
      const children = this.leaves.filter((leaf) => contains(parent, leaf.key));
      if (resident === undefined || children.length !== 4 || evaluate(parent).errorPx >= MERGE_ERROR_PX
        || children.some((leaf) => leaf.key.z !== parent.z + 1 || leaf.fadeStartMs !== null)) continue;
      if (this.leaves.some((leaf) => !contains(parent, leaf.key)
        && leaf.key.z > parent.z + 1 && earthTilesAdjacent(parent, leaf.key))) continue;
      this.leaves = this.leaves.map((leaf) => children.includes(leaf)
        ? { ...leaf, parentLayer: resident.layer, fadeStartMs: timeMs, fadingOut: true } : leaf);
    }
  }

  // 取得済みの子を使って分割し、隣接制約と常駐層上限を満たす集合を同時に公開する。
  private beginSplits(
    available: ReadonlyMap<string, EarthTileResident>, evaluate: (key: EarthTileKey) => EarthTileMetric, timeMs: number,
  ): void {
    const current = new Map(this.leaves.map((leaf) => [earthTileId(leaf.key), leaf]));
    // 遷移を終えた親と4子の常駐がそろう区画を分割可能とする。
    const canSplit = (key: EarthTileKey): boolean => {
      const leaf = current.get(earthTileId(key));
      return leaf !== undefined && leaf.layer !== EARTH_BASE_LAYER && leaf.fadeStartMs === null
        && key.z < EARTH_TILE_MAX_Z && earthTileChildren(key).every((child) => available.has(earthTileId(child)));
    };
    let frontier = this.leaves.map((leaf) => leaf.key);
    let splitGroups = 0;
    let pinned = this.pinnedLeafLayers();
    const groups = this.orderSplitPlan(this.planSplitGroups(this.leaves, evaluate));
    for (const group of groups) {
      if (splitGroups >= SPLIT_GROUPS_PER_SYNC) break;
      const key = group.key;
      if (!canSplit(key) || !frontier.some((leaf) => earthTileId(leaf) === earthTileId(key))) continue;
      const proposal = this.splitFrontier(frontier, key);
      if (proposal === null) continue;
      const proposalFrontierLayers = new Set<number>();
      const proposalPinned = new Set(pinned);
      for (const tile of proposal) {
        const resident = available.get(earthTileId(tile));
        if (resident === undefined) continue;
        proposalFrontierLayers.add(resident.layer);
        proposalPinned.add(resident.layer);
      }
      if (proposalFrontierLayers.size > EARTH_TILE_FRONTIER_LAYERS
        || proposalPinned.size > EARTH_TILE_LAYERS) continue;
      frontier = [...proposal];
      pinned = proposalPinned;
      splitGroups++;
    }
    this.leaves = frontier.map((key) => {
      const existing = current.get(earthTileId(key));
      if (existing !== undefined) return existing;
      const parent = earthTileParent(key);
      const from = parent === null ? undefined : current.get(earthTileId(parent));
      const to = available.get(earthTileId(key));
      if (from === undefined || to === undefined) throw new Error('Earth split lost its resident parent');
      return { key, layer: to.layer, parentLayer: from.layer, fadeStartMs: timeMs, fadingOut: false };
    });
  }

  // 2:1制約を壊す分割を延期し、現在のfrontierを有効な葉のまま保つ。
  private splitFrontier(frontier: readonly EarthTileKey[], parent: EarthTileKey): readonly EarthTileKey[] | null {
    if (this.splitBlockers(frontier, parent).length > 0) return null;
    const remaining = frontier.filter((key) => earthTileId(key) !== earthTileId(parent));
    const children = earthTileChildren(parent);
    return remaining.concat(children);
  }

  // 親を分割すると2:1制約を壊す、より粗い隣接leafを決定的に返す。
  private splitBlockers(frontier: readonly EarthTileKey[], parent: EarthTileKey): readonly EarthTileKey[] {
    const remaining = frontier.filter((key) => earthTileId(key) !== earthTileId(parent));
    const blockers = new Map<string, EarthTileKey>();
    for (const child of earthTileChildren(parent)) {
      for (const leaf of remaining) {
        if (leaf.z < parent.z && earthTilesAdjacent(child, leaf)) blockers.set(earthTileId(leaf), leaf);
      }
    }
    return [...blockers.values()].sort((a, b) => earthTileId(a).localeCompare(earthTileId(b)));
  }

  // 高errorの分割と、それを2:1のために先行させる粗い隣接分割の閉包を作る。
  private planSplitGroups(
    leaves: readonly TileLeaf[], evaluate: (key: EarthTileKey) => EarthTileMetric,
  ): readonly SplitPlanGroup[] {
    // 高誤差の分割と、2:1制約に必要な依存分割をまとめる。
    const groups = new Map<string, SplitPlanGroup>();
    const frontier = leaves.map((leaf) => leaf.key);
    const byId = new Map(leaves.map((leaf) => [earthTileId(leaf.key), leaf]));
    // 親ごとの分割groupを作り、必要な依存groupを再帰的に登録する。
    const add = (key: EarthTileKey): SplitPlanGroup => {
      // 既存groupは再利用し、初出の親だけ依存関係を展開する。
      const parentId = earthTileId(key);
      const existing = groups.get(parentId);
      if (existing !== undefined) return existing;
      const leaf = byId.get(parentId);
      const metric = evaluate(key);
      if (leaf?.layer === EARTH_BASE_LAYER || key.z >= EARTH_TILE_MAX_Z) {
        const group: SplitPlanGroup = { key, parentId, priority: metric.priority, keys: [key], dependencies: new Set() };
        groups.set(parentId, group);
        return group;
      }
      const children = earthTileChildren(key);
      const childMetrics = children.map((child) => evaluate(child));
      const group: SplitPlanGroup = {
        key, parentId,
        priority: Math.max(metric.priority, ...childMetrics.map((child) => child.priority)),
        keys: children.slice().sort((a, b) => earthTileId(a).localeCompare(earthTileId(b))),
        dependencies: new Set(),
      };
      groups.set(parentId, group);
      for (const blocker of this.splitBlockers(frontier, key)) {
        const dependency = add(blocker);
        group.dependencies.add(dependency.parentId);
      }
      return group;
    };

    for (const leaf of leaves) {
      if (leaf.fadeStartMs !== null) continue;
      const metric = evaluate(leaf.key);
      if (leaf.layer === EARTH_BASE_LAYER) {
        if (metric.visible) add(leaf.key);
      } else if (metric.visible && metric.errorPx > SPLIT_ERROR_PX) {
        add(leaf.key);
      }
    }
    return [...groups.values()];
  }

  // 依存groupを必ず先に置き、同じ段ではpriorityと親IDで順序を固定する。
  private orderSplitPlan(groups: readonly SplitPlanGroup[]): readonly SplitPlanGroup[] {
    // 依存を満たしたgroupから優先度順に安定して並べる。
    const ordered: SplitPlanGroup[] = [];
    const emitted = new Set<string>();
    while (ordered.length < groups.length) {
      const ready = groups.filter((group) => !emitted.has(group.parentId)
        && [...group.dependencies].every((dependency) => emitted.has(dependency)))
        .sort((a, b) => b.priority - a.priority || a.parentId.localeCompare(b.parentId));
      const next = ready[0];
      if (next === undefined) break;
      ordered.push(next);
      emitted.add(next.parentId);
    }
    return ordered;
  }

  // 可視葉とfade中の親子が占有する層を返す。
  private pinnedLeafLayers(): Set<number> {
    const visible = new Set(this.visibleLeaves.map((leaf) => earthTileId(leaf.key)));
    const layers = new Set<number>();
    for (const leaf of this.leaves) {
      if (!visible.has(earthTileId(leaf.key)) && leaf.fadeStartMs === null) continue;
      if (leaf.layer !== EARTH_BASE_LAYER) layers.add(leaf.layer);
      if (leaf.parentLayer !== EARTH_BASE_LAYER) layers.add(leaf.parentLayer);
    }
    return layers;
  }

  // 現在の葉をz=7セルへ展開する。未取得・不可視セルは全球ベースを指す。
  public pageTable(): Uint8Array {
    const table = new Uint8Array(EARTH_PAGE_WIDTH * EARTH_PAGE_HEIGHT * 4).fill(EARTH_BASE_LAYER);
    // 子の取得待機は親の葉が覆う範囲をそのまま保つ。
    for (const leaf of this.visibleLeaves) {
      const size = 2 ** (EARTH_TILE_MAX_Z - leaf.key.z);
      for (let y = leaf.key.y * size; y < (leaf.key.y + 1) * size; y++) {
        for (let x = leaf.key.x * size; x < (leaf.key.x + 1) * size; x++) {
          table.set([leaf.layer, leaf.parentLayer, leaf.layer === EARTH_BASE_LAYER ? EARTH_BASE_LAYER : leaf.key.z,
            Math.round(fadeOf(leaf, this.drawingTimeMs) * 255)], (y * EARTH_PAGE_WIDTH + x) * 4);
        }
      }
    }
    return table;
  }
}
