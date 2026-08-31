// マップモードのフォーカス対象(天体・ラグランジュ点)ラベルの算出と HUD マーカーへの反映。
import { Vec3, v3, sub, len } from '../../math/vec3';
import { CelestialBody, strongestAttractor } from '../../physics/celestial-body';
import { ProjectFn } from './camera-system';
import { combatMarkerKindOf, MarkerManager, type CombatMarkerKind } from '../marker/marker-manager';
import { OrbitingMotion } from '../../physics/celestial-motion';
import { lagrangePointsOf, secondaryFrameOf } from '../../physics/lagrange';
import { occlusionOpacity } from '../../physics/occlusion';
import { MapDisplayToggles } from '../map/display-toggles';
import type { CelestialClass } from '../celestial/celestial-entity/celestial-entity-def';
import type { CelestialSystem } from '../celestial/celestial-system';
import { MapVisibilityPolicy } from '../map/visibility-policy';
import { DEPTH_GUARD_EXIT_RATIO, DEPTH_GUARD_RATIO, LAGRANGE_MIN_CLEARANCE_RATIO, MARKER_PRIORITY } from '../const';
import type { MapPickable } from '../pickable/map-pickable';
import { ENTITY_GLYPH, bodyEntityGlyph } from '../marker/marker-glyphs';
import type { GroupedMarkers, GroupedMarkerItem } from '../marker/grouped-markers';
import { resolveCrowdingWinner } from '../marker/crowding';

// 天体ラベルからこれより画面上で近いラグランジュ点ラベルは、天体ラベルを優先して隠す [px]
const FOCUS_LABEL_PRIORITY_PX = 40;

// 位置の点(アイコン)側の混雑判定。名前(FOCUS_LABEL_PRIORITY_PX)より小さい値にし、名前だけが
// 間引かれて点は残る距離帯を作る。
const FOCUS_ICON_PRIORITY_PX = 16;

type MutableMapPickable = { -readonly [K in keyof MapPickable]: MapPickable[K] };
type ProjectedFocusLabel = { label: FocusLabel; x: number; y: number; dist: number };
type FocusProjection = { occluded: boolean; opacity: number; x: number; y: number; front: boolean };

export interface ActiveCelestialLabel {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly priority: number;
  readonly dist: number;
  readonly iconVisible: boolean;
  readonly labelVisible: boolean;
}

export interface FocusLabel {
  id: string;
  // 一覧・プロパティウィンドウが読む名前。
  name: string;
  // マップのマーカーへ描く表記。ラグランジュ点だけが name と異なり、
  // 地点名と天体名を別行に置く二行表記になる。
  markerLabel: string;
  pos: Vec3;
  kind: 'body';
  isLagrange: boolean;
  // アイコン形状の選択に使う(ラグランジュ点では未使用)。
  bodyClass: CelestialClass;
  // 天体の表示分類に基づくラベル優先度。数値が大きいほど優先して残す。
  readonly labelPriority: number;
  // 主星を 0 とする階層の深さ。一覧をこの順・この字下げで並べると親子関係がそのまま出る。
  depth: number;
  // このフレームでマーカーの点・名前をそれぞれ描くか。
  showIcon: boolean;
  showLabel: boolean;
  // 遮蔽された対象や、アイコンもラベルも無い対象はフォーカス候補にしない。
  pickable: boolean;
}

// ラグランジュ点の名前。所属天体を前に置き、一覧では親の直下に並ぶ。
function lagrangeName(bodyName: string, n: 1 | 2 | 3 | 4 | 5): string {
  return `${bodyName}-L${n}`;
}

// ラグランジュ点のマーカー表記。地点名を上、所属天体を下の行に置く。
function lagrangeMarkerLabel(bodyName: string, n: 1 | 2 | 3 | 4 | 5): string {
  return `L${n}\n${bodyName}`;
}

// 陣営種別ごとのサブ行記号。mk-ally には専用の記号を持たせず、item.sym からの
// フォールバックに委ねる。
const SUB_LABEL_GLYPH_BY_KIND: Partial<Record<CombatMarkerKind, string>> = {
  self: '▲', base: '⬡', enemy: '△', ammo: '▣', fuel: '◈',
};

