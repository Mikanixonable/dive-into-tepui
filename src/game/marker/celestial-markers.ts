// マップの天体・ラグランジュ点のラベルを、集合として間引きながら HUD マーカーへ出す。
// 画面上で近すぎるものをどれだけ残すかという、集合でしか決まらない判断を持つ。名前と
// アイコンは別々の混雑半径で間引くので、名前だけが消えてアイコンが残る距離帯ができる。
import { Vec3, v3, sub, len } from '../../math/vec3';
import { OrbitingMotion } from '../../physics/celestial-motion';
import { lagrangePointsOf, secondaryFrameOf } from '../../physics/lagrange';
import { occlusionOpacity } from '../../physics/occlusion';
import { LAGRANGE_MIN_CLEARANCE_RATIO } from '../celestial/lagrange-id';
import { LagrangePointMarker } from './lagrange-point-marker';
import { CelestialSubLabels, type CelestialLabelState } from './celestial-sub-labels';
import { CrowdingGrid, DEPTH_GUARD_EXIT_RATIO, DEPTH_GUARD_RATIO, type ProjectedLabel } from './crowding';
import type { CelestialMotion } from '../../physics/celestial-motion';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { MapDisplayToggles } from '../map/display-toggles';
import type { MapPickable } from '../pickable/map-pickable';
import type { MapVisibilityPolicy } from '../map/visibility-policy';
import type { ProjectFn } from '../camera/camera-system';
import type { GroupedMarkers } from './grouped-markers';
import type { MarkerManager } from './marker-manager';

// 天体ラベルからこれより画面上で近いラグランジュ点ラベルは、天体ラベルを優先して隠す [px]
const LABEL_CROWDING_PX = 40;

// 位置の点(アイコン)側の混雑判定。名前より小さい値にし、名前だけが間引かれて点は残る距離帯を作る。
const ICON_CROWDING_PX = 16;

// ラベル集合の1件ぶんに要る性質。天体とラグランジュ点マーカーが実装する。
interface CelestialMarkerItem {
  readonly id: string;
  // マップのマーカーへ描く表記。
  readonly markerLabel: string;
  // アイコンの字形。
  readonly mapGlyph: string;
  readonly markerClass: string;
  // ラベルが混雑したときに優先して残す度合い。大きいほど残る。
  readonly labelPriority: number;
}

// 他のマーカー集合が天体ラベルとの近接を測るために読む、今フレームの1件ぶん。
export interface ActiveCelestialLabel {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly priority: number;
  readonly dist: number;
  readonly iconVisible: boolean;
  readonly labelVisible: boolean;
}

// 今フレームの1件ぶんの表示状態。
interface CelestialLabel {
  readonly item: CelestialMarkerItem;
  // 主星を 0 とする階層の深さ。優先度が等しいときのタイブレークに使う。
  readonly depth: number;
  pos: Vec3;
  showIcon: boolean;
  showLabel: boolean;
  // 遮蔽・混雑でマーカーを描かなかった対象は掴めない。
  pickable: boolean;
}

// 投影の結果。同じフレーム内でラベル同期とサブ行が読む。
interface LabelProjection {
  readonly occluded: boolean;
  readonly opacity: number;
  readonly x: number;
  readonly y: number;
  readonly front: boolean;
}

export class CelestialMarkers {
  // ラグランジュ点マーカーを持つ天体と、そのうち成立する点のマーカー。
  private readonly lagrangeSources: readonly {
    readonly motion: OrbitingMotion;
    readonly markers: readonly LagrangePointMarker[];
  }[];
  // トグル・フォーカスに関わらない全ラベル(天体とラグランジュ点、親を先に並べたもの)。
  private readonly labels: readonly CelestialLabel[];
  // 同じ並びの対象そのもの。id から親子関係を引くための一覧。
  readonly allItems: readonly CelestialMarkerItem[];
  private readonly labelsById = new Map<string, CelestialLabel>();
  // このフレームで表示する対象に絞ったラベル。
  private shownLabels: readonly CelestialLabel[] = [];
  // 直前のフレームに表示していたラベル id(集合から外れたものを隠すため)。
  private prevShownIds: readonly string[] = [];

  // update が天体を厳密に引いた時刻。sync での遮蔽判定に使う。
  private celestialBodiesPivot = 0;
  // update が座標を求めた天体とラグランジュ点マーカー。表示ポリシーを通ったものだけが並ぶ。
  private readonly bodyPickableItems: MapPickable[] = [];
  private readonly frameScratch = new Map<string, LabelProjection>();
  private readonly distScratch = new Map<string, number>();
  private readonly projectedForLabel: ProjectedLabel[] = [];
  private readonly projectedForIcon: ProjectedLabel[] = [];
  // 名前の間引きとアイコンの間引きは混雑半径が異なるため、グリッドとヒステリシス状態を別々に持つ。
  private readonly labelCrowding = new CrowdingGrid(LABEL_CROWDING_PX, DEPTH_GUARD_RATIO, DEPTH_GUARD_EXIT_RATIO);
  private readonly iconCrowding = new CrowdingGrid(ICON_CROWDING_PX, DEPTH_GUARD_RATIO, DEPTH_GUARD_EXIT_RATIO);
  private shownIdsScratch: string[] = [];
  private readonly nowShownScratch = new Set<string>();
  private readonly activeCelestialLabels: ActiveCelestialLabel[] = [];
  private readonly subLabels: CelestialSubLabels;

