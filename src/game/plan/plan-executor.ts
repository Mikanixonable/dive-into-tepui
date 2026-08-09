// マニューバノードを実際に姿勢制御・エンジン噴射で実行する状態機械(Slew→Armed→Burn→Trim)。
// 噴射方向は点火時点の速度差から慣性系(ECI)固定で決め、燃焼中は姿勢を追随させない。
// Player が1隻に1つ所有し、'powered' の間だけ ship.torque/ship.thrust へ書く。
//
// Player/Hud/SimSpeedManager そのものではなく、ここで使う分だけを切り出した構造的な型
// (PlanExecutorShip/PlanExecutorHud/PlanExecutorSimSpeed)を受け取る — Player は THREE を
// 大量に引き込むクラスで、これをそのまま型として使うと plan-executor.ts が THREE/DOM 抜きで
// コンパイルできなくなり、tests/physics での状態機械テストが成立しない
// (plan.ts の DisplayDurationSource と同じ理由)。実際の呼び出し側は Player 自身を渡すだけで
// 構造的に一致する。
import { KinematicState } from '../../physics/kinematic-state';
import { Attitude, attitudeAlignError, attitudeAlignTorque } from '../../physics/attitude';
import { Vec3, len, scale, sub, v3 } from '../../physics/vec3';
import * as C from '../const';
import type { Plan } from './plan';
import { burnCutoffProjection, burnDurationFor, burnUpReference, ignitionTimeFor } from './plan-executor-math';

// 'off': ノードを消化しない。'instant': ノード時刻ちょうどで絶対状態へ乗り移る(瞬間移動)。
// 'powered': この PlanExecutor が姿勢制御・噴射で実行する。
export type PlanExecutionMode = 'off' | 'instant' | 'powered';

export interface PlanExecutorShip {
  state: KinematicState;
  att: Attitude;
  readonly alive: boolean;
  planExecution: PlanExecutionMode;
  readonly plan: Plan;
  readonly mass: number;
  readonly totalThrust: number;
  readonly totalFuelConsumptionRate: number;
  torque: Vec3;
  thrust: Vec3 | null;
  consumeFuel(amount: number): number;
}

export interface PlanExecutorHud {
  hint(text: string): void;
}

export interface PlanExecutorSimSpeed {
  readonly canPlayerThrust: boolean;
}

type Phase = 'idle' | 'slew' | 'armed' | 'burn' | 'trim';

export class PlanExecutor {
  private phase: Phase = 'idle';
  // 現在追っているノード。Plan のノードは編集のたび新しい KinematicState に差し替わる不変値
  // なので、同じ実行時刻を持つ新旧ノードを区別するには参照同一性で見る必要がある
  // (時刻だけで見ると、バーン中の Δv 編集を「同じノードのまま」と誤認してしまう)。
  private targetNode: KinematicState | null = null;
  // 点火時点に確定し、燃焼が終わるまで動かさない噴射方向・姿勢up基準(ともにECI固定)。
  private burnDirWorld: Vec3 | null = null;
  private burnUpWorld: Vec3 | null = null;
  // update() が求めた、燃料消費込みの現在の点火出力 [m/s^2]。点火の瞬間(applyIgnitionAndCutoff)は
  // 次の update() まで燃料消費を反映できないため、点火直後だけ燃料無制限の値で仮置きする。
  private pendingAccel = 0;
  private thrustGateOpen = false;

  constructor(private readonly hud: PlanExecutorHud) {}

  // 実フレームごとに姿勢整列・出力段選択・燃料消費込みの推力量を求め、ship.torque/ship.thrust へ
  // 書く。'powered' でない、ノードが無い、死亡していれば待機へ戻す。
  // ship.thrust はここでも書く(Player.behave より後に走るのはここだけなので、操作対象艦でも
  // behave の無条件 null 代入に上書きされたまま積分へ渡ってしまわないようにする)のに加え、
  // 点火・遮断の瞬間だけは applyIgnitionAndCutoff からも書く(simTime のイベント境界を跨いだ
  // 直後の残りサブステップにまで反映させるため)。
  update(ship: PlanExecutorShip, dt: number, simTime: number, simSpeed: PlanExecutorSimSpeed): void {
    this.thrustGateOpen = simSpeed.canPlayerThrust;
    const node = ship.plan.firstNode();
    if (ship.planExecution !== 'powered' || !ship.alive || !node) {
      this.reset(ship);
      return;
    }
    if (node !== this.targetNode) {
      this.reset(ship);
      this.targetNode = node;
    }

    // 燃焼中は姿勢を追随させず(点火時に確定した向きを保持するだけ)、出力段の見直しと
    // 推力の書き直しだけを行う。
    if (this.phase === 'burn' || this.phase === 'trim') {
      this.updateBurnOutput(ship, node, dt);
      return;
    }

    const dv = sub(node.v, ship.state.v);
    const dvMag = len(dv);
    const accel = ship.mass > 0 ? ship.totalThrust / ship.mass : 0;
    // ノード時刻からまだ遠ければ整列・点火判定そのものに入らない。周期軌道では「現在の速度が
    // たまたまノードの目標速度に近い」瞬間が1周前・2周前にも訪れうるので、dv の小ささだけで
    // 判定すると別の周回を今回のノードと誤認する — 実行時刻に対する猶予窓
    // (NODE_APPROACH_LEAD + 見積もり燃焼時間)で先に絞る。
    const approachWindow = C.NODE_APPROACH_LEAD + burnDurationFor(dvMag, accel);
    if (node.t - simTime > approachWindow) {
      ship.torque = v3();
      return;
    }

    // 目標Δvが実質無ければ整列不要でそのまま消化する。
    if (dvMag < C.PLAN_EXECUTOR_DV_EPS) {
      this.finish(ship, node);
      return;
    }
    // 目標方向へ機首を向けるPD整列トルクをかけ、誤差角が閾値内なら点火待ちへ進める。
    // up 基準は動径方向が既定だが、ラジアル方向のバーン(dv ∥ r)では特異になり qFromForwardUp が
    // 解けなくなるので、軌道面法線へフォールバックする(burnUpReference)。
    const fwd = scale(dv, 1 / dvMag);
    const up = burnUpReference(dv, ship.state);
    ship.torque = attitudeAlignTorque(fwd, up, ship.att, C.PROGRADE_HOLD_KP, C.PROGRADE_HOLD_KD);
    const err = attitudeAlignError(fwd, up, ship.att.q);
    const errDeg = err ? (Math.abs(err.angle) * 180) / Math.PI : 180;
    this.phase = errDeg <= C.PLAN_EXECUTOR_ARM_ANGLE_DEG ? 'armed' : 'slew';
  }

