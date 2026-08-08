// プレイヤーの並進スロットル・姿勢制御(RCS)・プログレードホールド。
import * as THREE from 'three/webgpu';
import { Attitude, qFromForwardUp, qRotate } from '../../physics/attitude';
import { Vec3, add, norm, scale, v3 } from '../../physics/vec3';
import * as C from '../const';
import { Input } from '../input/input';
import { KEY_MAPPING as K, KeyBinding } from '../input/key-mapping';
import { Hud } from '../hud/hud';
import { Sfx } from '../../audio/sfx';
import { SimSpeedManager } from '../sim-speed-manager';
import type { ThrottleSaveData } from '../save-data';

// 並進6方向の連打ラッチ判定対象キー一覧。
const THRUST_KEYS: readonly KeyBinding[] = [K.thrustForward, K.thrustBackward, K.thrustLeft, K.thrustRight, K.thrustUp, K.thrustDown];

export class PlayerThrottle {
  rcsDamp = true;
  throttleIdx = C.THROTTLE_DEFAULT_IDX;
  progradeHold = true;
  thrustVizDir: Vec3 | null = null;
  thrustAccelVec: Vec3 = v3();

  private rotationHoldTime = 0;
  // ラッチ中の並進キー(code 単位)。連打で追加/削除する。
  private readonly latchedThrustKeys = new Set<string>();
  private readonly lastThrustPressTime: Partial<Record<string, number>> = {};
  private thrustClock = 0;

  constructor(
    private readonly _hud: Hud,
    private readonly _sfx: Sfx,
  ) {}

  // RCS 回転制動の ON/OFF を切り替える。
  toggleRcsDamp(): void {
    this.rcsDamp = !this.rcsDamp;
    this._hud.hint(`RCS 回転制動: ${this.rcsDamp ? 'ON' : 'OFF'}`);
  }

  // プログレードホールドを ON にする。
  enableProgradeReset(): void {
    this.progradeHold = true;
    this._hud.hint('プログレード姿勢リセット(機首を進行方向へ)');
  }

  // プログレードホールドの ON/OFF を切り替える。
  toggleProgradeHold(): void {
    this.progradeHold = !this.progradeHold;
    this._hud.hint(`進行方向ホールド: ${this.progradeHold ? 'ON (機首をプログレードへ保持)' : 'OFF'}`);
  }

  // 並進出力のプリセットを idx 段階目へ切り替える。
  setThrottlePreset(idx: number): void {
    this.throttleIdx = idx;
    this._hud.hint(`並進出力: ${C.THROTTLE_LABELS[idx]!} (${C.THROTTLE_LEVELS[idx]!.toFixed(1)} m/s²)`);
  }

  // スラスト方向の表示用状態と噴射ラッチを初期化する。
  clearTransientState(): void {
    this.thrustVizDir = null;
    this.thrustAccelVec = v3();
    this.latchedThrustKeys.clear();
  }

  serialize(): ThrottleSaveData {
    return { throttleIdx: this.throttleIdx };
  }

  restore(data: ThrottleSaveData): void {
    this.throttleIdx = data.throttleIdx;
  }

  // 入力から機体座標系の推力加速度を組み立てて返す。warp 中などで噴射不可なら null。
  // SFX とスラスト方向の表示用状態も併せて更新する。
  updateThrustState(input: Input, simSpeed: SimSpeedManager, att: Attitude, dt: number, ship: import('../game-entity/ship').Ship): Vec3 | null {
    this.updateThrustLatches(input, dt);
    const thrust = this.buildThrust(input, att.q, ship, dt);
    // 噴射不可、または入力が無ければ噴射音・表示を止めて終える
    if (!simSpeed.canPlayerThrust || !thrust) {
      this._sfx.setThrust(false);
      this.thrustAccelVec = v3();
      this.thrustVizDir = null;
      return null;
    }

    // 噴射中の状態を保持する
    this._sfx.setThrust(true);
    this.thrustAccelVec = thrust;
    this.thrustVizDir = norm(this.thrustAccelVec);
    return thrust;
  }