  get shownLabelCount(): number { return this.shownLabels.length; }
  get activeLabels(): readonly ActiveCelestialLabel[] { return this.activeCelestialLabels; }

  // update が座標を求めた天体・ラグランジュ点マーカー。
  get bodyPickables(): readonly MapPickable[] { return this.bodyPickableItems; }

  // 星系の全天体とラグランジュ点からラベルの全集合を1度だけ組む。ラグランジュ点は5点まとめてでは
  // なく、共線点・三角点それぞれの成立条件を満たす点だけを持たせる。
  constructor(private readonly markerManager: MarkerManager, private readonly celestialSystem: CelestialSystem) {
    this.subLabels = new CelestialSubLabels(markerManager, celestialSystem);
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

    // 親の直後にその子とラグランジュ点が続く並び。深さは星系が持つものをそのまま使う。
    const markersOf = new Map(this.lagrangeSources.map((s) => [s.markers[0]!.parentId, s.markers]));
    const labels: CelestialLabel[] = [];
    for (const { entity, depth } of celestialSystem.orderedEntities) {
      labels.push({ item: entity, depth, pos: v3(0, 0, 0), showIcon: false, showLabel: false, pickable: true });
      for (const marker of markersOf.get(entity.id) ?? []) {
        labels.push({
          item: marker, depth: depth + 1, pos: v3(0, 0, 0),
          showIcon: false, showLabel: false, pickable: true,
        });
      }
    }
    this.labels = labels;
    this.allItems = labels.map((label) => label.item);
    for (const label of labels) this.labelsById.set(label.item.id, label);
  }

  // 表示時刻 t の各ラベル座標を求め直す。表示対象の外にある天体は座標計算ごと飛ばす —
  // 登録天体が増えるほどラグランジュ点の解決(1天体あたり位置2回 + 回転系1回)が効くため。
  // visibilityPolicy は同じフレームの update 位相で確定させた表示ポリシーを渡す。マーカー・
  // 選択候補・参照線が同じインスタンスを読むことで、個別実装の解釈ずれをなくす。
  update(t: number, toggles: MapDisplayToggles, visibilityPolicy: MapVisibilityPolicy): void {
    const celestialBodies = this.celestialSystem.celestialMotions;
    const positions = new Map<string, Vec3>();
    const display = new Map<string, { icon: boolean; label: boolean }>();
    this.bodyPickableItems.length = 0;

    // 登録天体。
    for (const body of this.celestialSystem.entities) {
      const visibility = visibilityPolicy.body(body.id);
      if (!visibility.pickable) continue;
      const pos = body.stateAt(t).r;
      positions.set(body.id, pos);
      display.set(body.id, { icon: visibility.icon, label: visibility.label });
      this.bodyPickableItems.push(body);
    }
    // ラグランジュ点。回転系が組めない期間は座標を失うので、place(null) で位置を降ろす。
    if (toggles.lagrangeVisible && toggles.lagrangeName) {
      for (const { motion, markers } of this.lagrangeSources) {
        if (!visibilityPolicy.body(markers[0]!.parentId).category) continue;
        const frame = secondaryFrameOf(celestialBodies, t, motion, t);
        if (frame === null) { for (const marker of markers) marker.place(null); continue; }
        const solved = lagrangePointsOf(frame);
        for (const marker of markers) {
          const visibility = visibilityPolicy.body(marker.id);
          const pos = solved[`L${marker.point}`];
          marker.place(pos);
          if (!visibility.pickable) continue;
          positions.set(marker.id, pos);
          display.set(marker.id, { icon: visibility.icon, label: visibility.label });
          this.bodyPickableItems.push(marker);
        }
      }
    }

    // 求まった座標をラベルへ写し、sync 位相が読む一覧を差し替える。
    const shown: CelestialLabel[] = [];
    for (const label of this.labels) {
      const pos = positions.get(label.item.id);
      if (pos === undefined) continue;
      label.pos = pos;
      const d = display.get(label.item.id)!;
      label.showIcon = d.icon;
      label.showLabel = d.label;
      shown.push(label);
    }
    this.shownLabels = shown;
    this.celestialBodiesPivot = t;
  }

  // update が求めた座標へラベルのマーカーを置く。天体に遮られているラベルは隠し、
  // 画面上で近接するラベルは、カメラからの距離が著しく離れていれば遠い方、
  // 同程度の距離なら優先度の低い方を隠す。
  syncLabels(project: ProjectFn, cameraPos: Vec3): void {
    this.projectLabels(project, cameraPos);
    const hiddenLabels = this.labelCrowding.compute(this.projectedForLabel);
    const hiddenIcons = this.iconCrowding.compute(this.projectedForIcon);

    const shownIds = this.shownIdsScratch;
    shownIds.length = 0;
    this.activeCelestialLabels.length = 0;
    for (const label of this.shownLabels) {
      shownIds.push(label.item.id);
      this.placeLabel(label, hiddenLabels, hiddenIcons, project, cameraPos);
    }
    this.hideLabelsLeftBehind(shownIds);
  }

