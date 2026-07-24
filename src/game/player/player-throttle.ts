// プレイヤーの並進スロットル・姿勢制御(RCS)・プログレードホールド。
// 機体の位置・姿勢そのもの(OrbitState/Attitude)は player.ts が所有し、ここには
// 呼び出しごとに引数として渡す — 正データの二重管理を避けるため。
import * as THREE from 'three/webgpu';
import { Attitude, qFromForwardUp, qRotate } from '../../physics/attitude';
import { ExtraAccel, OrbitState } from '../../physics/orbital';
import { Vec3, len, norm, scale, v3 } from '../../physics/vec3';
import * as C from '../const';
import { Input } from '../input/input';
import { Hud } from '../hud/hud';
import { Sfx } from '../../audio/sfx';
import { SimSpeedManager } from '../sim-speed-manager';

export class PlayerThrottle {
  rcsDamp = true;
  throttleIdx = C.THROTTLE_DEFAULT_IDX;
  progradeHold = true;
  thrustVizDir: Vec3 | null = null;
  thrustAccelVec: Vec3 = v3();

  private rotationHoldTime = 0;

  constructor(
    private readonly _hud: Hud,
    private readonly _sfx: Sfx,
  ) {}

  toggleRcsDamp(): void {
    this.rcsDamp = !this.rcsDamp;
    this._hud.hint(`RCS 回転制動: ${this.rcsDamp ? 'ON' : 'OFF'}`);
  }

  enableProgradeReset(): void {
    this.progradeHold = true;
    this._hud.hint('プログレード姿勢リセット(機首を進行方向へ)');
  }

  toggleProgradeHold(): void {
    this.progradeHold = !this.progradeHold;
    this._hud.hint(`進行方向ホールド: ${this.progradeHold ? 'ON (機首をプログレードへ保持)' : 'OFF'}`);
  }

  setThrottlePreset(idx: number): void {
    this.throttleIdx = idx;
    const labels = ['弱', '中', '強'] as const;
    this._hud.hint(`並進出力: ${labels[idx]!} (${C.THROTTLE_LEVELS[idx]!.toFixed(1)} m/s²)`);
  }

  clearTransientState(): void {
    this.thrustVizDir = null;
    this.thrustAccelVec = v3();
  }

  updateThrustState(input: Input, simSpeed: SimSpeedManager, att: Attitude, state: OrbitState): ExtraAccel | null {
    const thrustFn = this.buildThrustAccel(input, att.q);
    if (!simSpeed.canPlayerThrust || !thrustFn) {
      this._sfx.setThrust(false);
      this.thrustAccelVec = v3();
      this.thrustVizDir = null;
      return null;
    }

    this._sfx.setThrust(true);
    this.thrustAccelVec = thrustFn(state.r, state.v);
    this.thrustVizDir = norm(this.thrustAccelVec);
    return thrustFn;
  }

  private buildThrustAccel(input: Input, q: Attitude['q']): ExtraAccel | null {
    const axX = (input.down('KeyA') ? 1 : 0) + (input.down('KeyD') ? -1 : 0);
    const axY = (input.down('KeyQ') ? 1 : 0) + (input.down('KeyE') ? -1 : 0);
    const axZ =
      (input.down('KeyW') || input.down('ControlLeft') || input.down('ControlRight') ? 1 : 0) +
      (input.down('KeyS') || input.down('ShiftLeft') || input.down('ShiftRight') ? -1 : 0);
    if (axX === 0 && axY === 0 && axZ === 0) return null;

    const thrustAccel = C.THROTTLE_LEVELS[this.throttleIdx]!;
    return (): Vec3 => {
      const dir = norm(v3(axX, axY, axZ));
      return qRotate(q, scale(dir, thrustAccel));
    };
  }

