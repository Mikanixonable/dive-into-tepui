// 操作対象の軌道計画の姿の表示(両ビュー常駐)。どの計画をいつ描くかを決め、計画折れ線
// (PlanPath)を駆動して、表示時刻の計画上の自機位置ゴースト(⬢ plannedPlayer マーカー)を置く。
import * as THREE from 'three/webgpu';
import type { View } from '../view/view';
import { Vec3, len, sub } from '../../math/vec3';
import { strongestAttractor } from '../../physics/attractor';
import type { FrameAnchorSource } from '../../physics/frame';
import { isOccluded } from '../../physics/occlusion';
import { Projected } from '../../math/projection';
import { fmtMarkerDist } from '../../hud/utils';
import { TickRank, TimeLabelSetting, calendarBoundaries, tickLabel } from '../hud/orbit/calendar-ticks';
import { ApsisMarker } from '../marker/apsis-marker';
import type { DisplayedPath } from '../marker/equator-node-marker-pair';
import { MarkerSlots } from '../marker/marker-slots';
import { ENTITY_GLYPH, ORBIT_POINT_GLYPH } from '../marker/marker-identity';
import { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../camera/floating-origin';
import { ObjectPickable } from '../pickable/object-pickable';
import { DisplayDurationSource, PlanData } from './plan';
import { PlanPath } from './plan-path';
import { DisplayWindow, timeLabelSettingOf } from '../display-window-manager';
import type { CelestialBody } from '../../physics/celestial-body';
import type { KinematicState } from '../../physics/kinematic-state';
import type { Controllable } from '../dynamic/dynamic-entity/controllable';
import type { ControlSelection } from '../control-selection';
import type { PredictedArc } from '../dynamic/predicted-arc';
import type { PerfCounts } from '../perf-counts';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { ProjectFn } from '../../math/projection';

// 近地点・遠地点アイコンを出す離心率相当値の下限。両方見つかったときの
// (遠地点距離-近地点距離)/(遠地点距離+近地点距離) と比較し、これ未満は円に近く
// アプシスの方向が不定なので両方隠す。
const APSIS_MIN_ECC = 0.01;

// 計画軌道上の暦目盛の間隔・本数を決める値。
const PLAN_TICK_MIN_PX = 40; // 目盛同士の最小画面間隔 [px]
const PLAN_TICK_LABEL_MIN_PX = 90; // ラベルを付ける最小画面間隔 [px]
const PLAN_TICK_MAX_COUNT = 400; // 日・月・年階級の目盛候補の上限本数

// 時階級(1/3/6/12時間ごと)の目盛候補の上限本数。時階級の刻みは互いに包含関係にあるので、
// この上限に収まる限り常に最も細かい1時間ごとで列挙し、出す粒度は画面距離での間引きに委ねる
// — 区間の長さだけで階級が丸ごと切り替わると、ズームに対して連続に見えなくなる。
// 既定の最長表示区間(28日)の1時間ごとが丸ごと落ちない本数を取る。
const PLAN_TICK_HOUR_FAMILY_MAX_COUNT = 1200;

// 目盛点の半径 [px]。表示中の最細目盛からの相対階層(0/1/2以上)で引く。
const PLAN_TICK_RADIUS_PX = [1.5, 2.5, 3.5] as const;

// ✕ 衝突マーカー(区間ごとに高々1つ)
interface ImpactIcon {
  readonly key: string;
  readonly pos: Vec3;
  readonly label: string;
}

// ルーラー目盛マーカー。
interface PlanTickIcon {
  readonly key: string;
  readonly pos: Vec3;
  readonly rank: TickRank;
  readonly label: string;
}

// 衝突マーカーのキー(区間ごとに1つ)。
const IMPACT_MARKER_KEYS = ['planImpact0', 'planImpact1', 'planImpact2'] as const;

// 半径 radius [px] の点目盛の SVG。投影点を中心に置く前提。
function tickSvg(radius: number): string {
  const size = radius * 2;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`
    + `<circle cx="${radius}" cy="${radius}" r="${radius}" fill="currentColor"/></svg>`;
}

// 2点間のスクリーン距離の2乗。
function screenDistSq(a: Projected, b: Projected): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export class PlanDisplay {
  readonly path: PlanPath;

  private readonly apsisPe = new ApsisMarker('pe');
  private readonly apsisAp = new ApsisMarker('ap');
  private lastTickKeys: readonly string[] = [];
  // このフレームに描く計画の材料。描く計画が無ければ null。
  private displayedPlan: PlanData | null = null;

  // 計画折れ線(PlanPath)を構築する。
  constructor(
    scene: THREE.Scene,
    private readonly markers: MarkerSlots,
    private readonly celestialBodies: CelestialBodies,
    displayDuration: DisplayDurationSource,
    private readonly controlSelection: ControlSelection,
  ) {
    this.path = new PlanPath(scene, displayDuration);
  }

  // 計画折れ線を再積分し、アプシスアイコンを求め直す。
  // 折れ線は戦闘ビューでも描く — 計画どおりに機体を動かすのは戦闘ビューだから。
  update(displayWindow: DisplayWindow, frameAnchors: FrameAnchorSource, view: View): void {
    const ship = this.controlSelection.current;
    this.displayedPlan = this.planToDisplay(ship, view);
    if (this.displayedPlan === null) this.clearDisplay();
    else this.updateDisplay(this.displayedPlan, displayWindow, ship, frameAnchors);
  }

  // owner の計画折れ線がこのフレームに出ていれば、その座標系とサンプル列。出ていなければ null。
  displayedPathOf(ownerId: string): DisplayedPath | null {
    if (this.displayedPlan === null || this.controlSelection.current?.id !== ownerId) return null;
    const samples = this.path.displayedSamples();
    return samples.length === 0 ? null : { frame: this.path.displayFrame, samples };
  }

  // 計画折れ線・ゴーストマーカー・アプシスアイコン・目盛を、焼かれた折れ線から組んで置く。
  sync(cameraSystem: CameraSystem, fo: FloatingOrigin, displayWindow: DisplayWindow): void {
    if (this.displayedPlan === null) { this.hide(); return; }
    const project = cameraSystem.activeCameraProjection;
    const view = cameraSystem.view;
    const cameraPos = cameraSystem.activeCameraPos;
    const { simTime, displayTime } = displayWindow;
    const timeLabel = timeLabelSettingOf(displayWindow);
    this.path.sync(
      fo, project, cameraSystem.activeCameraScale, cameraPos, cameraSystem.activeCamera,
    );
    this.syncGhost(project, view, cameraPos, displayTime, simTime);
    this.syncApsisMarkers(project, view, cameraPos, displayTime, timeLabel);
    this.syncImpactMarkers(project, view, cameraPos, displayTime);
    this.syncTickMarkers(project, view, cameraPos, displayTime, timeLabel);
  }

  // このフレームに表示している計画区間の弧。表示している計画が無ければ空。
  growableArcs(): readonly PredictedArc[] {
    return this.displayedPlan === null ? [] : this.path.growableArcs();
  }

  // 直近のフレームで作り直した計画区間の本数。
  perfCounts(): Pick<PerfCounts, 'planArcs'> {
    return { planArcs: this.path.lastRebuiltArcs };
  }

  // 計画折れ線を片付ける。
  dispose(): void {
    this.path.dispose();
  }

  // このフレームに出す折れ線の材料。出す価値のある折れ線が無ければ null — ノードの無い計画は
  // 操作対象の現在軌道そのものなので、ノードを置ける編集中(マップビュー)だけ出す。
  private planToDisplay(ship: Controllable | null, view: View): PlanData | null {
    if (ship === null) return null;
    if (view !== 'map' && ship.plan.nodes.length === 0) return null;
    return ship.plan.displayData(ship.motion.state);
  }

  // 折れ線を再積分し、近地点・遠地点アイコンを求め直す。ship はノードの無い区間を
  // 操作対象の予測列として引くために渡す。
  private updateDisplay(
    planData: PlanData, displayWindow: DisplayWindow, ship: Controllable | null,
    frameAnchors: FrameAnchorSource,
  ): void {
    const { simTime, displayTime } = displayWindow;
    this.path.update(
      planData, ship, this.celestialBodies, displayWindow.frame, simTime, displayTime, frameAnchors,
      displayWindow.duration,
    );
    this.placeApsisMarkers(ship?.name ?? null);
  }

  // 折れ線を畳み、近地点・遠地点アイコンを出す理由が無くなった状態にする。
  private clearDisplay(): void {
    this.path.clear();
    this.apsisPe.retire();
    this.apsisAp.retire();
  }

  // 計画に属する表示物をすべて畳む。
  private hide(): void {
    this.path.setVisible(false);
    this.markers.hide('plannedPlayer');
    this.markers.hide(this.apsisPe.id);
    this.markers.hide(this.apsisAp.id);
    for (const key of IMPACT_MARKER_KEYS) this.markers.hide(key);
    for (const key of this.lastTickKeys) this.markers.remove(key);
    this.lastTickKeys = [];
  }

  // 近地点・遠地点アイコンの右クリック候補(このフレームに求まったものだけ)。
  get apsisMarkers(): readonly ObjectPickable[] {
    return [this.apsisPe, this.apsisAp].filter((marker) => !marker.gone);
  }

  // displayTime における計画上の自機位置とそのラベル。折れ線の届く範囲外、または
  // ノードが1つも無ければ null — ノード無しの計画は実軌道の追従コピーでしかなく、
  // 実軌道とのズレを示すゴーストとしては意味を持たない。
  private ghostAt(displayTime: number, simTime: number): { pos: Vec3; label: string } | null {
    if (this.path.nodeCount === 0) return null;
    const sample = this.path.sampleAt(displayTime);
    if (!sample) return null;
    return {
      pos: this.path.toDisplay(sample.r, displayTime),
      label: this.plannedPlayerLabel(displayTime, simTime, sample.r),
    };
  }

  // ⬢ ゴーストマーカーを計画位置に置く。計画がそこまで届いていなければ隠す。
  private syncGhost(
    project: ProjectFn, view: View, cameraPos: Vec3, displayTime: number, simTime: number,
  ): void {
    const ghost = this.ghostAt(displayTime, simTime);
    if (!ghost) {
      this.markers.hide('plannedPlayer');
      return;
    }
    if (view === 'map' && this.occludedByCelestialBody(cameraPos, ghost.pos, displayTime)) {
      this.markers.fadeOut('plannedPlayer');
      return;
    }
    this.markers.setPosition(
      'plannedPlayer', 'mk-planned', ENTITY_GLYPH.ghost, ghost.pos, project, ghost.label,
      1, undefined, undefined, false, false, undefined, cameraPos,
    );
  }

  // pos が displayTime 時点の天体に隠れているか。
  private occludedByCelestialBody(cameraPos: Vec3, pos: Vec3, displayTime: number): boolean {
    return isOccluded(cameraPos, pos, this.celestialBodies.celestialMotions, displayTime);
  }

  // ゴーストマーカーのラベル文字列(経過時間+高度)を組み立てる。現在時刻のゴーストは
  // 計画どおりに飛べていれば自機に重なるので、経過時間を添えず高度だけを出す。
  // 高度はその位置で最も強く引く天体の表面からの高さ。
  private plannedPlayerLabel(displayTime: number, simTime: number, r: Vec3): string {
    const tRel = displayTime - simTime;
    const center = strongestAttractor(r, this.celestialBodies.celestialMotions, displayTime);
    const alt = len(sub(r, center.positionAt(displayTime))) - center.def.radius;
    if (tRel <= 0) return `計画位置 高度 ${fmtMarkerDist(alt, 0)}`;
    const h = Math.floor(tRel / 3600);
    const m = Math.floor((tRel % 3600) / 60);
    return `T+${h}h${String(m).padStart(2, '0')}m 高度 ${fmtMarkerDist(alt, 0)}`;
  }

  // 最後のバーン後の軌道(これから乗る軌道)の近地点・遠地点アイコンを、末尾区間の極値へ置く。
  // 衝突コースの区間では近地点に達する前に地表へ達するので、近地点が求まらないのは正常。
  // 両方揃っているときは、ほぼ円(APSIS_MIN_ECC 未満)かを見て、そうなら両方隠す。
  private placeApsisMarkers(ownerName: string | null): void {
    const final = this.path.finalSegment();
    if (!final) { this.clearApsisMarkers(); return; }
    const pe = final.periapsis;
    const ap = final.apoapsis;

    // 中心天体は極値ごとに検出時と同じものを使い、その位置だけを極値の時刻で引き直す —
    // 距離を測る基準が検出時と食い違わないようにするため。
    const peCenter = final.periapsisCenter;
    const apCenter = final.apoapsisCenter;
    let peDist = 0;
    if (pe && peCenter) {
      peDist = len(sub(pe.r, this.celestialBodies.stateAt(peCenter.id, pe.t).r));
    }
    let apDist = 0;
    if (ap && apCenter) {
      apDist = len(sub(ap.r, this.celestialBodies.stateAt(apCenter.id, ap.t).r));
    }
    // 円かどうかは、近地点と遠地点が同じ中心天体から測られているときだけ判定できる。
    if (pe && ap && peCenter && apCenter && peCenter.id === apCenter.id
      && (apDist - peDist) / (apDist + peDist) < APSIS_MIN_ECC) { this.clearApsisMarkers(); return; }

    const namePrefix = ownerName ? (this.path.nodeCount > 0 ? `${ownerName} (計画)` : ownerName) : null;
    this.placeApsisMarker(this.apsisPe, pe, peCenter, namePrefix);
    this.placeApsisMarker(this.apsisAp, ap, apCenter, namePrefix);
  }

  // 極値とその中心天体が揃っていれば、折れ線と同じ座標系へ写した位置を記録する。
  private placeApsisMarker(
    marker: ApsisMarker, apsis: KinematicState | null, center: CelestialBody | null, ownerName: string | null,
  ): void {
    if (!apsis || !center) {
      marker.place(null, null, null, null);
      return;
    }
    marker.place(this.path.toDisplay(apsis.r, apsis.t), apsis.t, center.id, ownerName);
  }

  // 近地点・遠地点アイコンを、このフレームは求まらなかった状態にする。
  private clearApsisMarkers(): void {
    this.placeApsisMarker(this.apsisPe, null, null, null);
    this.placeApsisMarker(this.apsisAp, null, null, null);
  }

  // 天体衝突が検出された地点(区間ごとに高々1つ)。衝突天体は判定を返した積分弧のものを
  // そのまま使う — ここで引き直すと、判定に使った天体と食い違う名前が出かねない。
  private impactIconsOf(): readonly ImpactIcon[] {
    return this.path.impactPoints().flatMap(({ state, body, arcIdx }) => {
      const key = IMPACT_MARKER_KEYS[arcIdx];
      if (key === undefined) return [];
      return [{ key, pos: this.path.toDisplay(state.r, state.t), label: `衝突 ${this.celestialBodies.nameOf(body.id)}` }];
    });
  }

  // 表示中の折れ線が暦の区切り(時・日・月・年)を跨ぐ地点の目盛候補。ラベルは timeLabel の
  // mode に応じて UTC カレンダーか経過時間で書き、置く位置はどちらでも暦の区切りのまま。
  private tickIconsOf(timeLabel: TimeLabelSetting): readonly PlanTickIcon[] {
    const range = this.path.timeRange();
    if (!range) return [];
    const epochUnix = timeLabel.epochUnixSec;
    const boundaries = calendarBoundaries(
      epochUnix + range.min, epochUnix + range.max,
      PLAN_TICK_MAX_COUNT, PLAN_TICK_HOUR_FAMILY_MAX_COUNT,
    );
    // 折れ線がその時刻まで届いている区切りだけを候補にする。
    const icons: PlanTickIcon[] = [];
    for (const b of boundaries) {
      const t = b.unix - epochUnix;
      const state = this.path.sampleAt(t);
      if (!state) continue;
      icons.push({
        key: `planTick:${b.unix}`,
        pos: this.path.toDisplay(state.r, t),
        rank: b.rank,
        label: tickLabel(b.unix, b.rank, timeLabel.mode, epochUnix + timeLabel.nowSimTime),
      });
    }
    return icons;
  }

  // 近地点・遠地点のマーカーを、それぞれが解いた位置へ置く。
  private syncApsisMarkers(
    project: ProjectFn, view: View, cameraPos: Vec3, displayTime: number, timeLabel: TimeLabelSetting,
  ): void {
    const celestialBodies = this.celestialBodies.celestialMotions;
    for (const marker of [this.apsisPe, this.apsisAp]) {
      marker.sync(
        this.markers, project, cameraPos, celestialBodies, displayTime, view === 'map', timeLabel,
      );
    }
  }

  // ✕ 衝突マーカーを、折れ線が返した衝突地点に置き、出ていないものを隠す。
  private syncImpactMarkers(
    project: ProjectFn, view: View, cameraPos: Vec3, displayTime: number,
  ): void {
    const impactIcons = this.impactIconsOf();
    for (const key of IMPACT_MARKER_KEYS) {
      const icon = impactIcons.find((m) => m.key === key);
      if (!icon) {
        this.markers.hide(key);
      } else if (view === 'map' && this.occludedByCelestialBody(cameraPos, icon.pos, displayTime)) {
        this.markers.fadeOut(key);
      } else {
        this.markers.setPosition(
          key, 'mk-impact', ORBIT_POINT_GLYPH.impact, icon.pos, project, icon.label,
          1, undefined, undefined, false, false, undefined, cameraPos,
        );
      }
    }
  }

  // 暦の区切りの目盛候補を画面距離で間引いて置く。粗い階数(月・年)から順に採否を決め、
  // 採用済みの目盛から PLAN_TICK_MIN_PX 未満しか離れない候補は捨てる — 離心軌道では候補の
  // 画面間隔が場所で桁違いになるので、区間全体で単位を揃えずこの局所判定に任せる。
  private syncTickMarkers(
    project: ProjectFn, view: View, cameraPos: Vec3, displayTime: number, timeLabel: TimeLabelSetting,
  ): void {
    const icons = this.tickIconsOf(timeLabel);
    const n = icons.length;
    const projected = icons.map((icon) => project(icon.pos));
    const shown = new Array<boolean>(n).fill(false);

    const ranksDesc = [...new Set(icons.map((icon) => icon.rank))].sort((a, b) => b - a);
    const minPxSq = PLAN_TICK_MIN_PX ** 2;
    for (const rank of ranksDesc) {
      for (let i = 0; i < n; i++) {
        if (icons[i]!.rank !== rank || !projected[i]!.front
          || (view === 'map' && this.occludedByCelestialBody(cameraPos, icons[i]!.pos, displayTime))) continue;
        if (this.isFarFromShown(projected, shown, i, minPxSq)) shown[i] = true;
      }
    }

    // 大きさは、採用された中で最も細かい階数からの相対的な深さで決める — 単位が切り替わっても
    // 目盛の平均的な大きさは変わらず、切り替わり地点だけが違いとして目に付く。
    let finestShown: TickRank | null = null;
    for (let i = 0; i < n; i++) {
      if (shown[i] && (finestShown === null || icons[i]!.rank < finestShown)) finestShown = icons[i]!.rank;
    }
    const labelMinPxSq = PLAN_TICK_LABEL_MIN_PX ** 2;
    const maxDepth = PLAN_TICK_RADIUS_PX.length - 1;

    for (let i = 0; i < n; i++) {
      const icon = icons[i]!;
      const occluded = view === 'map' && this.occludedByCelestialBody(cameraPos, icon.pos, displayTime);
      if (!shown[i] || occluded) {
        if (occluded) this.markers.fadeOut(icon.key);
        else this.markers.hide(icon.key);
        continue;
      }
      const p = projected[i]!;
      const depth = finestShown === null ? 0 : Math.min(Math.max(icon.rank - finestShown, 0), maxDepth);
      const label = this.isFarFromShown(projected, shown, i, labelMinPxSq) ? icon.label : '';
      this.markers.set(
        icon.key, 'mk-plantick', tickSvg(PLAN_TICK_RADIUS_PX[depth]!), p.x, p.y, true,
        label, 1, undefined, undefined, true,
      );
    }
    // 候補の暦区切り自体が入れ替わった分は、二度と使わないキーなので remove で消す。
    const keys = icons.map((icon) => icon.key);
    for (const key of this.lastTickKeys) if (!keys.includes(key)) this.markers.remove(key);
    this.lastTickKeys = keys;
  }

  // 軌道順で i の前後にある「採用済み(shown)」の目盛それぞれとの画面距離の2乗が、
  // どちらも minDSq 以上離れているか(採用済みの近傍が片側に無ければその側は無条件で満たす)。
  private isFarFromShown(
    projected: readonly Projected[], shown: readonly boolean[], i: number, minDSq: number,
  ): boolean {
    // 軌道順で前と後、それぞれ最初に見つかった採用済みの目盛とだけ比べる。
    for (let j = i - 1; j >= 0; j--) {
      if (!shown[j]) continue;
      if (screenDistSq(projected[j]!, projected[i]!) < minDSq) return false;
      break;
    }
    for (let j = i + 1; j < shown.length; j++) {
      if (!shown[j]) continue;
      if (screenDistSq(projected[j]!, projected[i]!) < minDSq) return false;
      break;
    }
    return true;
  }
}
