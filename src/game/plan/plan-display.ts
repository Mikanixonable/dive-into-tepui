// 操作対象の軌道計画の姿の表示(両ビュー常駐)。どの計画をいつ描くかを決め、計画折れ線
// (PlanPath)を駆動して、表示時刻の計画上の自機位置ゴースト(⬢ plannedPlayer マーカー)を置く。
import type { ViewMode } from '../view/view-mode';
import { type Vec3, len, sub } from '../../math/vec3';
import { strongestAttractor } from '../../physics/attractor';
import type { FrameAnchorSource } from '../../physics/frame';
import { isOccluded } from '../../physics/occlusion';
import type { Projected } from '../../math/projection';
import { fmtMarkerDist } from '../../hud/utils';
import { type TickRank, type TimeLabelSetting, calendarBoundaries, tickLabel } from '../hud/orbit/calendar-ticks';
import { ApsisMarker } from '../marker/apsis-marker';
import type { DisplayedPath } from '../marker/equator-node-marker-pair';
import type { MarkerDeclaration } from '../../marker/marker-declaration';
import type { MarkerSink } from '../../marker/marker-sink';
import type { MarkerDevice } from '../../marker/marker-device';
import { MARKER_PRIORITY } from '../marker/marker-priority';
import { pointPlacement } from '../marker/marker-placement';
import { ENTITY_GLYPH, ORBIT_POINT_GLYPH } from '../marker/marker-identity';
import type { CameraFrame } from '../../render/camera/camera-frame';
import type { ObjectPickable } from '../pickable/object-pickable';
import type { PlanData } from './plan';
import type { PlanPath } from './plan-path';
import { type DisplayWindow, timeLabelSettingOf } from '../display-window-manager';
import type { Apsis } from '../../physics/trajectory-features';
import type { Controllable } from '../dynamic/dynamic-entity/controllable';
import type { ControlSelection } from '../control-selection';
import type { PredictedArc } from '../dynamic/predicted-arc';
import type { PerfCounts } from '../perf-counts';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { ProjectFn } from '../../math/projection';

// 近地点・遠地点アイコンを出す離心率相当値の下限。これ未満は円に近く、アプシスの方向が
// 不定なので両方隠す。
const APSIS_MIN_ECC = 0.01;

// 計画軌道上の暦目盛の間隔・本数を決める値。
const PLAN_TICK_MIN_PX = 40; // 目盛同士の最小画面間隔 [px]
const PLAN_TICK_LABEL_MIN_PX = 90; // ラベルを付ける最小画面間隔 [px]
const PLAN_TICK_MAX_COUNT = 400; // 日・月・年階級の目盛候補の上限本数

// 時階級(1/3/6/12時間ごと)の目盛候補の上限本数(1時間ごとで50日分)。区間の長さで階級が離散的・一斉に
// 切り替わるとズームに対して不連続に見えるため、最細粒度で列挙する。
const PLAN_TICK_HOUR_FAMILY_MAX_COUNT = 1200;

// 目盛点の半径 [px]。表示中の最細目盛からの相対階層(0/1/2以上)で引く。
const PLAN_TICK_RADIUS_PX = [1.5, 2.5, 3.5] as const;

