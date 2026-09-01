// マップモードのフォーカス対象(天体・ラグランジュ点)ラベルの算出と HUD マーカーへの反映。
import { Vec3, v3, sub, len } from '../../math/vec3';
import { strongestAttractor } from '../../physics/attractor';
import { CelestialMotion } from '../../physics/celestial-motion';
import { ProjectFn } from './camera-system';
import { combatMarkerKindOf, MarkerManager, type CombatMarkerKind, MARKER_PRIORITY } from '../marker/marker-manager';
import { OrbitingMotion } from '../../physics/celestial-motion';
import { lagrangePointsOf, secondaryFrameOf } from '../../physics/lagrange';
import { occlusionOpacity } from '../../physics/occlusion';
import { MapDisplayToggles } from '../map/display-toggles';
import type { CelestialClass } from '../celestial/celestial-entity/celestial-entity-def';
import type { CelestialSystem } from '../celestial/celestial-system';
import { LAGRANGE_MIN_CLEARANCE_RATIO } from '../celestial/lagrange-id';
import { MapVisibilityPolicy } from '../map/visibility-policy';
import type { MapPickable } from '../pickable/map-pickable';
import { ENTITY_GLYPH, bodyEntityGlyph } from '../marker/marker-identity';
import type { GroupedMarkers, GroupedMarkerItem } from '../marker/grouped-markers';
import { resolveCrowdingWinner, DEPTH_GUARD_EXIT_RATIO, DEPTH_GUARD_RATIO } from '../marker/crowding';
import { LagrangePointMarker } from '../marker/lagrange-point-marker';

// 天体ラベルからこれより画面上で近いラグランジュ点ラベルは、天体ラベルを優先して隠す [px]
const FOCUS_LABEL_PRIORITY_PX = 40;

