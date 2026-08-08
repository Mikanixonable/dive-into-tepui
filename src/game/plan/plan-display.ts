// 軌道計画の姿の表示: 計画折れ線(PlanTrajectory)の駆動、表示座標系(trajectoryFrame)、
// 表示時刻の計画上の自機位置ゴースト(⬡ plannedPlayer マーカー)。
import * as THREE from 'three/webgpu';
import { positionOnOrbit, tofBetween, trueAnomalyAt } from '../../physics/elements';
import { Vec3, cross, dot, len, norm, sub } from '../../physics/vec3';
import { elementsAround, frameOfAttractor, strongestAttractor } from '../../physics/attractor';
import { Frame, INERTIAL_FRAME, frameOrbitState, toFrameState, toInertialState } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';
import { SIM_EPOCH_SEC, fmtMarkerDist, fmtDist } from '../hud/utils';
import { ATTRACTOR_NAMES } from '../hud/frame-labels';
import { MarkerManager } from '../marker/marker-manager';
import { ProjectFn } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';
import { SegmentedControl } from '../hud/buttons';
import { FRAME_ITEMS } from '../hud/frame-labels';
import { MapPickable } from '../map-pick';
import * as C from '../const';
import { hudDock } from '../hud/dom';
import { Plan } from './plan';
import { PlanTrajectory } from './plan-trajectory';
import type { DisplayTimeManager } from '../display-time-manager';

// 近地点・遠地点アイコン。右クリックの被選択物であると同時に、表示するラベルを持つ。
interface ApsisIcon extends MapPickable {
  readonly label: string;
}

// 赤道交点アイコン
interface EqNodeIcon extends MapPickable {
  readonly label: string;
}

// ✕ 衝突マーカー(区間ごとに高々1つ)
interface ImpactIcon {
  readonly key: string;
  readonly pos: Vec3;
  readonly label: string;
}

// │ 日付境界の目盛マーカー
interface DayTickIcon {
  readonly key: string;
  readonly pos: Vec3;
  readonly label: string;
}

// 衝突マーカーのキー(区間ごとに固定)。区間数は SEGMENT_COLORS(plan-trajectory.ts)と同じ
// 上限で足りる。
const IMPACT_MARKER_KEYS = ['planImpact0', 'planImpact1', 'planImpact2'] as const;

export class PlanDisplay {
  trajectoryFrame: Frame = INERTIAL_FRAME;

  readonly traj: PlanTrajectory;

  private readonly panel: HTMLElement;
  private readonly frame: SegmentedControl<Frame>;
  private apsisIcons: readonly ApsisIcon[] = [];
  private eqNodeIcons: readonly EqNodeIcon[] = [];
  private impactIcons: readonly ImpactIcon[] = [];
  private dayTickIcons: readonly DayTickIcon[] = [];
  private lastDayTickCount = 0;
  private ghost: { readonly pos: Vec3; readonly label: string } | null = null;
  private plan: Plan | null = null;

  // 計画折れ線(PlanTrajectory)と TRAJECTORY パネルの DOM を構築する。
  constructor(
    scene: THREE.Scene,
    hudRoot: HTMLElement,
    private readonly markerManager: MarkerManager,
    private readonly ephemeris: Ephemeris,
    displayTimeManager: DisplayTimeManager,
  ) {
    this.traj = new PlanTrajectory(scene, displayTimeManager);

    // TRAJECTORY パネルの DOM を組み立てる
    this.panel = document.createElement('div');
    this.panel.id = 'hud-trajframe';
    this.panel.className = 'panel';
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    const title = document.createElement('h3');
    title.textContent = 'TRAJECTORY';
    this.panel.appendChild(title);
    // 表示座標系の切り替えボタン
    this.frame = new SegmentedControl<Frame>('軌道', FRAME_ITEMS, (frame) => { this.trajectoryFrame = frame; });
    this.panel.appendChild(this.frame.element);
    hudDock(hudRoot, 'left').appendChild(this.panel);
  }