  // 全ラベルを投影し、遮蔽されず画面手前にあるものを混雑判定の対象として積む。
  private projectLabels(project: ProjectFn, cameraPos: Vec3): void {
    this.frameScratch.clear();
    this.distScratch.clear();
    this.projectedForLabel.length = 0;
    this.projectedForIcon.length = 0;
    for (const label of this.shownLabels) {
      const opacity = occlusionOpacity(
        cameraPos, label.pos, this.celestialSystem.celestialMotions, this.celestialBodiesPivot);
      const occluded = opacity <= 0;
      const p = project(label.pos);
      this.frameScratch.set(label.item.id, { occluded, opacity, x: p.x, y: p.y, front: p.front });
      if (occluded || !p.front) continue;
      const dist = len(sub(label.pos, cameraPos));
      this.distScratch.set(label.item.id, dist);
      const entry: ProjectedLabel = {
        id: label.item.id, priority: label.item.labelPriority, depth: label.depth, x: p.x, y: p.y, dist,
      };
      if (label.showLabel) this.projectedForLabel.push(entry);
      if (label.showIcon) this.projectedForIcon.push(entry);
    }
  }

  // ラベル1件を、間引きの結果に従ってマーカーへ置く(消えた対象は隠して掴めなくする)。
  private placeLabel(
    label: CelestialLabel, hiddenLabels: ReadonlySet<string>, hiddenIcons: ReadonlySet<string>,
    project: ProjectFn, cameraPos: Vec3,
  ): void {
    const id = label.item.id;
    const projected = this.frameScratch.get(id);
    if (projected === undefined || projected.occluded) {
      label.pickable = false;
      if (projected?.occluded) this.markerManager.fadeOut(id);
      else this.markerManager.hide(id);
      return;
    }
    // 名前とアイコンは別々の混雑半径で間引く。どちらも残らなければマーカーごと畳む。
    const labelVisible = label.showLabel && !hiddenLabels.has(id);
    const iconVisible = label.showIcon && !hiddenIcons.has(id);
    if (!labelVisible && !iconVisible) {
      label.pickable = false;
      this.markerManager.hide(id);
      return;
    }
    label.pickable = true;
    // 他のマーカー集合はこの一覧を読んで、天体ラベルとの近接を測る。
    if (projected.front) {
      this.activeCelestialLabels.push({
        id, x: projected.x, y: projected.y, priority: label.item.labelPriority,
        dist: this.distScratch.get(id)!, iconVisible, labelVisible,
      });
    }
    this.markerManager.setPosition(
      id, label.item.markerClass, iconVisible ? label.item.mapGlyph : '', label.pos, project,
      labelVisible ? label.item.markerLabel : '',
      projected.opacity, undefined, undefined, false, false, label.item.labelPriority, cameraPos,
    );
  }

  // 前のフレームまで出していて、今フレームは表示対象から外れたラベルを畳む。
  private hideLabelsLeftBehind(shownIds: string[]): void {
    const nowShown = this.nowShownScratch;
    nowShown.clear();
    for (const id of shownIds) nowShown.add(id);
    for (const id of this.prevShownIds) if (!nowShown.has(id)) this.markerManager.hide(id);
    const previous = this.prevShownIds as string[];
    this.prevShownIds = shownIds;
    this.shownIdsScratch = previous;
    this.shownIdsScratch.length = 0;
  }

  // 混雑で画面から消えた船・敵機・基地を、天体ラベルの下のサブ行として描き足す。
  syncSubLabels(
    groupedMarkers: GroupedMarkers, celestialBodies: readonly CelestialMotion[], pivot: number,
    overviewMode: boolean, project: ProjectFn, cameraPos: Vec3,
  ): void {
    if (!overviewMode) return;
    this.subLabels.sync(
      groupedMarkers, (id) => this.labelStateOf(id), celestialBodies, pivot, project, cameraPos);
  }

  // サブ行を足すために要る、今フレームの1件ぶんの表示状態。ラベルを持たない id には null。
  private labelStateOf(id: string): CelestialLabelState | null {
    const label = this.labelsById.get(id);
    if (label === undefined) return null;
    const projected = this.frameScratch.get(id);
    return {
      pos: label.pos,
      shown: label.pickable,
      labelShown: label.showLabel,
      markerClass: label.item.markerClass,
      markerLabel: label.item.markerLabel,
      glyph: label.showIcon ? label.item.mapGlyph : '',
      priority: label.item.labelPriority,
      opacity: projected?.opacity ?? 1,
      drawable: projected !== undefined && projected.front && !projected.occluded,
    };
  }

  // マップモードを抜けたときの後始末(戦闘ビューには天体ラベルを出さない)。
  hideLabels(): void {
    this.activeCelestialLabels.length = 0;
    for (const label of this.labels) this.markerManager.hide(label.item.id);
  }
}