// サブ行テキスト用のクリーンな Unicode 記号を取得する(SVG タグ文字列を避ける)。
function cleanSubLabelGlyph(item: GroupedMarkerItem): string {
  const kind = combatMarkerKindOf(item.cls);
  const glyph = kind ? SUB_LABEL_GLYPH_BY_KIND[kind] : undefined;
  if (glyph) return glyph;
  if (item.sym && !item.sym.trim().startsWith('<')) return item.sym.trim();
  return '▲';
}

// 惑星 > 準惑星 > 衛星・小惑星・彗星 > ラグランジュ点。
// 恒星は太陽系の基準点なので、惑星と同じ最上位として常に残す。
const LABEL_PRIORITY: Record<'star' | 'planet' | 'dwarf' | 'satellite' | 'smallBody' | 'lagrange', number> = {
  star: MARKER_PRIORITY.STAR_PLANET,
  planet: MARKER_PRIORITY.STAR_PLANET,
  dwarf: MARKER_PRIORITY.DWARF_PLANET,
  satellite: MARKER_PRIORITY.SATELLITE_SMALL_BODY,
  smallBody: MARKER_PRIORITY.SATELLITE_SMALL_BODY,
  lagrange: MARKER_PRIORITY.LAGRANGE,
};

// 画面上で近接する2つの投影済みラベルのうち、優先度または奥行きガードで隠す側を選ぶ一様グリッド。
// 名前用・アイコン用でそれぞれ1インスタンスを持ち、混雑半径と距離比ヒステリシスの状態を分離する。
class CrowdingGrid {
  private readonly cellsScratch = new Map<number, Map<number, ProjectedFocusLabel[]>>();
  private readonly cellPool: ProjectedFocusLabel[][] = [];
  private readonly cellRowPool: Map<number, ProjectedFocusLabel[]>[] = [];
  private readonly hiddenScratchA = new Set<string>();
  private readonly hiddenScratchB = new Set<string>();
  private hiddenLastFrame: ReadonlySet<string> = new Set();

  constructor(
    private readonly cellSizePx: number,
    private readonly depthGuardRatio: number,
    private readonly depthGuardExitRatio: number,
  ) {}

  // items 内で cellSizePx 未満に近接するペアごとに、距離比(depth-guard)→優先度→深さ→id の順で
  // 隠す側を決め、隠す id の集合を返す。返した集合は次回呼び出しまで有効(内部でダブルバッファ)。
  compute(items: readonly ProjectedFocusLabel[]): ReadonlySet<string> {
    const hidden = this.hiddenLastFrame === this.hiddenScratchA ? this.hiddenScratchB : this.hiddenScratchA;
    hidden.clear();
    for (const row of this.cellsScratch.values()) {
      for (const cell of row.values()) {
        cell.length = 0;
        this.cellPool.push(cell);
      }
      row.clear();
      this.cellRowPool.push(row);
    }
    this.cellsScratch.clear();
    const cells = this.cellsScratch;
    // 一様グリッドで近傍セルだけを比較する。ラベル数が増えても O(N²) で全画面を走査しない。
    for (const current of items) {
      const cx = Math.floor(current.x / this.cellSizePx);
      const cy = Math.floor(current.y / this.cellSizePx);
      for (let x = cx - 1; x <= cx + 1; x++) {
        const row = cells.get(x);
        if (row === undefined) continue;
        for (let y = cy - 1; y <= cy + 1; y++) {
          const cell = row.get(y);
          if (cell === undefined) continue;
          for (const other of cell) {
            if (Math.hypot(current.x - other.x, current.y - other.y) >= this.cellSizePx) continue;
            const winner = resolveCrowdingWinner(
              current.label.id, current.label.labelPriority, current.dist, this.hiddenLastFrame.has(current.label.id),
              other.label.id, other.label.labelPriority, other.dist, this.hiddenLastFrame.has(other.label.id),
              this.depthGuardRatio, this.depthGuardExitRatio, true,
              current.label.depth, other.label.depth,
            );
            if (winner === 'a') hidden.add(current.label.id);
            else if (winner === 'b') hidden.add(other.label.id);
          }
        }
      }
      let row = cells.get(cx);
      if (row === undefined) {
        row = this.cellRowPool.pop() ?? new Map<number, ProjectedFocusLabel[]>();
        cells.set(cx, row);
      }
      const cell = row.get(cy);
      if (cell) cell.push(current);
      else {
        const nextCell = this.cellPool.pop() ?? [];
        nextCell.push(current);
        row.set(cy, nextCell);
      }
    }
    this.hiddenLastFrame = hidden;
    return hidden;
  }
}