  // 燃焼中(burn/trim)の姿勢保持トルク・出力段・推力を求め直す。姿勢は点火時に確定した
  // burnDirWorld/burnUpWorld を保持し続けるだけで、目標そのものは動かさない。
  // ゲートが閉じている(高warp)間は実際に噴射しないので燃料は消費せず、推力も止める。
  private updateBurnOutput(ship: PlanExecutorShip, node: KinematicState, dt: number): void {
    const dir = this.burnDirWorld!;
    ship.torque = attitudeAlignTorque(dir, this.burnUpWorld!, ship.att, C.PROGRADE_HOLD_KP, C.PROGRADE_HOLD_KD);

    const remaining = burnCutoffProjection(node.v, ship.state.v, dir);
    this.phase = remaining < C.PLAN_EXECUTOR_TRIM_DV ? 'trim' : 'burn';
    if (!this.thrustGateOpen) {
      ship.thrust = null;
      return;
    }
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
      return;
    }
    ship.thrust = scale(dir, this.pendingAccel);
  }

  // Simulator の substep 境界(Stage.applySimulationEvents)ごとに呼ぶ。armed→burn の点火と、
  // 射影が0を切った時点の遮断を simTime ちょうどで行う。update() と同じ node/phase の前提を
  // 使うので、ここで初めて armed に入ることはない(その判定は update() 側の担当)。
  applyIgnitionAndCutoff(ship: PlanExecutorShip, simTime: number): void {
    if (ship.planExecution !== 'powered') return;
    const node = ship.plan.firstNode();
    if (!node || node !== this.targetNode) return;

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
      this.burnDirWorld = scale(dv, 1 / dvMag);
      this.burnUpWorld = burnUpReference(dv, ship.state);
      this.pendingAccel = accel;
      this.phase = 'burn';
      ship.torque = attitudeAlignTorque(this.burnDirWorld, this.burnUpWorld, ship.att, C.PROGRADE_HOLD_KP, C.PROGRADE_HOLD_KD);
      ship.thrust = scale(this.burnDirWorld, this.pendingAccel);
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
  // ゲートが閉じている間は着火も遮断も実際には起きないので null(実行されない時刻を返して
  // Simulator に無駄な精密ステップを刻ませない)。現在の速度差・出力から毎回引き直すので、
  // 燃焼が進むほど遮断予定は正確に収束する。
  nextEventTime(ship: PlanExecutorShip, simTime: number): number | null {
    if (ship.planExecution !== 'powered' || !this.thrustGateOpen) return null;
    const node = ship.plan.firstNode();
    if (!node || node !== this.targetNode) return null;

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

  // ノードを消化し、アンカーを(node の理想値ではなく)実際の到達状態へ差し替えたうえで
  // 残差 Δv を1回だけ報告する。overwriteAnchor は後続ノードが残っていても効くので、
  // 「実行後の誤差を残す」方針が後続ノードの有無によらず保たれる。
  private finish(ship: PlanExecutorShip, node: KinematicState): void {
    const residual = len(sub(node.v, ship.state.v));
    this.hud.hint(`マニューバ自動実行完了(残差Δv ${residual.toFixed(1)} m/s)`);
    ship.plan.dropNodesBefore(node.t);
    ship.plan.overwriteAnchor(ship.state);
    this.clearState(ship);
  }

  // 待機状態(idle)へ戻し、進行中の噴射・トルクを止める。既に idle なら何もしない。
  private reset(ship: PlanExecutorShip): void {
    if (this.phase === 'idle') return;
    this.clearState(ship);
  }

  // phase/burnDirWorld/targetNode を idle 相当へ戻し、ship.torque/thrust を明示的に消す —
  // ノードの差し替え・燃焼完了・燃料切れのどの経路でも、艦に指令が残ったまま放置されない
  // ようにする単一の後始末。
  private clearState(ship: PlanExecutorShip): void {
    ship.thrust = null;
    ship.torque = v3();
    this.phase = 'idle';
    this.burnDirWorld = null;
    this.burnUpWorld = null;
    this.targetNode = null;
  }
}