  // 計画折れ線を再積分し、表示時刻のゴースト位置と近地点・遠地点アイコンを求め直す。
  // show=false のときは何も求めない — 出さない計画の位置は持たない。
  update(plan: Plan, simTime: number, displayTime: number, show: boolean): void {
    this.plan = show ? plan : null;
    if (!show) {
      this.ghost = null;
      this.apsisIcons = [];
      this.eqNodeIcons = [];
      this.impactIcons = [];
      this.dayTickIcons = [];
      this.traj.resetDivergence();
      return;
    }
    this.traj.update(plan, this.ephemeris, this.trajectoryFrame, simTime);
    this.ghost = this.ghostAt(displayTime, simTime);
    this.apsisIcons = this.apsisIconsOf();
    this.eqNodeIcons = this.eqNodeIconsOf();
    this.impactIcons = this.impactIconsOf();
    this.dayTickIcons = this.dayTickIconsOf();
  }

  // 計画折れ線・ゴーストマーカー・アプシスアイコンを update が求めた値へ同期する。
  // TRAJECTORY パネルは表示座標系を選ぶ操作 UI なので、操作を受け付けるときだけ showPanel で出す。
  sync(fo: FloatingOrigin, project: ProjectFn, showPanel: boolean): void {
    this.traj.setVisible(true);
    this.traj.sync(fo, project);
    this.syncGhost(project);
    this.syncApsisMarkers(project);
    this.syncEqNodeMarkers(project);
    this.syncImpactMarkers(project);
    this.syncDayTickMarkers(project);
    this.panel.style.display = showPanel ? 'block' : 'none';
    this.frame.setSelected(this.trajectoryFrame);
  }

  // 計画折れ線・ゴーストマーカー・アプシスアイコン・TRAJECTORY パネルを非表示にする。
  hide(): void {
    this.traj.setVisible(false);
    this.markerManager.hide('plannedPlayer');
    this.markerManager.hide('apsisPe');
    this.markerManager.hide('apsisAp');
    this.markerManager.hide('eqAn');
    this.markerManager.hide('eqDn');
    for (const key of IMPACT_MARKER_KEYS) this.markerManager.hide(key);
    for (let i = 0; i < this.lastDayTickCount; i++) this.markerManager.hide(`planDayTick${i}`);
    this.lastDayTickCount = 0;
    this.panel.style.display = 'none';
  }

  // 近地点・遠地点アイコンおよび赤道交点の右クリック候補(非表示中は空)。
  get apsisMarkers(): readonly MapPickable[] {
    return [...this.apsisIcons, ...this.eqNodeIcons];
  }

  // アプシスアイコン id に対応する通過時刻。アイコンが出ていない id では null。
  apsisTimeOf(id: string): number | null {
    const state0 = this.traj.finalSegmentStart;
    if (!state0 || !this.plan || !this.apsisIcons.some((icon) => icon.id === id)) return null;
    const center = strongestAttractor(state0.r, this.ephemeris.attractorsAt(state0.t));
    const relative = toFrameState(frameOfAttractor(center), state0);
    const el = elementsAround(state0, center);
    if (!el) return null;
    const nu = id === 'apsisAp' ? Math.PI : 0;
    const dt = tofBetween(el, trueAnomalyAt(el, relative.r), nu);
    return isFinite(dt) ? state0.t + dt : null;
  }

  // displayTime における計画上の自機位置とそのラベル。折れ線の届く範囲外なら null。
  private ghostAt(displayTime: number, simTime: number): { pos: Vec3; label: string } | null {
    const sample = this.traj.sampleAt(displayTime);
    if (!sample) return null;
    return {
      pos: this.traj.toDisplay(sample.r, displayTime),
      label: this.plannedPlayerLabel(displayTime, simTime, sample.r),
    };
  }

  // ⬡ ゴーストマーカーを計画位置に置く。計画がそこまで届いていなければ隠す。
  private syncGhost(project: ProjectFn): void {
    if (!this.ghost) {
      this.markerManager.hide('plannedPlayer');
      return;
    }
    this.markerManager.setPosition(
      'plannedPlayer', 'mk-planned', '⬡', this.ghost.pos, project, this.ghost.label,
    );
  }