export class FocusMarkers {
  // ラグランジュ点ラベルを持つ天体と、そのうち成立する点の番号(表示名は「天体名-Ln」)。
  private readonly lagrangeSources: readonly {
    readonly id: string;
    readonly name: string;
    readonly motion: OrbitingMotion;
    readonly points: readonly (1 | 2 | 3 | 4 | 5)[];
  }[];
  // トグル・フォーカスに関わらない全登録天体+全ラグランジュ点ラベルの全集合(id/isLagrange 目的)。
  readonly allLabels: readonly FocusLabel[];
  // このフレームで表示する対象に絞ったラベル。
  private shownLabels: readonly FocusLabel[] = [];
  // 直前のフレームに表示していたラベル id(集合から外れたものを隠すため)。
  private prevShownIds: readonly string[] = [];

  private celestialBodies: readonly CelestialBody[] = [];
  private readonly labelsById = new Map<string, FocusLabel>();
  private readonly bodyPickableRecords = new Map<string, MutableMapPickable>();
  private readonly cachedBodyPickables: MutableMapPickable[] = [];
  private cachedBodyPickablesTime: number | null = null;
  private cachedBodyPickablesPolicy: MapVisibilityPolicy | null = null;
  private readonly frameScratch = new Map<string, FocusProjection>();
  private readonly distScratch = new Map<string, number>();
  private readonly projectedForLabel: ProjectedFocusLabel[] = [];
  private readonly projectedForIcon: ProjectedFocusLabel[] = [];
  // 名前の間引きとアイコンの間引きは混雑半径が異なる(アイコンの方が近接しないと間引かれない)ため、
  // グリッドとヒステリシス状態を別々に持つ。
  private readonly labelCrowding = new CrowdingGrid(FOCUS_LABEL_PRIORITY_PX, DEPTH_GUARD_RATIO, DEPTH_GUARD_EXIT_RATIO);
  private readonly iconCrowding = new CrowdingGrid(FOCUS_ICON_PRIORITY_PX, DEPTH_GUARD_RATIO, DEPTH_GUARD_EXIT_RATIO);
  private shownIdsScratch: string[] = [];
  private readonly nowShownScratch = new Set<string>();
  private readonly activeCelestialLabels: ActiveCelestialLabel[] = [];

  get shownLabelCount(): number { return this.shownLabels.length; }
  get activeLabels(): readonly ActiveCelestialLabel[] { return this.activeCelestialLabels; }

  // 星系の全天体からラベルの全集合を1度だけ組む。ラグランジュ点は5点まとめてではなく、
  // 共線点・三角点それぞれの成立条件を満たす点だけを持たせる。
  constructor(private readonly markerManager: MarkerManager, private readonly celestialSystem: CelestialSystem) {
    this.lagrangeSources = celestialSystem.entities.flatMap((body) => {
      const motion = body.motion;
      // ラグランジュ点を出すと宣言した系だけが起点になる。全公転天体で出すと点の数が
      // 天体数の数倍になり、ラベルが画面を埋める。
      if (!(motion instanceof OrbitingMotion) || motion.def.lagrangeLabels !== true) return [];
      const points = [
        ...(motion.hasUsableCollinearPoints(LAGRANGE_MIN_CLEARANCE_RATIO) ? [1, 2, 3] as const : []),
        ...(motion.hasStableTriangularPoints() ? [4, 5] as const : []),
      ];
      return points.length === 0 ? [] : [{ id: body.id, name: body.name, motion, points }];
    });

    // 親を先に、その子を続けて並べる。一覧はこの順をそのまま使うので、並べ替えを持たない。
    // 星系は実行時に差し替えられるので、親子関係が循環していても停止し、同じ天体を
    // 二度並べないよう追加済みを覚えておく。
    const labels: FocusLabel[] = [];
    const added = new Set<string>();
    const pointsOf = new Map(this.lagrangeSources.map((s) => [s.id, s.points]));
    const appendBody = (id: string, depth: number): void => {
      if (added.has(id)) return;
      added.add(id);
      const body = this.celestialSystem.entityOf(id);
      const cls = body.bodyClass;
      labels.push({
        id, name: body.name, markerLabel: body.name,
        pos: v3(0, 0, 0), kind: 'body', isLagrange: false, bodyClass: cls,
        labelPriority: LABEL_PRIORITY[cls], depth,
        showIcon: false, showLabel: false, pickable: true,
      });
      for (const n of pointsOf.get(id) ?? []) {
        labels.push({
          id: `${id}-l${n}`, name: lagrangeName(body.name, n), markerLabel: lagrangeMarkerLabel(body.name, n),
          pos: v3(0, 0, 0),
          kind: 'body', isLagrange: true, bodyClass: cls, labelPriority: LABEL_PRIORITY.lagrange, depth: depth + 1,
          showIcon: false, showLabel: false, pickable: true,
        });
      }
      for (const child of this.celestialSystem.entities) {
        if (child.id !== id && child.motion.primary?.id === id) appendBody(child.id, depth + 1);
      }
    };
    for (const body of this.celestialSystem.entities) {
      if (body.motion.primary === null) appendBody(body.id, 0);
    }
    // 主星を持たない孤立した天体(親が登録されていない星系・循環した星系)も落とさない。
    for (const body of this.celestialSystem.entities) appendBody(body.id, 0);
    this.allLabels = labels;
    for (const label of labels) this.labelsById.set(label.id, label);
  }