  // 並進キーを短時間内に連打するとラッチ集合へ追加/削除する(押しっぱなし相当の維持/解除)。
  private updateThrustLatches(input: Input, dt: number): void {
    this.thrustClock += dt;
    for (const key of THRUST_KEYS) {
      // 押しっぱなしの keydown リピートを2打目と誤検出しないよう、エッジ(takeKey)だけを見る。
      if (!input.takeKey(key)) continue;
      const last = this.lastThrustPressTime[key.code];
      this.lastThrustPressTime[key.code] = this.thrustClock;
      if (last === undefined || this.thrustClock - last > C.THRUST_LATCH_DOUBLE_TAP_SEC) continue;
      if (this.latchedThrustKeys.has(key.code)) this.latchedThrustKeys.delete(key.code);
      else this.latchedThrustKeys.add(key.code);
      delete this.lastThrustPressTime[key.code];
    }
  }

  // 物理的な押下、またはラッチ中であれば true。
  private isThrustHeld(input: Input, key: KeyBinding): boolean {
    return input.down(key) || this.latchedThrustKeys.has(key.code);
  }

  // 6方向の並進入力から機体座標系の推力加速度ベクトルを求める。入力が無ければ null。
  private buildThrust(input: Input, q: Attitude['q'], ship: import('../game-entity/ship').Ship, dt: number): Vec3 | null {
    const axX = (this.isThrustHeld(input, K.thrustLeft) ? 1 : 0) + (this.isThrustHeld(input, K.thrustRight) ? -1 : 0);
    const axY = (this.isThrustHeld(input, K.thrustUp) ? 1 : 0) + (this.isThrustHeld(input, K.thrustDown) ? -1 : 0);
    const axZ = (this.isThrustHeld(input, K.thrustForward) ? 1 : 0) + (this.isThrustHeld(input, K.thrustBackward) ? -1 : 0);
    if (axX === 0 && axY === 0 && axZ === 0) return null;

    // 全開加速度は推力/質量で決まる。スロットル段は THROTTLE_LEVELS の最大値に対する
    // 比としてそこへ掛けるので、既定パーツの艦では表示値(THROTTLE_LEVELS)と実加速度が一致する。
    const maxAccel = ship.mass > 0 ? ship.totalThrust / ship.mass : 0;
    const presetScale = C.THROTTLE_LEVELS[this.throttleIdx]! / C.THROTTLE_LEVELS[C.THROTTLE_LEVELS.length - 1]!;
    let thrustAccel = maxAccel * presetScale;

    // 燃料残量に応じて実際の加速度を絞る
    const consumption = ship.totalFuelConsumptionRate * presetScale * dt;
    const actualRatio = ship.consumeFuel(consumption);
    thrustAccel *= actualRatio;
    
    if (thrustAccel <= 0) return null;

    const dir = norm(v3(axX, axY, axZ));
    return qRotate(q, scale(dir, thrustAccel));
  }