// ルーラー目盛マーカー。
interface PlanTickIcon {
  readonly key: string;
  readonly pos: Vec3;
  readonly rank: TickRank;
  readonly label: string;
}

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
  private readonly group: MarkerSink;
  private readonly apsisPe = new ApsisMarker('pe');
  private readonly apsisAp = new ApsisMarker('ap');
  // このフレームに描く計画の材料。描く計画が無ければ null。
  private displayedPlan: PlanData | null = null;
  private readonly declarations: MarkerDeclaration[] = [];

  // path へ操作対象の計画を描かせ、その印を markers から作ったマーカー群へ置く。
  public constructor(
    private readonly path: PlanPath,
    markers: MarkerDevice,
    private readonly celestialBodies: CelestialBodies,
    private readonly controlSelection: ControlSelection,
  ) {
    this.group = markers.createGroup();
  }

  // 計画折れ線を再積分し、アプシスアイコンを求め直す。
  // 折れ線は戦闘ビューでも描く — 計画どおりに機体を動かすのは戦闘ビューだから。
  public update(displayWindow: DisplayWindow, frameAnchors: FrameAnchorSource, view: ViewMode): void {
    const ship = this.controlSelection.current;
    this.displayedPlan = this.planToDisplay(ship, view);
    const { frame, simTime, displayTime, duration } = displayWindow;
    this.path.update(this.displayedPlan, ship, frame, simTime, displayTime, frameAnchors, duration);
    // 描く計画が無ければ、近地点・遠地点アイコンを出す理由も無くなる。
    if (this.displayedPlan === null) {
      this.apsisPe.retire();
      this.apsisAp.retire();
    } else {
      this.placeApsisMarkers(ship?.name ?? null);
    }
  }

  // owner の計画折れ線がこのフレームに出ていれば、その座標系とサンプル列。出ていなければ null。
  public displayedPathOf(ownerId: string): DisplayedPath | null {
    if (this.displayedPlan === null || this.controlSelection.current?.id !== ownerId) return null;
    const samples = this.path.displayedSamples();
    return samples.length === 0 ? null : { frame: this.path.displayFrame, samples };
  }

  // 計画折れ線・ゴーストマーカー・アプシスアイコン・目盛を、焼かれた折れ線から組んで置く。
  // nowMs はフレームの実時刻 [ms]。
  public sync(camera: CameraFrame, view: ViewMode, displayWindow: DisplayWindow, nowMs: number): void {
    // 描く弧が無いフレームも折れ線の同期は通す — 止めると、消えたはずの線がそのまま残る。
    this.path.sync(camera);
    const declarations = this.declarations;
    declarations.length = 0;
    if (this.displayedPlan !== null) {
      const project = camera.project;
      const cameraPos = camera.position;
      const { simTime, displayTime } = displayWindow;
      const timeLabel = timeLabelSettingOf(displayWindow);
      declarations.push(this.ghostDeclaration(project, view, cameraPos, displayTime, simTime));
      this.pushApsisDeclarations(declarations, project, view, cameraPos, displayTime, timeLabel);
      this.pushImpactDeclarations(declarations, project, view, cameraPos, displayTime);
      this.pushTickDeclarations(declarations, project, view, cameraPos, displayTime, timeLabel);
    }
    this.group.sync(declarations, nowMs);
  }

  // このフレームに表示している計画区間の弧。表示している計画が無ければ空。
  public growableArcs(): readonly PredictedArc[] {
    return this.displayedPlan === null ? [] : this.path.growableArcs();
  }

  // 直近のフレームで作り直した計画区間の本数。
  public perfCounts(): Pick<PerfCounts, 'planArcs'> {
    return { planArcs: this.path.lastRebuiltArcs };
  }

  // マーカー群を片付ける。
  public dispose(): void {
    this.group.dispose();
  }

  // このフレームに出す折れ線の材料。出す価値のある折れ線が無ければ null — ノードの無い計画は
  // 操作対象の現在軌道そのものなので、ノードを置ける編集中(マップビュー)だけ出す。
  private planToDisplay(ship: Controllable | null, view: ViewMode): PlanData | null {
    if (ship === null) return null;
    if (view !== 'map' && ship.plan.nodes.length === 0) return null;
    return ship.plan.displayData(ship.motion.state);
  }

  // 近地点・遠地点アイコンの右クリック候補(このフレームに求まったものだけ)。
  public get apsisMarkers(): readonly ObjectPickable[] {
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

  // ⬢ ゴーストマーカーの宣言。
  private ghostDeclaration(
    project: ProjectFn, view: ViewMode, cameraPos: Vec3, displayTime: number, simTime: number,
  ): MarkerDeclaration {
    const base = {
      id: 'plannedPlayer', cls: 'mk-planned', sym: ENTITY_GLYPH.ghost,
      priority: MARKER_PRIORITY.NONE,
    };
    // 計画がそこまで届いていなければ伏せる。
    const ghost = this.ghostAt(displayTime, simTime);
    if (!ghost) return { ...base, x: 0, y: 0, front: false };
    // マップビューで天体の陰に入ったら薄れて消える。
    if (view === 'map' && this.occludedByCelestialBody(cameraPos, ghost.pos, displayTime)) {
      return { ...base, x: 0, y: 0, front: false, occluded: true };
    }
    const { x, y, front, dist } = pointPlacement(ghost.pos, project, cameraPos);
    return { ...base, x, y, front, dist, label: ghost.label };
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
    const distanceOf = (apsis: Apsis): number => (
      len(sub(apsis.state.r, this.celestialBodies.stateAt(apsis.center.id, apsis.state.t).r))
    );
    // 円かどうかは、近地点と遠地点が同じ中心天体から測られているときだけ判定できる。
    if (pe && ap && pe.center.id === ap.center.id) {
      const peDist = distanceOf(pe);
      const apDist = distanceOf(ap);
      if ((apDist - peDist) / (apDist + peDist) < APSIS_MIN_ECC) { this.clearApsisMarkers(); return; }
    }

    const namePrefix = ownerName ? (this.path.nodeCount > 0 ? `${ownerName} (計画)` : ownerName) : null;
    this.placeApsisMarker(this.apsisPe, pe, namePrefix);
    this.placeApsisMarker(this.apsisAp, ap, namePrefix);
  }

  // 極値があれば、折れ線と同じ座標系へ写した位置を記録する。
  private placeApsisMarker(marker: ApsisMarker, apsis: Apsis | null, ownerName: string | null): void {
    if (!apsis) {
      marker.place(null, null, null, null);
      return;
    }
    const { state, center } = apsis;
    marker.place(this.path.toDisplay(state.r, state.t), state.t, center.id, ownerName);
  }

  // 近地点・遠地点アイコンを、このフレームは求まらなかった状態にする。
  private clearApsisMarkers(): void {
    this.placeApsisMarker(this.apsisPe, null, null);
    this.placeApsisMarker(this.apsisAp, null, null);
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

  // 近地点・遠地点のマーカーの宣言を、それぞれが解いた位置から積む。
  private pushApsisDeclarations(
    out: MarkerDeclaration[], project: ProjectFn, view: ViewMode, cameraPos: Vec3,
    displayTime: number, timeLabel: TimeLabelSetting,
  ): void {
    const celestialBodies = this.celestialBodies.celestialMotions;
    for (const marker of [this.apsisPe, this.apsisAp]) {
      out.push(marker.declaration(
        project, cameraPos, celestialBodies, displayTime, view === 'map', timeLabel,
      ));
    }
  }

  // ✕ 衝突マーカーの宣言を、折れ線が返した区間ごとの衝突地点(区間ごとに高々1つ)から積む。
  // 衝突天体は判定を返した積分弧のものをそのまま使う — ここで引き直すと、判定に使った天体と
  // 食い違う名前が出かねない。
  private pushImpactDeclarations(
    out: MarkerDeclaration[], project: ProjectFn, view: ViewMode, cameraPos: Vec3, displayTime: number,
  ): void {
    for (const { state, body, arcIdx } of this.path.impactPoints()) {
      const pos = this.path.toDisplay(state.r, state.t);
      const base = {
        id: `planImpact:${arcIdx}`, cls: 'mk-impact', sym: ORBIT_POINT_GLYPH.impact,
        priority: MARKER_PRIORITY.IMPACT, iconHidable: false,
      };
      // マップビューで天体の陰に入ったものは薄れて消える。
      if (view === 'map' && this.occludedByCelestialBody(cameraPos, pos, displayTime)) {
        out.push({ ...base, x: 0, y: 0, front: false, occluded: true });
        continue;
      }
      const { x, y, front, dist } = pointPlacement(pos, project, cameraPos);
      out.push({ ...base, x, y, front, dist, label: `衝突 ${this.celestialBodies.nameOf(body.id)}` });
    }
  }

  // 暦の区切りの目盛候補を画面距離で間引いて置く。粗い階数(月・年)から順に採否を決め、
  // 採用済みの目盛から PLAN_TICK_MIN_PX 未満しか離れない候補は捨てる — 離心軌道では候補の
  // 画面間隔が場所で桁違いになるので、区間全体で単位を揃えずこの局所判定に任せる。
  private pushTickDeclarations(
    out: MarkerDeclaration[], project: ProjectFn, view: ViewMode, cameraPos: Vec3,
    displayTime: number, timeLabel: TimeLabelSetting,
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
      const p = projected[i]!;
      const depth = finestShown === null ? 0 : Math.min(Math.max(icon.rank - finestShown, 0), maxDepth);
      const base = {
        id: icon.key, cls: 'mk-plantick', sym: tickSvg(PLAN_TICK_RADIUS_PX[depth]!), markup: true,
        priority: MARKER_PRIORITY.NONE,
      };
      if (!shown[i] || occluded) {
        out.push({ ...base, x: p.x, y: p.y, front: false, occluded });
        continue;
      }
      out.push({
        ...base, x: p.x, y: p.y, front: true,
        label: this.isFarFromShown(projected, shown, i, labelMinPxSq) ? icon.label : '',
      });
    }
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