  isBodyPickable(id: string): boolean {
    return this.labelsById.get(id)?.pickable ?? true;
  }

  // 表示中の天体・ラグランジュ点の時刻 t の座標。軌道物体一覧・右クリック候補も
  // 同じ表示ポリシーを通し、非表示設定の対象を選べない状態にする。遮蔽やラベル衝突で
  // マーカーを描かなかった対象は pickable: false を伴って出す — 表示設定で消えているわけでは
  // ないので候補からは落とさず、画面に出ていない対象を掴めないことだけを表す。
  bodyPickables(t: number, visibilityPolicy: MapVisibilityPolicy): readonly MapPickable[] {
    if (this.cachedBodyPickablesTime === t && this.cachedBodyPickablesPolicy === visibilityPolicy) {
      // syncLabels は遮蔽・ラベル衝突の結果だけ label.pickable を更新する。候補の配列と
      // 座標はそのまま再利用し、ここではその結果だけを反映する。
      for (const item of this.cachedBodyPickables) {
        item.pickable = this.labelsById.get(item.id)?.pickable ?? true;
      }
      return this.cachedBodyPickables;
    }

    // update を通らずに直接呼ばれる場合も既存の時刻仕様を保つ。通常の MapPickables 経路は
    // update が先に同じ policy で座標を作るため、下記の再計算分岐には入らない。
    const posOf = new Map(this.celestialSystem.celestialBodiesAt(t).map((a) => [a.id, a.state.r]));
    const drawn = new Map(this.allLabels.map((lbl) => [lbl.id, lbl.pickable]));
    this.cachedBodyPickables.length = 0;
    for (const body of this.celestialSystem.entities) {
      if (!visibilityPolicy.body(body.id).pickable) continue;
      const pos = posOf.get(body.id);
      if (pos !== undefined) this.cacheBodyPickable(
        body.id, body.name, pos, drawn.get(body.id) ?? true,
      );
    }
    for (const { id, name, motion, points } of this.lagrangeSources) {
      if (!visibilityPolicy.body(id).category) continue;
      const frame = secondaryFrameOf(this.celestialSystem.celestialBodiesAt(t), motion, t);
      if (frame === null) continue;
      const l = lagrangePointsOf(frame);
      for (const n of points) {
        const lagrangeId = `${id}-l${n}`;
        if (visibilityPolicy.body(lagrangeId).pickable) {
          this.cacheBodyPickable(
            lagrangeId, lagrangeName(name, n), l[`L${n}`], drawn.get(lagrangeId) ?? true,
          );
        }
      }
    }
    this.cachedBodyPickablesTime = t;
    this.cachedBodyPickablesPolicy = visibilityPolicy;
    return this.cachedBodyPickables;
  }

  private cacheBodyPickable(id: string, name: string, pos: Vec3, pickable: boolean): void {
    let item = this.bodyPickableRecords.get(id);
    if (item === undefined) {
      item = { id, name, pos, kind: 'body', pickable };
      this.bodyPickableRecords.set(id, item);
    } else {
      item.name = name;
      item.pos = pos;
      item.kind = 'body';
      item.pickable = pickable;
    }
    this.cachedBodyPickables.push(item);
  }

