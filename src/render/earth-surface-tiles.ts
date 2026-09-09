// 地球の地域別詳細度、隣接関係、親子遷移とページ表の公開内容を決める。
import * as THREE from 'three/webgpu';
import { earthPositionAtUv, validateEarthAxes } from './earth-surface-coordinate';

export const EARTH_TILE_MAX_Z = 7;
export const EARTH_TILE_TEXELS = 256;
export const EARTH_TILE_GUTTER = 2;
export const EARTH_TILE_EXTENT = EARTH_TILE_TEXELS + 2 * EARTH_TILE_GUTTER;
export const EARTH_TILE_LAYERS = 128;
export const EARTH_BASE_LAYER = 255;
export const EARTH_PAGE_WIDTH = 2 ** (EARTH_TILE_MAX_Z + 1);
export const EARTH_PAGE_HEIGHT = 2 ** EARTH_TILE_MAX_Z;
const FADE_MS = 250; // 壁時計の描画時間 [ms]。
const SPLIT_ERROR_PX = 2;
const MERGE_ERROR_PX = 1;

export interface EarthTileKey {
  readonly z: number;
  readonly x: number;
  readonly y: number;
}

// xを周期、yを極でクランプした整数キーを返す。
export function earthTileKey(z: number, x: number, y: number): EarthTileKey {
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > EARTH_TILE_MAX_Z) {
    throw new RangeError('Invalid Earth tile key');
  }
  const height = 2 ** z;
  return { z, x: THREE.MathUtils.euclideanModulo(x, 2 * height), y: THREE.MathUtils.clamp(y, 0, height - 1) };
}

// 正規化済みキーの識別子を返す。
export function earthTileId(key: EarthTileKey): string {
  return `${key.z}/${key.x}/${key.y}`;
}

// 根ではnull、それ以外では直近の親を返す。
export function earthTileParent(key: EarthTileKey): EarthTileKey | null {
  return key.z === 0 ? null : earthTileKey(key.z - 1, Math.floor(key.x / 2), Math.floor(key.y / 2));
}

// 最大段では空、それ以外では4子を返す。
export function earthTileChildren(key: EarthTileKey): readonly EarthTileKey[] {
  return key.z === EARTH_TILE_MAX_Z ? [] : [
    earthTileKey(key.z + 1, key.x * 2, key.y * 2),
    earthTileKey(key.z + 1, key.x * 2 + 1, key.y * 2),
    earthTileKey(key.z + 1, key.x * 2, key.y * 2 + 1),
    earthTileKey(key.z + 1, key.x * 2 + 1, key.y * 2 + 1),
  ];
}

// 同じ段の東西南北の隣接キー。極を越える辺は経度を半周ずらして反転する。
export function earthTileNeighbors(key: EarthTileKey): readonly EarthTileKey[] {
  const height = 2 ** key.z;
  return [
    earthTileKey(key.z, key.x - 1, key.y), earthTileKey(key.z, key.x + 1, key.y),
    earthTileKey(key.z, key.y === 0 ? key.x + height : key.x, key.y === 0 ? 0 : key.y - 1),
    earthTileKey(key.z, key.y === height - 1 ? key.x + height : key.x,
      key.y === height - 1 ? key.y : key.y + 1),
  ];
}

// ancestorがkeyの領域を含むかを答える。同じキーも含む。
function contains(ancestor: EarthTileKey, key: EarthTileKey): boolean {
  const scale = 2 ** (key.z - ancestor.z);
  return scale >= 1 && Math.floor(key.x / scale) === ancestor.x && Math.floor(key.y / scale) === ancestor.y;
}

// 段の異なる2区画が辺を共有するかを、周期境界と極も含めて答える。
export function earthTilesAdjacent(a: EarthTileKey, b: EarthTileKey): boolean {
  const fine = a.z >= b.z ? a : b;
  const coarse = a.z >= b.z ? b : a;
  return earthTileNeighbors(fine).some((neighbor) => contains(coarse, neighbor));
}

