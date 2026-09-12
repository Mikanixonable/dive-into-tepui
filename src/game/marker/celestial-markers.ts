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
import type { CelestialBody } from '../../physics/celestial-body';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { MapDisplayToggles } from '../map/display-toggles';
import type { ObjectPickable } from '../pickable/object-pickable';
import type { MapVisibilityPolicy } from '../map/visibility-policy';
import type { ProjectFn } from '../../math/projection';
import type { GroupedMarkers } from './grouped-markers';
import type { MarkerSlots } from './marker-slots';

// 名前の混雑判定の半径 [px]。これより近い名前どうしは、優先度の低いほうを隠す。
const LABEL_CROWDING_PX = 40;

// アイコンの混雑判定の半径 [px]。名前より小さくして、名前だけが消える距離帯を作る。
const ICON_CROWDING_PX = 16;

// ラベル集合の1件ぶんに要る性質。
interface CelestialMarkerItem {
  readonly id: string;
  // マップのマーカーへ描く表記。
  readonly markerLabel: string;
  // アイコンの字形。
  readonly glyph: string;
  readonly markerClass: string;
  // ラベルが混雑したときに優先して残す度合い。大きいほど残る。
  readonly labelPriority: number;
  // 表示時刻の ECI 位置。求まらないフレームは null。
  posAt(displayTime: number): Vec3 | null;
}

// 今フレームに描いた天体ラベル1件ぶんの、画面上の位置と表示状態。
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