  // ゴーストマーカーのラベル文字列(経過時間+高度)を組み立てる。現在時刻のゴーストは
  // 計画どおりに飛べていれば自機に重なるので、経過時間を添えず高度だけを出す。
  // 高度はその位置で最も強く引く天体の表面からの高さ。
  private plannedPlayerLabel(displayTime: number, simTime: number, r: Vec3): string {
    const tRel = displayTime - simTime;
    const center = strongestAttractor(r, this.ephemeris.attractorsAt(displayTime));
    const alt = len(sub(r, center.state.r)) - center.radius;
    if (tRel <= 0) return `計画位置 高度 ${fmtMarkerDist(alt, 0)}`;
    const h = Math.floor(tRel / 3600);
    const m = Math.floor((tRel % 3600) / 60);
    return `T+${h}h${String(m).padStart(2, '0')}m 高度 ${fmtMarkerDist(alt, 0)}`;
  }

  // 最後のバーン後の軌道(これから乗る軌道)の近地点・遠地点アイコンを、その軌道要素から
  // 解析的に求める。離心率がほぼ0で方向が不定なら空、双曲線軌道なら近地点だけ。
  private apsisIconsOf(): readonly ApsisIcon[] {
    const state0 = this.traj.finalSegmentStart;
    if (!state0 || !this.plan) return [];
    const center = strongestAttractor(state0.r, this.ephemeris.attractorsAt(state0.t));
    const tf = frameOfAttractor(center);
    const relative = toFrameState(tf, state0);
    const el = elementsAround(state0, center);
    if (!el || el.e < C.APSIS_MIN_ECC) return [];

    const apsisPosition = (nu: number): { pos: Vec3, time: number } => {
      const dt = tofBetween(el, trueAnomalyAt(el, relative.r), nu);
      const t = state0.t + (isFinite(dt) ? dt : 0);
      const relativeState = frameOrbitState(positionOnOrbit(el, nu), relative.v);
      return {
        pos: this.traj.toDisplay(toInertialState(tf, t, relativeState).r, t),
        time: t
      };
    };

    const pe = apsisPosition(0);
    const icons: ApsisIcon[] = [{
      id: 'apsisPe', name: '近地点', kind: 'apsis',
      pos: pe.pos,
      time: pe.time,
      label: `Pe ${fmtDist(el.p / (1 + el.e) - center.radius)}`,
    }];
    if (el.e < 1) {
      const ap = apsisPosition(Math.PI);
      icons.push({
        id: 'apsisAp', name: '遠地点', kind: 'apsis',
        pos: ap.pos,
        time: ap.time,
        label: `Ap ${fmtDist(el.a * (1 + el.e) - center.radius)}`,
      });
    }
    return icons;
  }

  // 最後のバーン後の軌道が中心天体の赤道面を横切る点(昇交点・降交点)のアイコンを、その
  // 軌道要素から解析的に求める。赤道面の法線は中心天体自身が持つ実際の自転軸(`Attractor.degree2.pole`
  // — J2 計算が使っているのと同じ値)を使う。太陽・木星のように degree2 が無い(自転軸をモデル化
  // していない)天体では出さない。離心率がほぼ0で方向が不定なとき、軌道面が赤道面とほぼ一致する
  // ときも空。
  private eqNodeIconsOf(): readonly EqNodeIcon[] {
    const state0 = this.traj.finalSegmentStart;
    if (!state0 || !this.plan) return [];
    const center = strongestAttractor(state0.r, this.ephemeris.attractorsAt(state0.t));
    const eqNormal = center.degree2?.pole;
    if (!eqNormal) return [];
    const tf = frameOfAttractor(center);
    const relative = toFrameState(tf, state0);
    const el = elementsAround(state0, center);
    if (!el || el.e < C.APSIS_MIN_ECC) return [];

    // 交点線の方向 = 赤道面法線 × 軌道面法線。両面がほぼ一致すると外積が潰れて向きが定まらない。
    const lineDir = cross(eqNormal, el.hHat);
    if (dot(lineDir, lineDir) < 1e-6) return [];
    const d = norm(lineDir);
    const thAsc = Math.atan2(dot(d, el.qHat), dot(d, el.pHat));

    const eqPosition = (nu: number): { pos: Vec3, time: number } => {
      const dt = tofBetween(el, trueAnomalyAt(el, relative.r), nu);
      const t = state0.t + (isFinite(dt) ? dt : 0);
      const relativeState = frameOrbitState(positionOnOrbit(el, nu), relative.v);
      return {
        pos: this.traj.toDisplay(toInertialState(tf, t, relativeState).r, t),
        time: t
      };
    };

    const an = eqPosition(thAsc);
    const dn = eqPosition(thAsc + Math.PI);
    const centerName = ATTRACTOR_NAMES[center.id];
    return [
      { id: `${center.id}-eqan`, name: `${centerName}赤道昇交点`, kind: 'eqnode', pos: an.pos, time: an.time, label: 'EqAN' },
      { id: `${center.id}-eqdn`, name: `${centerName}赤道降交点`, kind: 'eqnode', pos: dn.pos, time: dn.time, label: 'EqDN' },
    ];
  }