  // 手動回転・RCS制動・プログレードホールドを合成したボディフレームトルクを返す。
  // r/v は軌道の位置・速度で、プログレードホールドの目標姿勢(進行方向)を組むのに使う。
  updateTorque(
    att: Attitude,
    r: Vec3,
    v: Vec3,
    alive: boolean,
    input: Input,
    fineAttitude: boolean,
    attDt: number,
    ship: import('../game-entity/ship').Ship,
    onProgradeHoldReleased: () => void,
  ): Vec3 {
    if (!alive) return v3();
    const inertia = att.inertia;
    const inX = (input.down(K.pitchDown) ? 1 : 0) + (input.down(K.pitchUp) ? -1 : 0);
    const inY = (input.down(K.yawLeft) ? 1 : 0) + (input.down(K.yawRight) ? -1 : 0);
    const inZ = (input.down(K.rollRight) ? 1 : 0) + (input.down(K.rollLeft) ? -1 : 0);

    // 回転指令があればプログレードホールドを解除する
    const isRotating = inX !== 0 || inY !== 0 || inZ !== 0;
    this.rotationHoldTime = isRotating ? this.rotationHoldTime + attDt : 0;
    if (this.progradeHold && isRotating) {
      this.progradeHold = false;
      onProgradeHoldReleased();
    }

    // 保持時間に応じてRCS出力を増強しつつ手動トルクを組む
    const rcsOutputFactor =
      C.RCS_MANUAL_OUTPUT_MIN +
      C.RCS_MANUAL_OUTPUT_RAMP *
      (Math.min(C.RCS_MANUAL_RAMP_TIME, this.rotationHoldTime) / C.RCS_MANUAL_RAMP_TIME);
      
    const baseAngAccel = ship.totalTorque > 0
      ? ship.totalTorque / Math.max(inertia.x, inertia.y, inertia.z)
      : C.MAX_ANG_ACCEL;

    const angScale = fineAttitude ? C.FINE_ATTITUDE_SCALE : 1;
    let maxAngAccel = baseAngAccel * angScale * rcsOutputFactor;

    // 燃料残量に応じて実際の角加速度を絞る
    const rotateIntensity = Math.max(Math.abs(inX), Math.abs(inY), Math.abs(inZ));
    if (rotateIntensity > 0) {
      const consumption = ship.totalFuelConsumptionRate * rotateIntensity * rcsOutputFactor * angScale * attDt;
      const actualRatio = ship.consumeFuel(consumption);
      maxAngAccel *= actualRatio;
    }
    
    const manualTorque = v3(
      inX * maxAngAccel * inertia.x,
      inY * maxAngAccel * inertia.y,
      inZ * maxAngAccel * inertia.z,
    );

    // 無入力かつホールド中なら自動整列トルクを加える
    if (this.progradeHold && inX === 0 && inY === 0 && inZ === 0) {
      return add(manualTorque, this.autoAlignTorque(v, r, att, inertia));
    }
    // 無入力の軸だけRCS制動を掛ける
    if (this.rcsDamp) {
      return v3(
        manualTorque.x - (inX === 0 ? C.RCS_DAMP_RATE * inertia.x * att.w.x : 0),
        manualTorque.y - (inY === 0 ? C.RCS_DAMP_RATE * inertia.y * att.w.y : 0),
        manualTorque.z - (inZ === 0 ? C.RCS_DAMP_RATE * inertia.z * att.w.z : 0),
      );
    }
    return manualTorque;
  }


  // desiredFwd/desiredUp へ機首を向けるPD制御トルクをボディフレームで返す。
  // 特異姿勢(desiredFwd と desiredUp が平行)なら制御せず v3() を返す。
  private autoAlignTorque(desiredFwd: Vec3, desiredUp: Vec3, att: Attitude, inertia: Vec3): Vec3 {
    // 目標姿勢を forward/up から組む
    const qd = qFromForwardUp(desiredFwd, desiredUp);
    if (!qd) return v3();
    const qDesired = new THREE.Quaternion(qd.x, qd.y, qd.z, qd.w);
    const qCurrent = new THREE.Quaternion(att.q.x, att.q.y, att.q.z, att.q.w);
    const qCurInv = qCurrent.clone().invert();
    // 現在姿勢との誤差回転を角度と軸に分解する
    const qErr = qDesired.multiply(qCurInv);
    const w = Math.max(-1, Math.min(1, qErr.w));
    let angle = 2 * Math.acos(w);
    if (angle > Math.PI) angle -= 2 * Math.PI;
    const s = Math.sqrt(Math.max(0, 1 - w * w));
    const axisWorld =
      s > 1e-6 ? new THREE.Vector3(qErr.x / s, qErr.y / s, qErr.z / s) : new THREE.Vector3(1, 0, 0);
    const axisShip = axisWorld.applyQuaternion(qCurInv);
    // 誤差角と角速度ダンピングから軸ごとのPDトルクを組む
    return v3(
      (C.PROGRADE_HOLD_KP * angle * axisShip.x - C.PROGRADE_HOLD_KD * att.w.x) * inertia.x,
      (C.PROGRADE_HOLD_KP * angle * axisShip.y - C.PROGRADE_HOLD_KD * att.w.y) * inertia.y,
      (C.PROGRADE_HOLD_KP * angle * axisShip.z - C.PROGRADE_HOLD_KD * att.w.z) * inertia.z,
    );
  }
}