// 2:1制約を満たす葉へ整える。分割可能な粗い側を細分化し、それが不可なら細かい側を戻す。
export function balanceEarthFrontier(
  frontier: readonly EarthTileKey[], canSplit: (key: EarthTileKey) => boolean,
): readonly EarthTileKey[] {
  let leaves = [...frontier];
  for (;;) {
    // 隣接する段差を1辺ずつ解消すると、新しく生まれた辺も同じ判定を通る。
    const pair = leaves.flatMap((a, index) => leaves.slice(index + 1)
      .filter((b) => Math.abs(a.z - b.z) > 1 && earthTilesAdjacent(a, b)).map((b) => [a, b] as const))[0];
    if (pair === undefined) return leaves;
    const [a, b] = pair;
    const coarse = a.z < b.z ? a : b;
    const fine = a.z < b.z ? b : a;
    if (coarse.z < EARTH_TILE_MAX_Z && canSplit(coarse)) {
      leaves = leaves.filter((key) => key !== coarse).concat(earthTileChildren(coarse));
    } else {
      const parent = earthTileParent(fine);
      if (parent === null) throw new Error('Unbalanced Earth root');
      leaves = leaves.filter((key) => !contains(parent, key)).concat(parent);
    }
  }
}

export interface EarthTileMetric {
  readonly visible: boolean;
  readonly errorPx: number;
  readonly priority: number;
}

export interface EarthTileProjection {
  evaluate(key: EarthTileKey): EarthTileMetric;
}

export class EarthSurfaceView implements EarthTileProjection {
  private readonly axes: THREE.Vector3;
  private readonly bodyToView: THREE.Matrix4;
  private readonly projection: THREE.Matrix4;
  private readonly frustum: THREE.Frustum;
  private readonly eyeScaled: THREE.Vector3;
  private readonly observerDirection: THREE.Vector3;
  private readonly perspective: boolean;
  private readonly near: number;

  // earthToWorldは浮動原点補正済みの剛体変換。幅・高さは実drawing bufferの画素数。
  public constructor(
    camera: THREE.PerspectiveCamera | THREE.OrthographicCamera, earthToWorld: THREE.Matrix4,
    axes: THREE.Vector3, private readonly width: number, private readonly height: number,
  ) {
    validateEarthAxes(axes);
    if (!(width > 0 && height > 0)) throw new RangeError('Invalid Earth viewport');
    this.axes = axes.clone();
    this.bodyToView = camera.matrixWorldInverse.clone().multiply(earthToWorld);
    this.projection = camera.projectionMatrix.clone();
    this.frustum = new THREE.Frustum().setFromProjectionMatrix(
      this.projection.clone().multiply(this.bodyToView), camera.coordinateSystem, camera.reversedDepth,
    );
    // 地平線判定は楕円体を単位球へ写した座標で行う。
    const viewToBody = this.bodyToView.clone().invert();
    this.eyeScaled = new THREE.Vector3().applyMatrix4(viewToBody).divide(axes);
    this.observerDirection = new THREE.Vector3(0, 0, 1).transformDirection(viewToBody).divide(axes).normalize();
    this.perspective = camera instanceof THREE.PerspectiveCamera;
    this.near = camera.near;
  }

