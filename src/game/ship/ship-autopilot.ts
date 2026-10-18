// 計画ノードを有限燃焼で実行する自動操縦。艦の部品として持ち主の推進・燃料・姿勢へ指令する。
// ノード1つを「ノード時刻をほぼ中心とする燃焼」へ変換し、燃焼時間はロケット方程式から、
// 推力方向は残りの必要速度変化(必要速度誘導)から随時求める。燃焼の開始・終了は時刻指定の
// 出来事として刻みを区切り、燃焼中は時間加速倍率によらない細かさで進める。
import { attitudeAlignTorque, type Attitude } from '../../physics/attitude';
import type { CelestialBody } from '../../physics/celestial-body';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import { strongestAttractor } from '../../physics/attractor';
import { orbitalElementsOf, stateOnOrbitAt } from '../../physics/elements';
import {
  deserializeKinematicState, serializeKinematicState, type KinematicState, type SerializedKinematicState,
} from '../../physics/kinematic-state';
import { LOCAL_FORWARD, qRotate } from '../../math/quat';
import { add, len, sameVec, scale, sub, v3, type Vec3 } from '../../math/vec3';
import type { Plan, PlanExecutionMode } from '../plan/plan';
import type { ModularShipMotion } from './modular-ship-motion';
import { burnDuration, deltaVBudget, effectiveExhaustVelocity } from '../../physics/rocket';
import { solveLambert } from '../../physics/lambert';
import { kinematicState } from '../../physics/kinematic-state';

// 燃焼・回頭を指令する間の積分刻みの上限 [s]。倍率によらず一定なので、ワープを変えても
// 燃焼の結果は変わらない。
const AUTOPILOT_STEP_MAX = 0.25;

// これ未満の速度変化しか要らないノードは燃焼しない [m/s]。
const MIN_NODE_DELTA_V = 1e-3;
// 燃焼の収束判定。残り必要速度変化がこれを下回れば燃焼を閉じる [m/s]。
const BURN_DONE_EPSILON = 0.05;
// 燃焼を開始してよい、機首と燃焼方向の角度誤差 [rad]。
const IGNITE_ANGLE_TOLERANCE = 0.05;

// 燃焼後の修正燃焼を省く下限 [m/s]。後続ノードの解き直しが提案する修正 Δv がこれ未満なら打たない。
export const MIN_RESOLVE_CORRECTION = 0.1;

// 整列トルクの PD ゲイン。進行方向ホールドと同じ制御律を燃焼方向へ向けるのに使う。
const AIM_KP = 3.2;
const AIM_KD = 2.6;

// 回頭の見積りの余裕率。推力角加速度をバンバン制御した所要時間に掛ける安全率。
const TURN_MARGIN = 4;
// 回頭見積りに足す固定の余裕 [s]。
const TURN_MARGIN_FLAT = 2;
// 燃焼の打ち切り猶予。予定燃焼時間の何倍まで実燃焼を許すか(推定誤差・回頭遅れを吸収する)。
const BURN_OVERRUN_FACTOR = 2;
const BURN_OVERRUN_FLAT = 30; // [s]

// 燃焼後の中間修正ノードを挿す位置。残り飛行時間に対する割合と最小の猶予 [s]。
const CORRECTION_FRACTION = 0.2;
const CORRECTION_LEAD_MIN = 60;
// 実状態の二体外挿が次ノード位置からこれを超えて外れていたら修正ノードを挿す [m]。
const CORRECTION_MIN_MISS = 500;

// 自動操縦の直列化した形。
export interface SerializedShipAutopilot {
  readonly phase: 'idle' | 'aiming' | 'burning';
  readonly aimStart: number | null;
  readonly burnStart: number | null;
  readonly burnEnd: number | null;
  readonly burnNode: SerializedKinematicState | null;
  readonly abortedNode: SerializedKinematicState | null;
}

