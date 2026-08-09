// マニューバノードを実際に姿勢制御・エンジン噴射で実行する状態機械(Slew→Armed→Burn→Trim)。
// 噴射方向は点火時点の速度差から慣性系(ECI)固定で決め、燃焼中は姿勢を追随させない。
// Player が1隻に1つ所有し、'powered' の間だけ ship.torque/ship.thrust へ書く。
import { KinematicState } from '../../physics/kinematic-state';
import { attitudeAlignError, attitudeAlignTorque } from '../../physics/attitude';
import { Vec3, len, norm, scale, sub } from '../../physics/vec3';
import * as C from '../const';
import { Hud } from '../hud/hud';
import { SimSpeedManager } from '../sim-speed-manager';
import type { Player } from '../player/player';
import { burnCutoffProjection, ignitionTimeFor } from './plan-executor-math';

type Phase = 'idle' | 'slew' | 'armed' | 'burn' | 'trim';

export class PlanExecutor {
  private phase: Phase = 'idle';
  // 現在追っているノードの実行時刻。ノードが差し替わった(編集された)ら状態機械を idle からやり直す。
  private targetNodeT: number | null = null;
  private burnDirWorld: Vec3 | null = null;
  // update() が求めた、燃料消費込みの現在の点火出力 [m/s^2]。点火の瞬間(applyIgnitionAndCutoff)は
  // 次の update() まで燃料消費を反映できないため、点火直後だけ燃料無制限の値で仮置きする。
  private pendingAccel = 0;
  private thrustGateOpen = false;

  constructor(private readonly hud: Hud) {}

  // 実フレームごとに姿勢整列・出力段選択・燃料消費込みの推力量を求める。'powered' でない、
  // ノードが無い、死亡していれば待機へ戻す。点火・遮断そのものは applyIgnitionAndCutoff が
  // simTime のイベント境界で行う(フレームレートに依らせないため)。
  update(ship: Player, dt: number, simSpeed: SimSpeedManager): void {
    this.thrustGateOpen = simSpeed.canPlayerThrust;
    const node = ship.plan.firstNode();
    if (ship.planExecution !== 'powered' || !ship.alive || !node) {
      this.reset(ship);
      return;
    }
    if (node.t !== this.targetNodeT) {
      this.targetNodeT = node.t;
      this.phase = 'idle';
      this.burnDirWorld = null;
    }

    // 燃焼中は姿勢を追随させず、出力段の見直しだけを行う。
    if (this.phase === 'burn' || this.phase === 'trim') {
      this.updateBurnOutput(ship, node, dt);
      return;
    }

    // 目標Δvが実質無ければ整列不要でそのまま消化する。
    const dv = sub(node.v, ship.state.v);
    const dvMag = len(dv);
    if (dvMag < C.PLAN_EXECUTOR_DV_EPS) {
      this.finish(ship, node);
      return;
    }
    // 目標方向へ機首を向けるPD整列トルクをかけ、誤差角が閾値内なら点火待ちへ進める。
    ship.torque = attitudeAlignTorque(norm(dv), ship.state.r, ship.att, C.PROGRADE_HOLD_KP, C.PROGRADE_HOLD_KD);
    const err = attitudeAlignError(norm(dv), ship.state.r, ship.att.q);
    const errDeg = err ? (Math.abs(err.angle) * 180) / Math.PI : 180;
    this.phase = errDeg <= C.PLAN_EXECUTOR_ARM_ANGLE_DEG ? 'armed' : 'slew';
  }

  // 残り射影から出力段(全開/トリム)を選び、燃料消費込みの加速度を pendingAccel へ求め直す。
  // ゲートが閉じている(高warp)間は実際に噴射しないので燃料も消費しない。
  private updateBurnOutput(ship: Player, node: KinematicState, dt: number): void {
    const remaining = burnCutoffProjection(node.v, ship.state.v, this.burnDirWorld!);
    this.phase = remaining < C.PLAN_EXECUTOR_TRIM_DV ? 'trim' : 'burn';
    if (!this.thrustGateOpen) return;
    // 出力段はTHROTTLE_LEVELSの最大値に対する比として噴射加速度へ掛ける。
    const maxLevel = C.THROTTLE_LEVELS[C.THROTTLE_LEVELS.length - 1]!;
    const level = this.phase === 'trim' ? C.THROTTLE_LEVELS[0]! : maxLevel;
    const presetScale = level / maxLevel;
    const maxAccel = ship.mass > 0 ? ship.totalThrust / ship.mass : 0;
    const ratio = ship.consumeFuel(ship.totalFuelConsumptionRate * presetScale * dt);
    this.pendingAccel = maxAccel * presetScale * ratio;
    if (this.pendingAccel <= 0) {
      ship.planExecution = 'off';
      this.reset(ship);
      this.hud.hint('燃料切れのため軌道計画の自動実行を中止した');
    }
  }