  // 完全に不可視の区画を除き、画面上の東西・南北の最大辺長から1texelの誤差を返す。
  public evaluate(key: EarthTileKey): EarthTileMetric {
    const columns = 2 ** (key.z + 1);
    const rows = 2 ** key.z;
    const center = earthPositionAtUv((key.x + 0.5) / columns, (key.y + 0.5) / rows, this.axes);
    const maxAxis = Math.max(this.axes.x, this.axes.y, this.axes.z);
    const minAxis = Math.min(this.axes.x, this.axes.y, this.axes.z);
    // 正規化したA*nの角変化は、nの角変化のaMax/aMin倍以内に収まる。
    const angle = Math.min(Math.PI, maxAxis / minAxis * (Math.PI / columns + Math.PI / (2 * rows)));
    const cap = center.clone().divide(this.axes).normalize();
    const observer = this.perspective ? this.eyeScaled : this.observerDirection;
    const separation = cap.angleTo(observer);
    const horizon = Math.cos(Math.max(0, separation - angle)) * observer.length();
    const sphere = new THREE.Sphere(center, 2 * maxAxis * Math.sin(angle / 2));
    if (horizon < (this.perspective ? 1 : 0) || !this.frustum.intersectsSphere(sphere)) {
      return { visible: false, errorPx: 0, priority: 0 };
    }

    // 経度はこの格子のまま連続的に進め、半周幅の根でも中央を含めて辺を測る。
    const points: THREE.Vector2[][] = [];
    for (let y = 0; y <= 2; y++) {
      const row: THREE.Vector2[] = [];
      for (let x = 0; x <= 2; x++) {
        const position = earthPositionAtUv((key.x + x / 2) / columns, (key.y + y / 2) / rows, this.axes)
          .applyMatrix4(this.bodyToView);
        if (this.perspective && -position.z <= this.near) {
          return { visible: true, errorPx: Infinity, priority: Infinity };
        }
        position.applyMatrix4(this.projection);
        row.push(new THREE.Vector2(position.x * this.width / 2, position.y * this.height / 2));
      }
      points.push(row);
    }
    const at = (x: number, y: number): THREE.Vector2 => points[y]![x]!;
    let maxEdge = 0;
    for (let index = 0; index <= 2; index++) {
      maxEdge = Math.max(maxEdge,
        at(0, index).distanceTo(at(1, index)) + at(1, index).distanceTo(at(2, index)),
        at(index, 0).distanceTo(at(index, 1)) + at(index, 1).distanceTo(at(index, 2)));
    }
    const bounds = new THREE.Box2().setFromPoints(points.flat());
    const area = bounds.getSize(new THREE.Vector2());
    const errorPx = maxEdge / EARTH_TILE_TEXELS;
    const centerDistance = at(1, 1).length() / Math.max(this.width, this.height);
    return { visible: true, errorPx, priority: errorPx * area.x * area.y / (1 + centerDistance) };
  }
}

export interface EarthTileResident {
  readonly key: EarthTileKey;
  readonly layer: number;
}

interface TileLeaf extends EarthTileResident {
  readonly parentLayer: number;
  readonly fadeStartMs: number | null;
  readonly fadingOut: boolean;
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
  private leaves: readonly TileLeaf[] = [stableLeaf(earthTileKey(0, 0, 0), EARTH_BASE_LAYER),
    stableLeaf(earthTileKey(0, 1, 0), EARTH_BASE_LAYER)];
  private visibleLeaves: readonly TileLeaf[] = [];
  private drawingTimeMs = 0;

  public get frontier(): readonly EarthTileResident[] { return this.visibleLeaves; }

  // 次の分割で必要になる層を返す。frontierの選択は変えず、要求側が親を表示したまま
  // 子を先行取得できるように候補だけを計算する。
  public requestCandidates(projection: EarthTileProjection): readonly EarthTileKey[] {
    const candidates = new Map<string, { readonly key: EarthTileKey; readonly priority: number }>();
    const add = (key: EarthTileKey, priority: number): void => {
      const id = earthTileId(key);
      const existing = candidates.get(id);
      if (existing === undefined || priority > existing.priority) candidates.set(id, { key, priority });
    };
    for (const leaf of this.leaves) {
      if (leaf.fadeStartMs !== null) continue;
      const metric = projection.evaluate(leaf.key);
      if (!metric.visible) continue;
      // 全球baseにはまだ詳細層がないため、まずその地域の根を要求する。
      if (leaf.layer === EARTH_BASE_LAYER) {
        add(leaf.key, metric.priority);
        continue;
      }
      if (leaf.key.z >= EARTH_TILE_MAX_Z || metric.errorPx <= SPLIT_ERROR_PX) continue;
      // 2:1制約と親子fadeを同時に満たすには、分割する親の4子が必要になる。
      for (const child of earthTileChildren(leaf.key)) {
        const childMetric = projection.evaluate(child);
        add(child, Math.max(metric.priority, childMetric.priority));
      }
    }
    return [...candidates.values()]
      .sort((a, b) => b.priority - a.priority || earthTileId(a.key).localeCompare(earthTileId(b.key)))
      .map((candidate) => candidate.key);
  }