  // 天体衝突が検出された地点(区間ごとに高々1つ)。その地点で最も強く引く天体の表面からの
  // 高度をラベルに添える。
  private impactIconsOf(): readonly ImpactIcon[] {
    return this.traj.impactPoints().flatMap(({ state, arcIdx }) => {
      const key = IMPACT_MARKER_KEYS[arcIdx];
      if (key === undefined) return [];
      const center = strongestAttractor(state.r, this.ephemeris.attractorsAt(state.t));
      const alt = len(sub(state.r, center.state.r)) - center.radius;
      return [{ key, pos: this.traj.toDisplay(state.r, state.t), label: `衝突 高度 ${fmtMarkerDist(alt, 0)}` }];
    });
  }

  // 表示中の折れ線が UTC 日付境界(0時0分0秒)を跨ぐ地点のアイコン。ラベルは UTC の日付。
  private dayTickIconsOf(): readonly DayTickIcon[] {
    return this.traj.dayBoundaries().map(({ t, pos }, i) => {
      const d = new Date((SIM_EPOCH_SEC + t) * 1000);
      return {
        key: `planDayTick${i}`,
        pos: this.traj.toDisplay(pos, t),
        label: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`,
      };
    });
  }

  // ◇ アプシスアイコンを update が求めた位置に置き、出ていないものを隠す。
  private syncApsisMarkers(project: ProjectFn): void {
    for (const key of ['apsisPe', 'apsisAp'] as const) {
      const icon = this.apsisIcons.find((m) => m.id === key);
      if (icon) this.markerManager.setPosition(key, 'mk-apsis', '◇', icon.pos, project, icon.label);
      else this.markerManager.hide(key);
    }
  }

  // △▽ 赤道交点アイコンを update が求めた位置に置き、出ていないものを隠す。マーカーキーは
  // 昇交点・降交点の2枠で固定(eqNodeIconsOf が返す配列はその順序で並ぶ)、中心天体を含む
  // MapPickable.id とは別物。
  private syncEqNodeMarkers(project: ProjectFn): void {
    const [an, dn] = this.eqNodeIcons;
    if (an) this.markerManager.setPosition('eqAn', 'mk-node', '△', an.pos, project, an.label);
    else this.markerManager.hide('eqAn');
    if (dn) this.markerManager.setPosition('eqDn', 'mk-node', '▽', dn.pos, project, dn.label);
    else this.markerManager.hide('eqDn');
  }

  // ✕ 衝突マーカーを update が求めた位置に置き、出ていないものを隠す。
  private syncImpactMarkers(project: ProjectFn): void {
    for (const key of IMPACT_MARKER_KEYS) {
      const icon = this.impactIcons.find((m) => m.key === key);
      if (icon) this.markerManager.setPosition(key, 'mk-impact', '✕', icon.pos, project, icon.label);
      else this.markerManager.hide(key);
    }
  }

  // │ 日付境界の目盛マーカーを update が求めた位置に置く。件数が可変なので、前フレームより
  // 減った分だけ隠す(固定キー集合を持つ他のアイコンとは異なり、キー自体が個数ぶん増減する)。
  private syncDayTickMarkers(project: ProjectFn): void {
    for (const icon of this.dayTickIcons) {
      this.markerManager.setPosition(icon.key, 'mk-daytick', '│', icon.pos, project, icon.label);
    }
    for (let i = this.dayTickIcons.length; i < this.lastDayTickCount; i++) {
      this.markerManager.hide(`planDayTick${i}`);
    }
    this.lastDayTickCount = this.dayTickIcons.length;
  }
}