// 自動操縦が読み書きする持ち主の面。ModularShip がこれを実装する。
export interface AutopilotHost {
  readonly plan: Plan;
  readonly planExecution: PlanExecutionMode;
  readonly motion: ModularShipMotion;
  // 健全なコックピットを持ち操縦できるか。
  readonly healthyCockpit: boolean;
  readonly totalThrust: number; // 主推進の推力合計 [N]
  readonly totalTorque: number; // 姿勢制御トルク合計 [N·m]
  readonly totalFuelConsumptionRate: number; // 主推進の燃料消費率 [fuel unit/s]
  readonly rcsFuelConsumptionRate: number; // RCS の燃料消費率 [fuel unit/s]
  readonly totalFuel: number; // 主推進燃料残量 [fuel unit]
  consumeFuel(units: number): number;
  consumeRcsFuel(units: number): number;
  // 主推進燃料 1 unit あたりの質量 [kg/unit]。
  mainFuelMassPerUnit(): number;
}

// 燃焼の予定。aiming に入った時点で凍結する。
interface BurnSchedule {
  readonly node: KinematicState;
  readonly aimStart: number;
  readonly burnStart: number;
  readonly burnEnd: number;
}

// 状態 state を、attractors のうち最も強く引く天体まわりの二体軌道として targetT まで外挿した
// ときの目標速度との差(残りの必要速度変化、ECI)。外挿できない軌道では現在速度との差で近似する。
function velocityToGo(
  node: KinematicState, state: KinematicState,
  attractors: readonly CelestialBody[], pivot: number,
): Vec3 {
  const center = strongestAttractor(state.r, attractors, pivot);
  const elements = orbitalElementsOf(state, center, state.t);
  const relative = elements === null ? null : stateOnOrbitAt(elements, node.t);
  const vPre = relative === null ? state.v : add(relative.v, center.stateAt(node.t).v);
  return sub(node.v, vPre);
}

// 状態 state のときの機首(ECI での +Z ローカル軸)。
function noseDirection(att: Attitude): Vec3 {
  return qRotate(att.q, LOCAL_FORWARD);
}

// 機首 forward と燃焼方向 desired の角度誤差 [rad]。
function aimError(att: Attitude, desired: Vec3): number {
  const nose = noseDirection(att);
  const cos = Math.max(-1, Math.min(1,
    (nose.x * desired.x + nose.y * desired.y + nose.z * desired.z)
    / (len(nose) * len(desired))));
  return Math.acos(cos);
}

// 2つの絶対状態が同じノードを指すか(実行時刻・位置・速度がすべて一致するか)。
function sameNode(a: KinematicState, b: KinematicState): boolean {
  return a.t === b.t && sameVec(a.r, b.r) && sameVec(a.v, b.v);
}

export class ShipAutopilot {
  private phase: 'idle' | 'aiming' | 'burning' = 'idle';
  private scheduled: BurnSchedule | null = null;
  // 燃焼の強制打ち切り時刻。推定誤差で収束しない燃焼が伸び続けないようにする。
  private hardEnd = Infinity;
  // 手動介入で中断したときの先頭ノード。同じノードが先頭に居るあいだ再武装しない。
  private abortedNode: KinematicState | null = null;
  // 今フレームの自動操縦の許可(ステージが計画実行に対応し、艦が操縦できること)。フレームの先頭で
  // updateFrame が立て直す非直列化の値。
  private enabled = false;
  // 自動操縦以外の推力(点火済みブースター)。フレームの先頭で updateFrame が立て直す非直列化の値。
  private externalThrust: Vec3 | null = null;
  // 燃焼ごとの終わりに呼ぶ再求解のコールバック口(求解本体は別フェーズ)。
  private burnCompleted: ((host: AutopilotHost, node: KinematicState) => void) | null = null;