  // 非表示へ移った葉はpinせず、可視frontierとfade中の層だけを返す。
  public pinnedLayers(): readonly number[] {
    return [...this.pinnedLeafLayers()];
  }

  // 非表示からの再表示や配信版切り替えは全球baseから再開する。
  public reset(): void {
    this.leaves = [
      stableLeaf(earthTileKey(0, 0, 0), EARTH_BASE_LAYER),
      stableLeaf(earthTileKey(0, 1, 0), EARTH_BASE_LAYER),
    ];
    this.visibleLeaves = [];
    this.drawingTimeMs = 0;
  }

  // GPUへ公開済みの同版タイルを入力し、現在フレームの選択と親子遷移を確定する。
  public sync(projection: EarthTileProjection, residents: readonly EarthTileResident[], timeMs: number): void {
    if (!Number.isFinite(timeMs)) throw new RangeError('Invalid Earth drawing time');
    const available = new Map(residents.map((tile) => [earthTileId(tile.key), tile]));
    this.drawingTimeMs = timeMs;
    this.finishFades(timeMs);
    const availableLayers = new Set(residents.map((tile) => tile.layer));
    // coordinatorが画面外の層を再利用した場合、leafが持つ旧layerをそのまま
    // ページ表へ出さない。次の分割はbaseから再取得する。
    this.leaves = this.leaves.map((leaf) => {
      const layerValid = leaf.layer === EARTH_BASE_LAYER || availableLayers.has(leaf.layer);
      const parentValid = leaf.parentLayer === EARTH_BASE_LAYER || availableLayers.has(leaf.parentLayer);
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
    const candidates = frontier.filter((key) => evaluate(key).visible && evaluate(key).errorPx > SPLIT_ERROR_PX)
      .sort((a, b) => evaluate(b).priority - evaluate(a).priority);
    for (const key of candidates) {
      if (!canSplit(key) || !frontier.includes(key)) continue;
      const proposal = balanceEarthFrontier(frontier.filter((leaf) => leaf !== key).concat(earthTileChildren(key)), canSplit);
      // 遷移元も層を占有するため、葉数だけを数えると公開の途中で容量を超える。
      const pinned = this.pinnedLeafLayers();
      for (const tile of proposal) {
        const resident = available.get(earthTileId(tile));
        if (resident !== undefined) pinned.add(resident.layer);
      }
      if (pinned.size <= EARTH_TILE_LAYERS) frontier = [...proposal];
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

  // 現在の葉をz=7セルへ展開する。不可視セルは全球ベースを指す。
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

// ページ表の1セルを最近傍で読む。経度の両端を同じセルへ畳み、南極は最終行へ置く。
export function earthPageAt(table: Uint8Array, u: number, v: number): readonly number[] {
  const x = Math.floor(THREE.MathUtils.euclideanModulo(u, 1) * EARTH_PAGE_WIDTH);
  const y = Math.min(EARTH_PAGE_HEIGHT - 1, Math.floor(THREE.MathUtils.clamp(v, 0, 1) * EARTH_PAGE_HEIGHT));
  return [...table.subarray((y * EARTH_PAGE_WIDTH + x) * 4, (y * EARTH_PAGE_WIDTH + x) * 4 + 4)];
}

// タイル標本化用UV。v=1は南端のガターを読み、北端へwrapさせない。
export function earthTileSampleUv(u: number, v: number, z: number): THREE.Vector2 {
  const tu = THREE.MathUtils.euclideanModulo(u * 2 ** (z + 1), 1);
  const tv = v === 1 ? 1 : THREE.MathUtils.euclideanModulo(v * 2 ** z, 1);
  return new THREE.Vector2(
    (EARTH_TILE_GUTTER + 0.5 + EARTH_TILE_TEXELS * tu) / EARTH_TILE_EXTENT,
    (EARTH_TILE_GUTTER + 0.5 + EARTH_TILE_TEXELS * tv) / EARTH_TILE_EXTENT,
  );
}