  // 表示時刻 t の各ラベル座標を求め直す。表示対象の外にある天体は座標計算ごと飛ばす —
  // 登録天体が増えるほどラグランジュ点の解決(1天体あたり位置2回 + 回転系1回)が効くため。
  // visibilityPolicy は同じフレームの update 位相で確定させた表示ポリシーを渡す。マーカー・
  // 選択候補・参照線が同じインスタンスを読むことで、個別実装の解釈ずれをなくす。
  update(
    t: number, toggles: MapDisplayToggles, visibilityPolicy: MapVisibilityPolicy,
  ): void {
    const celestialSystem = this.celestialSystem;
    const celestialBodies = celestialSystem.celestialBodiesAt(t);

    const positions: Record<string, Vec3> = {};
    const displayMap: Record<string, { icon: boolean; label: boolean }> = {};
    this.cachedBodyPickables.length = 0;
    for (const body of celestialSystem.entities) {
      const visibility = visibilityPolicy.body(body.id);
      if (!visibility.pickable) continue;
      const pos = body.stateAt(t, t).r;
      positions[body.id] = pos;
      displayMap[body.id] = { icon: visibility.icon, label: visibility.label };
      this.cacheBodyPickable(body.id, body.name, pos, true);
    }
    if (toggles.lagrangeVisible && toggles.lagrangeName) {
      for (const { id, name, motion, points } of this.lagrangeSources) {
        if (!visibilityPolicy.body(id).category) continue;
        const frame = secondaryFrameOf(celestialBodies, motion, t);
        if (frame === null) continue;
        const l = lagrangePointsOf(frame);
        for (const n of points) {
          const lagrangeId = `${id}-l${n}`;
          const visibility = visibilityPolicy.body(lagrangeId);
          if (!visibility.pickable) continue;
          const pos = l[`L${n}`];
          positions[lagrangeId] = pos;
          displayMap[lagrangeId] = { icon: visibility.icon, label: visibility.label };
          this.cacheBodyPickable(lagrangeId, lagrangeName(name, n), pos, true);
        }
      }
    }

    const shown: FocusLabel[] = [];
    for (const lbl of this.allLabels) {
      const pos = positions[lbl.id];
      if (pos === undefined) continue;
      lbl.pos = pos;
      const d = displayMap[lbl.id]!;
      lbl.showIcon = d.icon;
      lbl.showLabel = d.label;
      lbl.pickable = this.labelsById.get(lbl.id)?.pickable ?? true;
      shown.push(lbl);
    }
    this.shownLabels = shown;
    this.celestialBodies = celestialBodies;
    this.cachedBodyPickablesTime = t;
    this.cachedBodyPickablesPolicy = visibilityPolicy;
  }

