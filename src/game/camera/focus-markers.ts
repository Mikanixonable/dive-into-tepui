// マップモードのフォーカス対象(天体・ラグランジュ点)ラベルの算出と HUD マーカーへの反映。
import { Vec3, v3, sub, len } from '../../physics/vec3';
import { Attractor, AttractorId, OrbitingId, strongestAttractor } from '../../physics/attractor';
import { CelestialRegistry, primaryOf } from '../../physics/solar-system';
import { ProjectFn } from './camera-system';
import { MarkerManager } from '../marker/marker-manager';
import type { Ephemeris } from '../../physics/ephemeris';
import { celestialBodyName } from '../hud/frame-labels';
import { occlusionOpacity } from '../../physics/occlusion';
import { BodyClassToggles, systemMembersAt } from '../celestial/body-visibility';
import { bodyClassOf } from '../celestial/body-class';
import { MapVisibilityPolicy } from '../celestial/map-visibility';
import { FOCUS_LABEL_PRIORITY_PX, LAGRANGE_MIN_CLEARANCE_RATIO, MARKER_PRIORITY } from '../const';
import type { MapPickable } from '../map-pickable';
import { ENTITY_GLYPH } from '../marker/marker-glyphs';
import type { GroupedMarkers, GroupedMarkerItem } from '../marker/grouped-markers';

type MutableMapPickable = { -readonly [K in keyof MapPickable]: MapPickable[K] };
type ProjectedFocusLabel = { label: FocusLabel; x: number; y: number };
type FocusProjection = { occluded: boolean; opacity: number; x: number; y: number; front: boolean };