// 位置の点(アイコン)側の混雑判定。名前(FOCUS_LABEL_PRIORITY_PX)より小さい値にし、名前だけが
// 間引かれて点は残る距離帯を作る。
const FOCUS_ICON_PRIORITY_PX = 16;

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
  // ラグランジュ点マーカーを持つ天体と、そのうち成立する点のマーカー。
  private readonly lagrangeSources: readonly {
    readonly motion: OrbitingMotion;
    readonly markers: readonly LagrangePointMarker[];
  }[];
  // トグル・フォーカスに関わらない全登録天体+全ラグランジュ点ラベルの全集合(id/isLagrange 目的)。
  readonly allLabels: readonly FocusLabel[];
  // このフレームで表示する対象に絞ったラベル。
  private shownLabels: readonly FocusLabel[] = [];
  // 直前のフレームに表示していたラベル id(集合から外れたものを隠すため)。
  private prevShownIds: readonly string[] = [];

  // update が天体を厳密に引いた時刻。sync でのマップビュー遮蔽判定に使う。
  private celestialBodiesPivot = 0;
  private readonly labelsById = new Map<string, FocusLabel>();
  // update が座標を求めた天体とラグランジュ点マーカー。表示ポリシーを通ったものだけが並ぶ。
  private readonly bodyPickableItems: MapPickable[] = [];
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
      const markers = points.map((n) => new LagrangePointMarker(body.id, body.name, n));
      return markers.length === 0 ? [] : [{ motion, markers }];
    });

    // 親を先に、その子を続けて並べる。一覧はこの順をそのまま使うので、並べ替えを持たない。
    // 星系は実行時に差し替えられるので、親子関係が循環していても停止し、同じ天体を
    // 二度並べないよう追加済みを覚えておく。
    const labels: FocusLabel[] = [];
    const added = new Set<string>();
    const markersOf = new Map(this.lagrangeSources.map((s) => [s.markers[0]!.parentId, s.markers]));
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
      for (const marker of markersOf.get(id) ?? []) {
        labels.push({
          id: marker.id, name: marker.name, markerLabel: marker.markerLabel,
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

  // update が座標を求めた天体・ラグランジュ点マーカー。表示ポリシーを通ったものだけが並ぶ。
  get bodyPickables(): readonly MapPickable[] { return this.bodyPickableItems; }

  // 表示時刻 t の各ラベル座標を求め直す。表示対象の外にある天体は座標計算ごと飛ばす —
  // 登録天体が増えるほどラグランジュ点の解決(1天体あたり位置2回 + 回転系1回)が効くため。
  // visibilityPolicy は同じフレームの update 位相で確定させた表示ポリシーを渡す。マーカー・
  // 選択候補・参照線が同じインスタンスを読むことで、個別実装の解釈ずれをなくす。
  update(
    t: number, toggles: MapDisplayToggles, visibilityPolicy: MapVisibilityPolicy,
  ): void {
    const celestialSystem = this.celestialSystem;
    const celestialBodies = celestialSystem.celestialMotions;

    const positions: Record<string, Vec3> = {};
    const displayMap: Record<string, { icon: boolean; label: boolean }> = {};
    this.bodyPickableItems.length = 0;
    for (const body of celestialSystem.entities) {
      const visibility = visibilityPolicy.body(body.id);
      if (!visibility.pickable) continue;
      const pos = body.stateAt(t).r;
      positions[body.id] = pos;
      displayMap[body.id] = { icon: visibility.icon, label: visibility.label };
      this.bodyPickableItems.push(body);
    }
    if (toggles.lagrangeVisible && toggles.lagrangeName) {
      for (const { motion, markers } of this.lagrangeSources) {
        if (!visibilityPolicy.body(markers[0]!.parentId).category) continue;
        const frame = secondaryFrameOf(celestialBodies, t, motion, t);
        if (frame === null) { for (const marker of markers) marker.place(null); continue; }
        const l = lagrangePointsOf(frame);
        for (const marker of markers) {
          const visibility = visibilityPolicy.body(marker.id);
          const pos = l[`L${marker.point}`];
          marker.place(pos);
          if (!visibility.pickable) continue;
          positions[marker.id] = pos;
          displayMap[marker.id] = { icon: visibility.icon, label: visibility.label };
          this.bodyPickableItems.push(marker);
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
    this.celestialBodiesPivot = t;
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
      const opacity = occlusionOpacity(
        cameraPos, lbl.pos, this.celestialSystem.celestialMotions, this.celestialBodiesPivot);
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
        if (projectedState?.occluded) this.markerManager.fadeOut(lbl.id);
        else this.markerManager.hide(lbl.id);
        continue;
      }
      const markerOpacity = projectedState.opacity;
      const isLabelVisible = lbl.showLabel && !hiddenLabelByPriority.has(lbl.id);
      const isIconVisible = lbl.showIcon && !hiddenIconByPriority.has(lbl.id);
      if (!isLabelVisible && !isIconVisible) {
        lbl.pickable = false;
        this.markerManager.hide(lbl.id);
        continue;
      }
      lbl.pickable = isLabelVisible || isIconVisible;
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
    celestialBodies: readonly CelestialMotion[],
    pivot: number,
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
      const center = strongestAttractor(item.pos, celestialBodies, pivot);
      const centerLbl = this.labelsById.get(center.id);
      const distToCenter = centerLbl ? len(sub(centerLbl.pos, cameraPos)) : Infinity;
      const isStage2 = distToCenter >= DIST_STAGE2_THRESHOLD;

      let targetId: string | null = null;
      let prefix = '';

      if (isStage2) {
        // 第2段階 (500万km以上): 「月:」などのプレフィックスを表示せず、主親天体(地球等)へ集約
        const primaryId = this.celestialSystem.entityOf(center.id).motion.primary?.id ?? null;
        if (primaryId && this.labelsById.get(primaryId)?.pickable) {
          targetId = primaryId;
        } else if (this.labelsById.get(center.id)?.pickable) {
          targetId = center.id;
        }
        prefix = '';
      } else {
        // 第1段階 (500万km未満): 直近天体ラベルがあればそこへ、なければ親天体へ「月:」プレフィックス付きで繰り上げ
        const rec = this.labelsById.get(center.id);
        if (rec?.pickable) {
          targetId = center.id;
          prefix = '';
        } else {
          const primaryId = this.celestialSystem.entityOf(center.id).motion.primary?.id ?? null;
          if (primaryId && this.labelsById.get(primaryId)?.pickable) {
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