// ラベル1件の投影結果(画面座標と遮蔽の具合)。
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
  // 天体とラグランジュ点の全ラベル。親を先にした階層順で並ぶ。
  private readonly labels: readonly CelestialLabel[];
  // labels と同じ並びの対象そのもの。
  readonly allItems: readonly CelestialMarkerItem[];
  private readonly labelsById = new Map<string, CelestialLabel>();
  // このフレームで表示する対象に絞ったラベル。
  private shownLabels: readonly CelestialLabel[] = [];
  // 直前のフレームに表示していたラベル id(集合から外れたものを隠すため)。
  private prevShownIds: readonly string[] = [];

  // このフレームの選択候補に出す天体とラグランジュ点マーカー(表示ポリシーを通ったもの)。
  private readonly bodyPickableItems: ObjectPickable[] = [];
  private readonly frameScratch = new Map<string, LabelProjection>();
  private readonly distScratch = new Map<string, number>();
  private readonly projectedForLabel: ProjectedLabel[] = [];
  private readonly projectedForIcon: ProjectedLabel[] = [];
  private readonly labelCrowding = new CrowdingGrid(LABEL_CROWDING_PX, DEPTH_GUARD_RATIO, DEPTH_GUARD_EXIT_RATIO);
  private readonly iconCrowding = new CrowdingGrid(ICON_CROWDING_PX, DEPTH_GUARD_RATIO, DEPTH_GUARD_EXIT_RATIO);
  private shownIdsScratch: string[] = [];
  private readonly nowShownScratch = new Set<string>();
  private readonly activeCelestialLabels: ActiveCelestialLabel[] = [];
  private readonly subLabels: CelestialSubLabels;

  get shownLabelCount(): number { return this.shownLabels.length; }
  get activeLabels(): readonly ActiveCelestialLabel[] { return this.activeCelestialLabels; }

  get bodyPickables(): readonly ObjectPickable[] { return this.bodyPickableItems; }

  // 星系の全天体とラグランジュ点からラベルの全集合を組む。ラグランジュ点は、共線点・三角点
  // それぞれの成立条件を満たす点だけを持つ。
  constructor(private readonly markers: MarkerSlots, private readonly celestialSystem: CelestialSystem) {
    this.subLabels = new CelestialSubLabels(markers, celestialSystem);
    this.lagrangeSources = celestialSystem.entities.flatMap((body) => {
      const motion = body.motion;
      // 全公転天体で出すと点の数が天体数の数倍になり、ラベルが画面を埋める。
      if (!(motion instanceof OrbitingMotion) || motion.def.lagrangeLabels !== true) return [];
      const points = [
        ...(motion.hasUsableCollinearPoints(LAGRANGE_MIN_CLEARANCE_RATIO) ? [1, 2, 3] as const : []),
        ...(motion.hasStableTriangularPoints() ? [4, 5] as const : []),
      ];
      const markers = points.map((n) => new LagrangePointMarker(body.id, body.name, n));
      return markers.length === 0 ? [] : [{ motion, markers }];
    });

    // 親の直後にその子とラグランジュ点が続く並び。
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

  // 表示時刻 t のラグランジュ点を解き直し、選択候補に出す天体とマーカーを絞り込む。
  // visibilityPolicy には、同じフレームで確定した表示ポリシーを渡す。
  update(t: number, toggles: MapDisplayToggles, visibilityPolicy: MapVisibilityPolicy): void {
    const celestialBodies = this.celestialSystem.celestialMotions;
    this.bodyPickableItems.length = 0;

    // 登録天体。
    for (const body of this.celestialSystem.entities) {
      if (!visibilityPolicy.body(body.id).pickable) continue;
      this.bodyPickableItems.push(body);
    }
    // ラグランジュ点。回転系が組めない期間は座標を失う。
    if (toggles.lagrangeVisible && toggles.lagrangeName) {
      for (const { motion, markers } of this.lagrangeSources) {
        if (!visibilityPolicy.body(markers[0]!.parentId).category) continue;
        const frame = secondaryFrameOf(celestialBodies, t, motion, t);
        if (frame === null) { for (const marker of markers) marker.place(null); continue; }
        const solved = lagrangePointsOf(frame);
        for (const marker of markers) {
          marker.place(solved[`L${marker.point}`]);
          if (!visibilityPolicy.body(marker.id).pickable) continue;
          this.bodyPickableItems.push(marker);
        }
      }
    }
  }

  // 表示時刻の座標へラベルのマーカーを置く。天体に遮られているラベルは隠し、
  // 画面上で近接するラベルは、カメラからの距離が著しく離れていれば遠い方、
  // 同程度の距離なら優先度の低い方を隠す。
  syncLabels(
    project: ProjectFn, cameraPos: Vec3, displayTime: number, visibilityPolicy: MapVisibilityPolicy,
  ): void {
    this.refreshShownLabels(displayTime, visibilityPolicy);
    this.projectLabels(project, cameraPos, displayTime);
    // 名前とアイコンは混雑半径が違うので、間引きも別々に判定する。
    const hiddenLabels = this.labelCrowding.compute(this.projectedForLabel);
    const hiddenIcons = this.iconCrowding.compute(this.projectedForIcon);

    // 判定に従って1件ずつ置き、集合から外れたものを畳む。
    const shownIds = this.shownIdsScratch;
    shownIds.length = 0;
    this.activeCelestialLabels.length = 0;
    for (const label of this.shownLabels) {
      shownIds.push(label.item.id);
      this.placeLabel(label, hiddenLabels, hiddenIcons, project, cameraPos);
    }
    this.hideLabelsLeftBehind(shownIds);
  }

  // 選択候補に残った対象の表示座標と表示可否を書き、このフレームに描くラベルを絞り込む。
  // 並びは階層順(親が先)を保つ — 混雑判定の同点は先に来たほうが残る。
  private refreshShownLabels(displayTime: number, visibilityPolicy: MapVisibilityPolicy): void {
    const pickableIds = new Set(this.bodyPickableItems.map((item) => item.id));
    const shown: CelestialLabel[] = [];
    for (const label of this.labels) {
      if (!pickableIds.has(label.item.id)) continue;
      const pos = label.item.posAt(displayTime);
      if (pos === null) continue;
      const visibility = visibilityPolicy.body(label.item.id);
      label.pos = pos;
      label.showIcon = visibility.icon;
      label.showLabel = visibility.label;
      shown.push(label);
    }
    this.shownLabels = shown;
  }

  // 全ラベルを投影し、遮蔽されず画面手前にあるものを混雑判定の対象として積む。
  private projectLabels(project: ProjectFn, cameraPos: Vec3, displayTime: number): void {
    this.frameScratch.clear();
    this.distScratch.clear();
    this.projectedForLabel.length = 0;
    this.projectedForIcon.length = 0;
    for (const label of this.shownLabels) {
      const opacity = occlusionOpacity(
        cameraPos, label.pos, this.celestialSystem.celestialMotions, displayTime);
      const occluded = opacity <= 0;
      const p = project(label.pos);
      this.frameScratch.set(label.item.id, { occluded, opacity, x: p.x, y: p.y, front: p.front });
      // 混雑判定に加わるのは、遮蔽されず画面手前にあるものまで。
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
      if (projected?.occluded) this.markers.fadeOut(id);
      else this.markers.hide(id);
      return;
    }
    // 名前とアイコンのどちらも残らなければ、マーカーごと畳む。
    const labelVisible = label.showLabel && !hiddenLabels.has(id);
    const iconVisible = label.showIcon && !hiddenIcons.has(id);
    if (!labelVisible && !iconVisible) {
      label.pickable = false;
      this.markers.hide(id);
      return;
    }
    label.pickable = true;
    if (projected.front) {
      this.activeCelestialLabels.push({
        id, x: projected.x, y: projected.y, priority: label.item.labelPriority,
        dist: this.distScratch.get(id)!, iconVisible, labelVisible,
      });
    }
    this.markers.setPosition(
      id, label.item.markerClass, iconVisible ? label.item.glyph : '', label.pos, project,
      labelVisible ? label.item.markerLabel : '',
      projected.opacity, undefined, undefined, false, false, label.item.labelPriority, cameraPos,
    );
  }

  // 前のフレームまで出していて、今フレームは表示対象から外れたラベルを畳む。
  private hideLabelsLeftBehind(shownIds: string[]): void {
    const nowShown = this.nowShownScratch;
    nowShown.clear();
    for (const id of shownIds) nowShown.add(id);
    for (const id of this.prevShownIds) if (!nowShown.has(id)) this.markers.hide(id);
    const previous = this.prevShownIds as string[];
    this.prevShownIds = shownIds;
    this.shownIdsScratch = previous;
    this.shownIdsScratch.length = 0;
  }

  // 混雑で画面から消えた船・敵機・基地を、天体ラベルの下のサブ行として描き足す。
  syncSubLabels(
    groupedMarkers: GroupedMarkers, celestialBodies: readonly CelestialBody[], pivot: number,
    project: ProjectFn, cameraPos: Vec3,
  ): void {
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
      glyph: label.showIcon ? label.item.glyph : '',
      priority: label.item.labelPriority,
      opacity: projected?.opacity ?? 1,
      drawable: projected !== undefined && projected.front && !projected.occluded,
    };
  }

  // 出している天体ラベルをすべて畳む。
  hideLabels(): void {
    this.activeCelestialLabels.length = 0;
    for (const label of this.labels) this.markers.hide(label.item.id);
  }
}