  // update が求めた座標へラベルのマーカーを置く。天体に遮られているラベルは隠し、
  // 画面上で近接するラベルは、カメラからの距離が著しく離れていれば遠い方、
  // 同程度の距離なら優先度の低い方を隠す。
  syncLabels(project: ProjectFn, cameraPos: Vec3): void {
    const frame = this.frameScratch;
    frame.clear();
    const distById = this.distScratch;
    distById.clear();
    // 実際に文字列を出すラベル・アイコンだけをそれぞれの競合対象にする。同じ優先度同士は
    // 両方残し、MarkerManager の通常の衝突緩和へ任せる。遮蔽判定と投影は各ラベル1回だけ行う。
    const projectedForLabel = this.projectedForLabel;
    const projectedForIcon = this.projectedForIcon;
    projectedForLabel.length = 0;
    projectedForIcon.length = 0;
    for (const lbl of this.shownLabels) {
      const opacity = occlusionOpacity(cameraPos, lbl.pos, this.celestialBodies);
      const occluded = opacity <= 0;
      const p = project(lbl.pos);
      frame.set(lbl.id, { occluded, opacity, x: p.x, y: p.y, front: p.front });
      if (!occluded && p.front) {
        const entry = { label: lbl, x: p.x, y: p.y, dist: len(sub(lbl.pos, cameraPos)) };
        distById.set(lbl.id, entry.dist);
        if (lbl.showLabel) projectedForLabel.push(entry);
        if (lbl.showIcon) projectedForIcon.push(entry);
      }
    }

    const hiddenLabelByPriority = this.labelCrowding.compute(projectedForLabel);
    const hiddenIconByPriority = this.iconCrowding.compute(projectedForIcon);

    const shownIds = this.shownIdsScratch;
    shownIds.length = 0;
    this.activeCelestialLabels.length = 0;
    for (const lbl of this.shownLabels) {
      shownIds.push(lbl.id);
      const projectedState = frame.get(lbl.id);
      if (projectedState === undefined || projectedState.occluded) {
        lbl.pickable = false;
        const rec = this.bodyPickableRecords.get(lbl.id);
        if (rec) rec.pickable = false;
        if (projectedState?.occluded) this.markerManager.fadeOut(lbl.id);
        else this.markerManager.hide(lbl.id);
        continue;
      }
      const markerOpacity = projectedState.opacity;
      const isLabelVisible = lbl.showLabel && !hiddenLabelByPriority.has(lbl.id);
      const isIconVisible = lbl.showIcon && !hiddenIconByPriority.has(lbl.id);
      if (!isLabelVisible && !isIconVisible) {
        lbl.pickable = false;
        const rec = this.bodyPickableRecords.get(lbl.id);
        if (rec) rec.pickable = false;
        this.markerManager.hide(lbl.id);
        continue;
      }
      lbl.pickable = isLabelVisible || isIconVisible;
      const rec = this.bodyPickableRecords.get(lbl.id);
      if (rec) rec.pickable = lbl.pickable;
      if (projectedState.front && (isIconVisible || isLabelVisible)) {
        this.activeCelestialLabels.push({
          id: lbl.id,
          x: projectedState.x,
          y: projectedState.y,
          priority: lbl.labelPriority,
          dist: distById.get(lbl.id)!,
          iconVisible: isIconVisible,
          labelVisible: isLabelVisible,
        });
      }
      this.markerManager.setPosition(
        lbl.id, lbl.isLagrange ? 'mk-poi mk-lagrange' : 'mk-poi',
        isIconVisible ? (lbl.isLagrange ? ENTITY_GLYPH.lagrange : bodyEntityGlyph(lbl.bodyClass)) : '',
        lbl.pos, project,
        isLabelVisible ? lbl.markerLabel : '',
        markerOpacity, undefined, undefined, false, false, lbl.labelPriority, cameraPos,
      );
    }
    const nowShown = this.nowShownScratch;
    nowShown.clear();
    for (const id of shownIds) nowShown.add(id);
    for (const id of this.prevShownIds) if (!nowShown.has(id)) this.markerManager.hide(id);
    const previous = this.prevShownIds as string[];
    this.prevShownIds = shownIds;
    this.shownIdsScratch = previous;
    this.shownIdsScratch.length = 0;
  }