  // host はこの自動操縦が指令する艦。saved があれば記録から段・予定・中断を復元する。
  public constructor(
    private readonly host: AutopilotHost,
    saved?: SerializedShipAutopilot,
  ) {
    if (saved !== undefined) {
      this.phase = saved.phase;
      this.abortedNode = saved.abortedNode && deserializeKinematicState(saved.abortedNode);
      if (saved.aimStart !== null && saved.burnStart !== null && saved.burnEnd !== null
        && saved.burnNode !== null) {
        this.scheduled = {
          node: deserializeKinematicState(saved.burnNode),
          aimStart: saved.aimStart,
          burnStart: saved.burnStart,
          burnEnd: saved.burnEnd,
        };
        this.hardEnd = saved.burnStart
          + BURN_OVERRUN_FACTOR * (saved.burnEnd - saved.burnStart) + BURN_OVERRUN_FLAT;
      }
    }
  }

  public serialize(): SerializedShipAutopilot {
    return {
      phase: this.phase,
      aimStart: this.scheduled?.aimStart ?? null,
      burnStart: this.scheduled?.burnStart ?? null,
      burnEnd: this.scheduled?.burnEnd ?? null,
      burnNode: this.scheduled ? serializeKinematicState(this.scheduled.node) : null,
      abortedNode: this.abortedNode && serializeKinematicState(this.abortedNode),
    };
  }

  // 現在の段。表示や中断連携が読む。
  public get phaseName(): 'idle' | 'aiming' | 'burning' { return this.phase; }

  // 燃焼ごとの終わりに呼ぶ再求解のコールバックを登録する。null で外す。
  public setBurnCompleted(callback: ((host: AutopilotHost, node: KinematicState) => void) | null): void {
    this.burnCompleted = callback;
  }

  // 次に刻みを区切るべき出来事時刻。予定が無ければ null。
  public nextEventTime(_simTime: number): number | null {
    if (!this.enabled) return null;
    const scheduled = this.scheduled;
    if (scheduled === null) return null;
    switch (this.phase) {
      case 'idle': return scheduled.aimStart;
      case 'aiming': return scheduled.burnStart;
      case 'burning': return this.hardEnd;
    }
  }

  // 自動操縦が要求する積分刻みの上限 [s]。待機中は制約しない( Infinity)。
  public maxStepDuration(): number {
    return this.phase === 'idle' ? Infinity : AUTOPILOT_STEP_MAX;
  }

  // フレームの先頭で呼ぶ。enabled は「このステージで計画を実行でき、艦が操縦できる」、
  // externalThrust は自動操縦と併存しうるこのフレームの推力加速度(ECI、無ければ null)。
  public updateFrame(
    simTime: number, celestialBodies: CelestialBodies,
    enabled: boolean, externalThrust: Vec3 | null,
  ): void {
    this.enabled = enabled && this.host.planExecution === 'autopilot' && this.host.healthyCockpit;
    this.externalThrust = externalThrust;
    if (!this.enabled) {
      if (this.phase !== 'idle') this.stop();
      return;
    }
    const first = this.host.plan.firstNode();
    if (this.phase === 'idle') {
      // 中断したノードが先頭に居るあいだは予定を立てない。先頭が変われば中断は解ける。
      if (first !== undefined && this.abortedNode !== null && !sameNode(this.abortedNode, first)) {
        this.abortedNode = null;
      }
      if (first === undefined || this.abortedNode !== null) {
        this.scheduled = null;
        return;
      }
      this.scheduled = this.computeSchedule(first, celestialBodies);
      if (this.scheduled !== null && this.scheduled.aimStart <= simTime) this.phase = 'aiming';
      return;
    }
    // 予定のノードが編集・消費で先頭から外れたら、現在の段を畳んで立て直す。
    if (this.scheduled !== null && (first === undefined || !sameNode(this.scheduled.node, first))) {
      this.stop();
      return;
    }
    if (this.phase === 'aiming') {
      this.scheduled = this.computeSchedule(first!, celestialBodies);
    }
  }