export interface ActiveCelestialLabel {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly priority: number;
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
function lagrangeName(id: OrbitingId, n: 1 | 2 | 3 | 4 | 5): string {
  return `${celestialBodyName(id)}-L${n}`;
}

// ラグランジュ点のマーカー表記。地点名を上、所属天体を下の行に置く。
function lagrangeMarkerLabel(id: OrbitingId, n: 1 | 2 | 3 | 4 | 5): string {
  return `L${n}\n${celestialBodyName(id)}`;
}

// サブ行テキスト用のクリーンな Unicode 記号を取得する(SVG タグ文字列を避ける)。
function cleanSubLabelGlyph(item: GroupedMarkerItem): string {
  const cls = item.cls;
  if (cls.includes('mk-self')) return '▲';
  if (cls.includes('mk-base')) return '⬡';
  if (cls.includes('mk-enemy')) return '△';
  if (cls.includes('mk-ammo')) return '▣';
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

export class FocusMarkers {
  // 天体本体1つにつき1ラベル、ラグランジュ点が力学的に意味を持つ天体にはさらに L1〜L5 の
  // うち成立する点ぶんのラベルが並ぶ(表示名は「中心天体名-自分の名 Ln」)。
  private readonly registryIds: readonly AttractorId[];
  // ラグランジュ点ラベルを持つ天体と、そのうち成立する点の番号。
  private readonly lagrangeSources: readonly { readonly id: OrbitingId; readonly points: readonly (1 | 2 | 3 | 4 | 5)[] }[];
  // トグル・フォーカスに関わらない全登録天体+全ラグランジュ点ラベルの全集合(id/isLagrange 目的)。
  readonly allLabels: readonly FocusLabel[];
  // このフレームで表示する対象に絞ったラベル。
  private shownLabels: readonly FocusLabel[] = [];
  // 直前のフレームに表示していたラベル id(集合から外れたものを隠すため)。
  private prevShownIds: readonly string[] = [];

  private attractors: readonly Attractor[] = [];
  private readonly labelsById = new Map<string, FocusLabel>();
  private readonly bodyPickableRecords = new Map<string, MutableMapPickable>();
  private readonly cachedBodyPickables: MutableMapPickable[] = [];
  private cachedBodyPickablesTime: number | null = null;
  private cachedBodyPickablesPolicy: MapVisibilityPolicy | null = null;
  private readonly frameScratch = new Map<string, FocusProjection>();
  private readonly projectedScratch: ProjectedFocusLabel[] = [];
  private readonly hiddenByPriorityScratch = new Set<string>();
  // セル添字 (cx, cy) を x → y の二段の Map で引く。添字をそのまま鍵にするので、
  // 別のセルが同じ鍵を共有することはない。
  private readonly cellsScratch = new Map<number, Map<number, ProjectedFocusLabel[]>>();
  private readonly cellPool: ProjectedFocusLabel[][] = [];
  private readonly cellRowPool: Map<number, ProjectedFocusLabel[]>[] = [];
  private shownIdsScratch: string[] = [];
  private readonly nowShownScratch = new Set<string>();
  private readonly activeCelestialLabels: ActiveCelestialLabel[] = [];

  get shownLabelCount(): number { return this.shownLabels.length; }
  get activeLabels(): readonly ActiveCelestialLabel[] { return this.activeCelestialLabels; }

  // レジストリからラベルの全集合を1度だけ組む。ラグランジュ点は5点まとめてではなく、
  // 共線点・三角点それぞれの成立条件を満たす点だけを持たせる。
  constructor(private readonly markerManager: MarkerManager, private readonly ephemeris: Ephemeris) {
    const registry = ephemeris.registry;
    this.registryIds = Object.keys(registry);
    this.lagrangeSources = this.registryIds.flatMap((id) => {
      if (registry[id]!.kind === 'star') return [];
      const collinear = ephemeris.hasUsableCollinearPoints(id, LAGRANGE_MIN_CLEARANCE_RATIO);
      // 小天体・準惑星は数が多く、L3・L4・L5 まで並べるとラベルが密集しすぎる。
      const cls = bodyClassOf(registry, id);
      const minor = cls === 'smallBody' || cls === 'dwarf';
      const triangular = !minor && ephemeris.hasStableTriangularPoints(id);
      const points = [
        ...(collinear ? (minor ? [1, 2] as const : [1, 2, 3] as const) : []),
        ...(triangular ? [4, 5] as const : []),
      ];
      return points.length === 0 ? [] : [{ id, points }];
    });

    // 親を先に、その子を続けて並べる。一覧はこの順をそのまま使うので、並べ替えを持たない。
    // レジストリは実行時に差し替えられるので、親子関係が循環していても停止し、同じ天体を
    // 二度並べないよう追加済みを覚えておく。
    const labels: FocusLabel[] = [];
    const added = new Set<AttractorId>();
    const pointsOf = new Map(this.lagrangeSources.map((s) => [s.id, s.points]));
    const appendBody = (id: AttractorId, depth: number): void => {
      if (added.has(id)) return;
      added.add(id);
      labels.push({
        id, name: celestialBodyName(id), markerLabel: celestialBodyName(id),
        pos: v3(0, 0, 0), kind: 'body', isLagrange: false,
        labelPriority: LABEL_PRIORITY[bodyClassOf(registry, id)], depth,
        showIcon: false, showLabel: false, pickable: true,
      });
      for (const n of pointsOf.get(id) ?? []) {
        labels.push({
          id: `${id}-l${n}`, name: lagrangeName(id, n), markerLabel: lagrangeMarkerLabel(id, n), pos: v3(0, 0, 0),
          kind: 'body', isLagrange: true, labelPriority: LABEL_PRIORITY.lagrange, depth: depth + 1,
          showIcon: false, showLabel: false, pickable: true,
        });
      }
      for (const child of this.registryIds) {
        if (child !== id && primaryOf(registry, child) === id) appendBody(child, depth + 1);
      }
    };
    for (const id of this.registryIds) {
      if (primaryOf(registry, id) === null) appendBody(id, 0);
    }
    // 主星を持たない孤立した天体(親が登録されていないレジストリ・循環したレジストリ)も落とさない。
    for (const id of this.registryIds) appendBody(id, 0);
    this.allLabels = labels;
    for (const label of labels) this.labelsById.set(label.id, label);
  }

  isBodyPickable(id: string): boolean {
    return this.labelsById.get(id)?.pickable ?? true;
  }

  // 表示中の天体・ラグランジュ点の時刻 t の座標。軌道オブジェクト一覧・右クリック候補も
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
    const ephemeris = this.ephemeris;
    const posOf = new Map(ephemeris.attractorsAt(t).map((a) => [a.id, a.state.r]));
    const drawn = new Map(this.allLabels.map((lbl) => [lbl.id, lbl.pickable]));
    this.cachedBodyPickables.length = 0;
    for (const id of this.registryIds) {
      if (!visibilityPolicy.body(id).pickable) continue;
      const pos = posOf.get(id);
      if (pos !== undefined) this.cacheBodyPickable(
        id, celestialBodyName(id), pos, drawn.get(id) ?? true,
      );
    }
    for (const { id, points } of this.lagrangeSources) {
      if (!visibilityPolicy.body(id).category) continue;
      const l = ephemeris.lagrangeAt(id, t);
      for (const n of points) {
        const lagrangeId = `${id}-l${n}`;
        if (visibilityPolicy.body(lagrangeId).pickable) {
          this.cacheBodyPickable(
            lagrangeId, lagrangeName(id, n), l[`L${n}`], drawn.get(lagrangeId) ?? true,
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
  // 登録天体が増えるほど lagrangeAt(1天体あたり positionOf 2回 + 回転系1回)が効くため。
  update(
    t: number, focusId: AttractorId | undefined, toggles: BodyClassToggles, cameraPos: Vec3,
    sharedVisibilityPolicy?: MapVisibilityPolicy,
  ): void {
    const ephemeris = this.ephemeris;
    const attractors = ephemeris.attractorsAt(t);
    // フォーカスを解除しても、カメラが実際にいる惑星系の衛星は消さない。カメラ位置の
    // 「近さ」を固定距離で判定せず、既存の重力系判定を使うことで、地球/月や木星/衛星の
    // 境界を同じ規則で扱える。
    const nearby = sharedVisibilityPolicy === undefined
      ? systemMembersAt(ephemeris.registry, cameraPos, attractors)
      : [];
    // まず表示対象を決め、その中だけ座標を引く。表示の判断は marker/map-picker/参照線と
    // 同じ MapVisibilityPolicy を使い、個別実装の解釈ずれをなくす。
    const visibilityPolicy = sharedVisibilityPolicy
      ?? new MapVisibilityPolicy(ephemeris.registry, toggles, focusId, nearby);

    const positions: Record<string, Vec3> = {};
    const displayMap: Record<string, { icon: boolean; label: boolean }> = {};
    this.cachedBodyPickables.length = 0;
    for (const id of this.registryIds) {
      const visibility = visibilityPolicy.body(id);
      if (!visibility.pickable) continue;
      const pos = ephemeris.positionOf(id, t);
      positions[id] = pos;
      displayMap[id] = { icon: visibility.icon, label: visibility.label };
      this.cacheBodyPickable(id, celestialBodyName(id), pos, true);
    }
    if (toggles.lagrangeVisible && (toggles.lagrangeIcon || toggles.lagrangeLabel)) {
      for (const { id, points } of this.lagrangeSources) {
        if (!visibilityPolicy.body(id).category) continue;
        const l = ephemeris.lagrangeAt(id, t);
        for (const n of points) {
          const lagrangeId = `${id}-l${n}`;
          const visibility = visibilityPolicy.body(lagrangeId);
          if (!visibility.pickable) continue;
          const pos = l[`L${n}`];
          positions[lagrangeId] = pos;
          displayMap[lagrangeId] = { icon: visibility.icon, label: visibility.label };
          this.cacheBodyPickable(lagrangeId, lagrangeName(id, n), pos, true);
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
    this.attractors = attractors;
    this.cachedBodyPickablesTime = t;
    this.cachedBodyPickablesPolicy = visibilityPolicy;
  }

  // update が求めた座標へラベルのマーカーを置く。天体に遮られているラベルは隠し、
  // 画面上で近接するラベルは優先度の低い方を隠す。
  syncLabels(project: ProjectFn, cameraPos: Vec3): void {
    const frame = this.frameScratch;
    frame.clear();
    // 実際に文字列を出すラベルだけを競合対象にする。同じ優先度同士は両方残し、
    // MarkerManager の通常の衝突緩和へ任せる。遮蔽判定と投影は各ラベル1回だけ行う。
    const projected = this.projectedScratch;
    projected.length = 0;
    for (const lbl of this.shownLabels) {
      const opacity = occlusionOpacity(cameraPos, lbl.pos, this.attractors);
      const occluded = opacity <= 0;
      const p = project(lbl.pos);
      frame.set(lbl.id, { occluded, opacity, x: p.x, y: p.y, front: p.front });
      if (!occluded && p.front && lbl.showLabel) projected.push({ label: lbl, x: p.x, y: p.y });
    }

    const hiddenByPriority = this.hiddenByPriorityScratch;
    hiddenByPriority.clear();
    // 一様グリッドで近傍セルだけを比較する。ラベル数が増えても O(N²) で全画面を走査しない。
    const cellSize = FOCUS_LABEL_PRIORITY_PX;
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
    for (const current of projected) {
      const cx = Math.floor(current.x / cellSize);
      const cy = Math.floor(current.y / cellSize);
      for (let x = cx - 1; x <= cx + 1; x++) {
        const row = cells.get(x);
        if (row === undefined) continue;
        for (let y = cy - 1; y <= cy + 1; y++) {
          const cell = row.get(y);
          if (cell === undefined) continue;
          for (const other of cell) {
            if (Math.hypot(current.x - other.x, current.y - other.y) >= FOCUS_LABEL_PRIORITY_PX) continue;
            if (current.label.labelPriority > other.label.labelPriority) {
              hiddenByPriority.add(other.label.id);
            } else if (other.label.labelPriority > current.label.labelPriority) {
              hiddenByPriority.add(current.label.id);
            } else {
              // 優先度が等しい場合の決定論的タイブレーク (格子順に依存せずチラつきを防ぐ)
              if (current.label.depth > other.label.depth) hiddenByPriority.add(current.label.id);
              else if (other.label.depth > current.label.depth) hiddenByPriority.add(other.label.id);
              else if (current.label.id > other.label.id) hiddenByPriority.add(current.label.id);
              else hiddenByPriority.add(other.label.id);
            }
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
      // ラベルテキストが表示されている対象のみをクリック・フォーカス対象(pickable)にする。
      const isLabelVisible = lbl.showLabel && !hiddenByPriority.has(lbl.id);
      lbl.pickable = isLabelVisible;
      const rec = this.bodyPickableRecords.get(lbl.id);
      if (rec) rec.pickable = isLabelVisible;
      if (projectedState.front && (lbl.showIcon || isLabelVisible)) {
        this.activeCelestialLabels.push({
          id: lbl.id,
          x: projectedState.x,
          y: projectedState.y,
          priority: lbl.labelPriority,
          iconVisible: lbl.showIcon,
          labelVisible: isLabelVisible,
        });
      }
      this.markerManager.setPosition(
        lbl.id, lbl.isLagrange ? 'mk-poi mk-lagrange' : 'mk-poi',
        lbl.showIcon ? (lbl.isLagrange ? ENTITY_GLYPH.lagrange : ENTITY_GLYPH.body) : '',
        lbl.pos, project,
        isLabelVisible ? lbl.markerLabel : '',
        markerOpacity, undefined, undefined, false, false, lbl.labelPriority,
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
  // 距離 1,000万 km 未満: 左揃え・目立たない色のリスト表示 (最大3行)
  // 距離 1,000万 km 以上: 第2段階の省略表示として 1行でアイコンと数のみ表示 (例: △3 ▲1)
  syncSubLabels(
    groupedMarkers: GroupedMarkers,
    registry: CelestialRegistry,
    attractors: readonly Attractor[],
    overviewMode: boolean,
    project: ProjectFn,
    cameraPos: Vec3,
  ): void {
    if (!overviewMode) return;

    const hiddenItems = groupedMarkers.getHiddenItems();
    if (hiddenItems.length === 0) return;

    const itemsByTargetBody = new Map<string, { prefix: string; item: GroupedMarkerItem }[]>();

    for (const item of hiddenItems) {
      const center = strongestAttractor(item.pos, attractors);
      let targetId: string | null = null;
      let prefix = '';

      const rec = this.bodyPickableRecords.get(center.id);
      if (rec?.pickable) {
        targetId = center.id;
        prefix = '';
      } else {
        const primaryId = primaryOf(registry, center.id as OrbitingId);
        if (primaryId && this.bodyPickableRecords.get(primaryId)?.pickable) {
          targetId = primaryId;
          prefix = `${celestialBodyName(center.id as AttractorId)}: `;
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

    const DIST_STAGE2_THRESHOLD = 1e10; // 10,000,000 km in meters

    for (const [bodyId, entries] of itemsByTargetBody) {
      const lbl = this.labelsById.get(bodyId);
      if (!lbl || !lbl.showLabel || !lbl.pickable) continue;

      const distToBody = len(sub(lbl.pos, cameraPos));
      const isStage2 = distToBody >= DIST_STAGE2_THRESHOLD;
      const subDivs: string[] = [];

      if (isStage2) {
        // 第2段階 (1,000万km以上): アイコンと個数のみの1行省略表示
        const entriesByPrefix = new Map<string, GroupedMarkerItem[]>();
        for (const entry of entries) {
          let list = entriesByPrefix.get(entry.prefix);
          if (!list) {
            list = [];
            entriesByPrefix.set(entry.prefix, list);
          }
          list.push(entry.item);
        }

        for (const [prefix, items] of entriesByPrefix) {
          let nEnemy = 0;
          let nAlly = 0;
          let nBase = 0;
          let nAmmo = 0;
          for (const item of items) {
            if (item.cls.includes('mk-enemy')) nEnemy++;
            else if (item.cls.includes('mk-base')) nBase++;
            else if (item.cls.includes('mk-ammo')) nAmmo++;
            else nAlly++;
          }
          const parts: string[] = [];
          if (nEnemy > 0) parts.push(`△${nEnemy}`);
          if (nAlly > 0) parts.push(`▲${nAlly}`);
          if (nBase > 0) parts.push(`⬡${nBase}`);
          if (nAmmo > 0) parts.push(`▣${nAmmo}`);

          if (parts.length > 0) {
            subDivs.push(`<div class="lbl-sub">${prefix}${parts.join(' ')}</div>`);
          }
        }
      } else {
        // 第1段階 (1,000万km未満): 左揃えのリスト表示 (最大3行)
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
          lbl.showIcon ? (lbl.isLagrange ? ENTITY_GLYPH.lagrange : ENTITY_GLYPH.body) : '',
          lbl.pos, project,
          fullLabelText,
          proj.opacity, undefined, undefined, false, false, lbl.labelPriority,
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