  // クローズダウン時に非表示になった船・敵機・基地を、所属親天体ラベルの下にサブテキスト行として描画する。
  // 距離 500万 km 未満: 左揃え・目立たない色のリスト表示 (最大3行)
  // 距離 500万 km 以上: 第2段階の省略表示として 1行でアイコンと数のみ表示 (衛星系もまとめて表示・プレフィックスなし)
  syncSubLabels(
    groupedMarkers: GroupedMarkers,
    celestialBodies: readonly CelestialBody[],
    overviewMode: boolean,
    project: ProjectFn,
    cameraPos: Vec3,
  ): void {
    if (!overviewMode) return;

    const hiddenItems = groupedMarkers.getHiddenItems();
    if (hiddenItems.length === 0) return;

    const DIST_STAGE2_THRESHOLD = 5e9; // 5,000,000 km (500万km) in meters

    const itemsByTargetBody = new Map<string, { prefix: string; item: GroupedMarkerItem }[]>();

    for (const item of hiddenItems) {
      const center = strongestAttractor(item.pos, celestialBodies);
      const centerLbl = this.labelsById.get(center.id);
      const distToCenter = centerLbl ? len(sub(centerLbl.pos, cameraPos)) : Infinity;
      const isStage2 = distToCenter >= DIST_STAGE2_THRESHOLD;

      let targetId: string | null = null;
      let prefix = '';

      if (isStage2) {
        // 第2段階 (500万km以上): 「月:」などのプレフィックスを表示せず、主親天体(地球等)へ集約
        const primaryId = this.celestialSystem.entityOf(center.id).motion.primary?.id ?? null;
        if (primaryId && this.bodyPickableRecords.get(primaryId)?.pickable) {
          targetId = primaryId;
        } else if (this.bodyPickableRecords.get(center.id)?.pickable) {
          targetId = center.id;
        }
        prefix = '';
      } else {
        // 第1段階 (500万km未満): 直近天体ラベルがあればそこへ、なければ親天体へ「月:」プレフィックス付きで繰り上げ
        const rec = this.bodyPickableRecords.get(center.id);
        if (rec?.pickable) {
          targetId = center.id;
          prefix = '';
        } else {
          const primaryId = this.celestialSystem.entityOf(center.id).motion.primary?.id ?? null;
          if (primaryId && this.bodyPickableRecords.get(primaryId)?.pickable) {
            targetId = primaryId;
            prefix = `${this.celestialSystem.nameOf(center.id)}: `;
          }
        }
      }

      if (targetId) {
        let list = itemsByTargetBody.get(targetId);
        if (!list) {
          list = [];
          itemsByTargetBody.set(targetId, list);
        }
        list.push({ prefix, item });
      }
    }

    for (const [bodyId, entries] of itemsByTargetBody) {
      const lbl = this.labelsById.get(bodyId);
      if (!lbl || !lbl.showLabel || !lbl.pickable) continue;

      const distToBody = len(sub(lbl.pos, cameraPos));
      const isStage2 = distToBody >= DIST_STAGE2_THRESHOLD;
      const subDivs: string[] = [];

      if (isStage2) {
        // 第2段階 (500万km以上): アイコンと個数のみの1行省略表示 (衛星系の船もまとめてカウント)
        let nEnemy = 0;
        let nAlly = 0;
        let nBase = 0;
        let nAmmo = 0;
        let nFuel = 0;

        for (const entry of entries) {
          const kind = combatMarkerKindOf(entry.item.cls);
          if (kind === 'enemy') nEnemy++;
          else if (kind === 'base') nBase++;
          else if (kind === 'ammo') nAmmo++;
          else if (kind === 'fuel') nFuel++;
          else nAlly++;
        }

        const parts: string[] = [];
        if (nEnemy > 0) parts.push(`△${nEnemy}`);
        if (nAlly > 0) parts.push(`▲${nAlly}`);
        if (nBase > 0) parts.push(`⬡${nBase}`);
        if (nAmmo > 0) parts.push(`▣${nAmmo}`);
        if (nFuel > 0) parts.push(`◈${nFuel}`);

        if (parts.length > 0) {
          subDivs.push(`<div class="lbl-sub">${parts.join(' ')}</div>`);
        }
      } else {
        // 第1段階 (500km未満): 左揃えのリスト表示 (最大3行)
        entries.sort((a, b) => (b.item.priority ?? 0) - (a.item.priority ?? 0));
        const maxLines = 3;
        const total = entries.length;

        if (total <= maxLines) {
          for (const entry of entries) {
            const glyph = cleanSubLabelGlyph(entry.item);
            subDivs.push(`<div class="lbl-sub">${entry.prefix}${glyph} ${entry.item.name}</div>`);
          }
        } else {
          for (let i = 0; i < 2; i++) {
            const entry = entries[i]!;
            const glyph = cleanSubLabelGlyph(entry.item);
            subDivs.push(`<div class="lbl-sub">${entry.prefix}${glyph} ${entry.item.name}</div>`);
          }
          subDivs.push(`<div class="lbl-sub">+${total - 2} 隻</div>`);
        }
      }

      const fullLabelText = `<span class="lbl-main">${lbl.markerLabel}</span>${subDivs.join('')}`;

      const proj = this.frameScratch.get(lbl.id);
      if (proj && proj.front && !proj.occluded) {
        this.markerManager.setPosition(
          lbl.id, lbl.isLagrange ? 'mk-poi mk-lagrange' : 'mk-poi',
          lbl.showIcon ? (lbl.isLagrange ? ENTITY_GLYPH.lagrange : bodyEntityGlyph(lbl.bodyClass)) : '',
          lbl.pos, project,
          fullLabelText,
          proj.opacity, undefined, undefined, false, false, lbl.labelPriority, cameraPos,
        );
      }
    }
  }

  // マップモードを抜けたときの後始末(戦闘ビューには天体ラベルを出さない)。
  hideLabels(): void {
    this.activeCelestialLabels.length = 0;
    for (const lbl of this.allLabels) this.markerManager.hide(lbl.id);
  }
}