  // 積分サブステップの直前に呼ぶ。推力・トルクを motion へ指令する。dt はこの刻みの長さ [s]。
  public step(dt: number, attractors: readonly CelestialBody[], pivot: number): void {
    if (!this.enabled) return;
    const motion = this.host.motion;
    const t = motion.state.t;
    if (this.phase === 'idle') {
      if (this.scheduled !== null && t >= this.scheduled.aimStart) this.phase = 'aiming';
      else return;
    }
    const scheduled = this.scheduled;
    if (scheduled === null) { this.phase = 'idle'; return; }
    const first = this.host.plan.firstNode();
    if (first === undefined || !sameNode(scheduled.node, first)) { this.stop(); return; }

    const vgo = velocityToGo(scheduled.node, motion.state, attractors, pivot);
    const vgoMag = len(vgo);
    if (this.phase === 'aiming') {
      if (vgoMag <= MIN_NODE_DELTA_V) { this.finishBurn(scheduled.node, attractors, pivot); return; }
      const dir = scale(vgo, 1 / vgoMag);
      this.aimAt(dir, dt);
      if (t >= scheduled.burnStart && aimError(motion.att, dir) <= IGNITE_ANGLE_TOLERANCE) {
        this.phase = 'burning';
        this.hardEnd = scheduled.burnStart
          + BURN_OVERRUN_FACTOR * (scheduled.burnEnd - scheduled.burnStart) + BURN_OVERRUN_FLAT;
      } else {
        return;
      }
    }
    // 燃焼。残り必要速度変化の方向へ推力を向け、尽きる・収束する・打ち切り時刻で止める。
    if (vgoMag <= BURN_DONE_EPSILON || t >= this.hardEnd || !(this.host.totalThrust > 0)) {
      this.finishBurn(scheduled.node, attractors, pivot);
      return;
    }
    const dir = scale(vgo, 1 / vgoMag);
    this.aimAt(dir, dt);
    const units = this.host.totalFuelConsumptionRate * dt;
    const ratio = this.host.consumeFuel(units);
    if (!(ratio > 0)) { this.finishBurn(scheduled.node, attractors, pivot); return; }
    const mass = motion.mass;
    if (!(mass > 0)) { this.finishBurn(scheduled.node, attractors, pivot); return; }
    const thrust = scale(dir, this.host.totalThrust / mass * ratio);
    motion.setThrust(this.externalThrust === null ? thrust : add(thrust, this.externalThrust));
  }

  // 手動の噴射・回転指令による中断。現在の先頭ノードに対する自動操縦を畳み、同じノードでは
  // 再武装しない(航行指令の中断へ繋ぐ口)。
  public interrupt(): void {
    const first = this.host.plan.firstNode();
    if (first === undefined) return;
    if (this.phase === 'idle' && this.scheduled === null) return;
    this.abortedNode = first;
    this.stop();
  }

  // 燃焼方向 direction へ機首を向けるトルクを指令し、そのぶんの RCS 燃料を消費する。
  private aimAt(direction: Vec3, dt: number): void {
    const motion = this.host.motion;
    const totalTorque = this.host.totalTorque;
    let torque = attitudeAlignTorque(direction, motion.state.r, motion.att, AIM_KP, AIM_KD);
    if (totalTorque > 0 && this.host.rcsFuelConsumptionRate > 0) {
      const fraction = Math.min(1, len(torque) / totalTorque);
      const ratio = this.host.consumeRcsFuel(this.host.rcsFuelConsumptionRate * fraction * dt);
      if (!(ratio > 0)) torque = v3();
      else if (ratio < 1) torque = scale(torque, ratio);
    }
    motion.setTorque(torque);
  }

  // 燃焼を閉じ、実行したノードを実状態から消化し、残る計画へ中間修正を挿して次の段へ戻る。
  private finishBurn(
    node: KinematicState, attractors: readonly CelestialBody[], pivot: number,
  ): void {
    const motion = this.host.motion;
    motion.setThrust(this.externalThrust);
    this.host.plan.consumeNodesUpTo(node.t, motion.state);
    this.replanAfterBurn(attractors, pivot);
    this.stop();
    this.burnCompleted?.(this.host, node);
  }