  // 入力から機体座標系トルクを算出して返すだけ。姿勢積分(stepAttitude)は
  // simulator が一元的に行う(entity.torque を毎フレーム書き込む経路に統一するため)。
  updateTorque(
    att: Attitude,
    r: Vec3,
    v: Vec3,
    alive: boolean,
    input: Input,
    editMode: boolean,
    fineAttitude: boolean,
    attDt: number,
    onProgradeHoldReleased: () => void,
  ): Vec3 {
    if (!alive) return v3();
    const inertia = att.inertia;
    // 計画編集モード中は手動姿勢入力を無効化する(WASDQE などが Δv 編集に振り替わるため)。
    const manual = editMode ? 0 : 1;
    const inX = ((input.down('KeyI') ? 1 : 0) + (input.down('KeyK') ? -1 : 0)) * manual;
    const inY = ((input.down('KeyL') ? 1 : 0) + (input.down('KeyJ') ? -1 : 0)) * manual;
    const inZ = ((input.down('KeyO') ? 1 : 0) + (input.down('KeyU') ? -1 : 0)) * manual;

    const isRotating = inX !== 0 || inY !== 0 || inZ !== 0;
    this.rotationHoldTime = isRotating ? this.rotationHoldTime + attDt : 0;
    if (this.progradeHold && isRotating) {
      this.progradeHold = false;
      onProgradeHoldReleased();
    }

    const rcsOutputFactor =
      C.RCS_MANUAL_OUTPUT_MIN +
      C.RCS_MANUAL_OUTPUT_RAMP *
      (Math.min(C.RCS_MANUAL_RAMP_TIME, this.rotationHoldTime) / C.RCS_MANUAL_RAMP_TIME);
    const angScale = fineAttitude ? C.FINE_ATTITUDE_SCALE : 1;
    const maxAngAccel = C.MAX_ANG_ACCEL * angScale * rcsOutputFactor;
    const torque = v3(
      inX * maxAngAccel * inertia.x,
      inY * maxAngAccel * inertia.y,
      inZ * maxAngAccel * inertia.z,
    );

    if (this.progradeHold && inX === 0 && inY === 0 && inZ === 0) {
      const auto = this.autoAlignTorque(v, r, att, inertia);
      torque.x += auto.x;
      torque.y += auto.y;
      torque.z += auto.z;
    } else if (this.rcsDamp) {
      if (inX === 0) torque.x -= C.RCS_DAMP_RATE * inertia.x * att.w.x;
      if (inY === 0) torque.y -= C.RCS_DAMP_RATE * inertia.y * att.w.y;
      if (inZ === 0) torque.z -= C.RCS_DAMP_RATE * inertia.z * att.w.z;
    }

    // 本来は torque を積分した後の角速度を clamp すべきだが、積分後の角速度はまだここでは未知なので、
    // 積分前の角速度を使って clamp する。積分後の角速度が clamp を超える場合は、次フレームでだいたい clamp される。
    this.clampAngularVelocity(att, fineAttitude);

    return torque;
  }

  // 手動回転の角速度上限(fineAttitude で縮小)。stepAttitude による姿勢積分後に
  // 呼ばれる想定 — updateTorque はトルク算出のみに専念するため、ここで分離している。
  private clampAngularVelocity(att: Attitude, fineAttitude: boolean): void {
    const maxAngVel = C.MAX_ANG_VEL * (fineAttitude ? C.FINE_ATTITUDE_SCALE : 1);
    const wMag = len(att.w);
    if (wMag > maxAngVel) att.w = scale(att.w, maxAngVel / wMag);
  }

  private autoAlignTorque(desiredFwd: Vec3, desiredUp: Vec3, att: Attitude, inertia: Vec3): Vec3 {
    const qd = qFromForwardUp(desiredFwd, desiredUp);
    if (!qd) return v3();
    const qDesired = new THREE.Quaternion(qd.x, qd.y, qd.z, qd.w);
    const qCurrent = new THREE.Quaternion(att.q.x, att.q.y, att.q.z, att.q.w);
    const qCurInv = qCurrent.clone().invert();
    const qErr = qDesired.multiply(qCurInv);
    const w = Math.max(-1, Math.min(1, qErr.w));
    let angle = 2 * Math.acos(w);
    if (angle > Math.PI) angle -= 2 * Math.PI;
    const s = Math.sqrt(Math.max(0, 1 - w * w));
    const axisWorld =
      s > 1e-6 ? new THREE.Vector3(qErr.x / s, qErr.y / s, qErr.z / s) : new THREE.Vector3(1, 0, 0);
    const axisBody = axisWorld.applyQuaternion(qCurInv);
    return v3(
      (C.PROGRADE_HOLD_KP * angle * axisBody.x - C.PROGRADE_HOLD_KD * att.w.x) * inertia.x,
      (C.PROGRADE_HOLD_KP * angle * axisBody.y - C.PROGRADE_HOLD_KD * att.w.y) * inertia.y,
      (C.PROGRADE_HOLD_KP * angle * axisBody.z - C.PROGRADE_HOLD_KD * att.w.z) * inertia.z,
    );
  }
}