  // Simulator の substep 境界(Stage.applySimulationEvents)ごとに呼ぶ。armed→burn の点火と、
  // 射影が0を切った時点の遮断を simTime ちょうどで行う。
  applyIgnitionAndCutoff(ship: Player, simTime: number): void {
    if (ship.planExecution !== 'powered') return;
    const node = ship.plan.firstNode();
    if (!node) return;

    // armed: 点火予定時刻に達していれば、そのときの速度差方向をECI固定の噴射方向として点火する。
    if (this.phase === 'armed') {
      const dv = sub(node.v, ship.state.v);
      const dvMag = len(dv);
      if (dvMag < C.PLAN_EXECUTOR_DV_EPS) {
        this.finish(ship, node);
        return;
      }
      const accel = ship.mass > 0 ? ship.totalThrust / ship.mass : 0;
      const ignition = ignitionTimeFor(node.t, dvMag, accel);
      if (simTime + 1e-9 < ignition || !this.thrustGateOpen) return;
      this.burnDirWorld = norm(dv);
      this.pendingAccel = accel;
      this.phase = 'burn';
    }
    if (this.phase !== 'burn' && this.phase !== 'trim') return;

    // burn/trim: 射影が0を切ったら遮断。ゲートが閉じている間は推力だけ止め、フェーズは保持する。
    const dir = this.burnDirWorld!;
    if (burnCutoffProjection(node.v, ship.state.v, dir) <= 0) {
      this.finish(ship, node);
      return;
    }
    ship.thrust = this.thrustGateOpen ? scale(dir, this.pendingAccel) : null;
  }

  // 点火予定時刻(armed 中)または遮断予定時刻(burn/trim 中)。フレームレートに依らず
  // simTime のイベント境界へちょうど乗せるため、Simulator の substep 分割はこれを参照する。
  // 現在の速度差・出力から毎回引き直すので、燃焼が進むほど遮断予定は正確に収束する。
  nextEventTime(ship: Player, simTime: number): number | null {
    if (ship.planExecution !== 'powered') return null;
    const node = ship.plan.firstNode();
    if (!node) return null;

    if (this.phase === 'armed') {
      const dvMag = len(sub(node.v, ship.state.v));
      const accel = ship.mass > 0 ? ship.totalThrust / ship.mass : 0;
      const t = ignitionTimeFor(node.t, dvMag, accel);
      return t >= simTime ? t : null;
    }
    if ((this.phase === 'burn' || this.phase === 'trim') && this.burnDirWorld) {
      const remaining = burnCutoffProjection(node.v, ship.state.v, this.burnDirWorld);
      if (remaining <= 0) return simTime;
      if (this.pendingAccel <= 0) return null;
      return simTime + remaining / this.pendingAccel;
    }
    return null;
  }

  // ノードを消化し、アンカーを(node の理想値ではなく)実際の到達状態へ追従させたうえで
  // 残差 Δv を1回だけ報告する。
  private finish(ship: Player, node: KinematicState): void {
    ship.thrust = null;
    const residual = len(sub(node.v, ship.state.v));
    this.hud.hint(`マニューバ自動実行完了(残差Δv ${residual.toFixed(1)} m/s)`);
    ship.plan.dropNodesBefore(node.t);
    ship.plan.trackAnchor(ship.state);
    this.phase = 'idle';
    this.burnDirWorld = null;
    this.targetNodeT = null;
  }

  // 待機状態(idle)へ戻し、進行中の噴射・トルクを止める。既に idle なら何もしない。
  private reset(ship: Player): void {
    if (this.phase === 'idle') return;
    ship.thrust = null;
    this.phase = 'idle';
    this.burnDirWorld = null;
    this.targetNodeT = null;
  }
}