  // 燃焼の実績が計画どおりでない分を、次ノードへ向かう中間修正ノードとして挿す閉ループ。
  // 実状態を最も強く引く天体まわりで外挿し、次ノードの位置からずれていたら、
  // ランベルトで修正点へ乗り継ぐノードを残り計画の先頭へ足す。
  private replanAfterBurn(attractors: readonly CelestialBody[], pivot: number): void {
    const next = this.host.plan.firstNode();
    if (next === undefined) return;
    const state = this.host.motion.state;
    const tof = next.t - state.t;
    const tC = state.t + Math.max(CORRECTION_LEAD_MIN, tof * CORRECTION_FRACTION);
    if (!(tC < next.t)) return; // 次ノードが近いなら到達燃焼が誤差を吸収する
    const center = strongestAttractor(state.r, attractors, pivot);
    const elements = orbitalElementsOf(state, center, state.t);
    if (elements === null) return;
    const atNext = stateOnOrbitAt(elements, next.t);
    if (atNext === null) return;
    const centerNext = center.stateAt(next.t);
    const miss = len(sub(add(atNext.r, centerNext.r), next.r));
    if (!(miss > CORRECTION_MIN_MISS)) return;
    const relC = stateOnOrbitAt(elements, tC);
    if (relC === null) return;
    const centerC = center.stateAt(tC);
    const sol = solveLambert(relC.r, sub(next.r, centerNext.r), next.t - tC, center.def.mu)[0];
    if (sol === undefined) return;
    const dv = len(sub(sol.v1, relC.v));
    if (!(dv >= MIN_RESOLVE_CORRECTION)) return;
    const correction = kinematicState<'eci'>(tC, add(relC.r, centerC.r), add(sol.v1, centerC.v));
    this.host.plan.replaceAll(state, [correction, ...this.host.plan.nodes]);
  }

  // 段と予定を畳む。推力は外部の分へ戻す。
  private stop(): void {
    this.phase = 'idle';
    this.scheduled = null;
    this.host.motion.setThrust(this.externalThrust);
  }

  // 先頭ノードに対する燃焼・回頭の予定。推力・消費率・燃料が足りなければ null。
  private computeSchedule(node: KinematicState, celestialBodies: CelestialBodies): BurnSchedule | null {
    const motion = this.host.motion;
    const state = motion.state;
    const vgo = velocityToGo(node, state, celestialBodies.gravityMotions, state.t);
    const dv = len(vgo);
    const thrustN = this.host.totalThrust;
    const consumptionKgPerSec = this.host.totalFuelConsumptionRate * this.host.mainFuelMassPerUnit();
    const exhaustVel = effectiveExhaustVelocity(thrustN, consumptionKgPerSec);
    if (!(dv > MIN_NODE_DELTA_V) || !(thrustN > 0) || !(exhaustVel > 0) || !isFinite(exhaustVel)) {
      return null;
    }
    // 燃料の持つ Δv を超えるノードは、持てる分だけ燃える燃焼として予定する。
    const budget = deltaVBudget(exhaustVel, motion.mass, this.propellantUnits() * this.host.mainFuelMassPerUnit());
    const duration = burnDuration(motion.mass, exhaustVel, thrustN, Math.min(dv, Math.max(budget, 1e-9)));
    const burnStart = node.t - duration / 2;
    const alpha = this.angularAcceleration();
    const angle = alpha > 0 ? aimError(motion.att, scale(vgo, 1 / dv)) : 0;
    // バンバン制御の回頭時間 t = 2·√(θ/α) に余裕を掛ける。
    const turnTime = alpha > 0 ? TURN_MARGIN * Math.sqrt(angle / alpha) + TURN_MARGIN_FLAT : TURN_MARGIN_FLAT;
    return { node, aimStart: burnStart - turnTime, burnStart, burnEnd: burnStart + duration };
  }

  // 主推進燃料の残量 [fuel unit]。
  private propellantUnits(): number {
    return this.host.totalFuel;
  }

  // 姿勢制御の角加速度の代表値 [rad/s²]。最も重い主軸まわりで見積もる。
  private angularAcceleration(): number {
    const inertia = this.host.motion.att.inertia;
    const maxInertia = Math.max(inertia.x, inertia.y, inertia.z);
    return maxInertia > 0 ? this.host.totalTorque / maxInertia : 0;
  }
}
