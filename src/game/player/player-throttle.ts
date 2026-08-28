// プレイヤーの並進スロットル・姿勢制御(RCS)・プログレードホールド。
import { Attitude, attitudeAlignTorque, qRotate } from '../../physics/attitude';
import { Vec3, add, norm, scale, v3 } from '../../math/vec3';
import * as C from '../const';
import { Input } from '../input/input';
import { KEY_MAPPING as K, KeyBinding } from '../input/key-mapping';
import { Hud } from '../hud/hud';
import type { ThrottleSaveData } from '../save/save-data';
import type { Controllable } from '../game-entity/controllable';

// 並進6方向の連打ラッチ判定対象キー一覧。
const THRUST_KEYS: readonly KeyBinding[] = [K.thrustForward, K.thrustBackward, K.thrustLeft, K.thrustRight, K.thrustUp, K.thrustDown];

// 各キーの反対方向キー。片方をラッチした状態でもう片方を押すと axX/Y/Z が
// 打ち消し合って噴射が止まってしまうため、押下エッジで反対方向のラッチを解除する。
const OPPOSITE_THRUST_KEY: ReadonlyMap<string, KeyBinding> = new Map<string, KeyBinding>([
  [K.thrustForward.code, K.thrustBackward],
  [K.thrustBackward.code, K.thrustForward],
  [K.thrustLeft.code, K.thrustRight],
  [K.thrustRight.code, K.thrustLeft],
  [K.thrustUp.code, K.thrustDown],
  [K.thrustDown.code, K.thrustUp],
]);

// 対になる3軸(前後/左右/上下)。いずれか1組を同時押しすると全軸の噴射を緊急停止する。
const THRUST_AXIS_PAIRS: readonly (readonly [KeyBinding, KeyBinding])[] = [
  [K.thrustForward, K.thrustBackward],
  [K.thrustLeft, K.thrustRight],
  [K.thrustUp, K.thrustDown],
];

// 3組のいずれかが同時押しされているか。
function isThrustKillSwitchActive(input: Input): boolean {
  return THRUST_AXIS_PAIRS.some(([a, b]) => input.down(a) && input.down(b));
}

export class PlayerThrottle {
  rcsDamp = true;
  throttleIdx = C.THROTTLE_DEFAULT_IDX;
  progradeHold = true;
  thrustAccelVec: Vec3 = v3();

  private rotationHoldTime = 0;
  // ラッチ中の並進キー(code 単位)。連打で追加/削除する。
  private readonly latchedThrustKeys = new Set<string>();
  private readonly lastThrustPressTime: Partial<Record<string, number>> = {};

  constructor(private readonly _hud: Hud, saved?: ThrottleSaveData) {
    if (saved) {
      this.throttleIdx = saved.throttleIdx;
      this.rcsDamp = saved.rcsDamp ?? true;
      this.progradeHold = saved.progradeHold ?? true;
    }
  }

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
    this.stopThrust();
    this.latchedThrustKeys.clear();
    for (const key of Object.keys(this.lastThrustPressTime)) delete this.lastThrustPressTime[key];
  }

  // 推力ゼロの状態へ戻す。噴射が実際に無い(または許可されない)ときの唯一の入口
  // (プルーム・エンジン音は ThrustEffects.sync が ship.thrust を直接見て毎フレーム同期する)。
  stopThrust(): void {
    this.thrustAccelVec = v3();
  }

  serialize(): ThrottleSaveData {
    return { throttleIdx: this.throttleIdx, rcsDamp: this.rcsDamp, progradeHold: this.progradeHold };
  }

  // 入力から機体座標系の推力加速度を組み立てて返す。入力が無ければ null。
  // ベルト物理が使う推力加速度の表示用状態も併せて更新する。
  updateThrustState(input: Input, att: Attitude, simDt: number, ship: Controllable): Vec3 | null {
    const thrust = this.buildThrust(input, att.q, ship, simDt);
    if (!thrust) {
      this.stopThrust();
      return null;
    }
    this.thrustAccelVec = thrust;
    return thrust;
  }

  // 並進キーを短時間内に連打するとラッチ集合へ追加/削除する(押しっぱなし相当の維持/解除)。
  // 反対方向キーを物理的に押している間は、そのラッチを外し続ける(片方をラッチしたまま
  // 逆方向を押しっぱなしにしても axX/Y/Z の相殺で終わらせず、逆方向を離した瞬間に
  // ラッチが復活するのを防ぐ)。連打の間隔は実時間で測るので、呼ばれないフレームを
  // 挟んでも判定が狂わない。緊急停止(3軸いずれかの対キー同時押し)中は全ラッチを外し、
  // 連打判定そのものを行わない。
  updateThrustLatches(input: Input): void {
    if (isThrustKillSwitchActive(input)) {
      this.latchedThrustKeys.clear();
      for (const key of Object.keys(this.lastThrustPressTime)) delete this.lastThrustPressTime[key];
      return;
    }
    const now = performance.now() / 1000;
    for (const key of THRUST_KEYS) {
      const opposite = OPPOSITE_THRUST_KEY.get(key.code);
      if (opposite && input.down(key)) this.latchedThrustKeys.delete(opposite.code);

      // 押しっぱなしの keydown リピートを2打目と誤検出しないよう、エッジ(takeKey)だけを見る。
      if (!input.takeKey(key)) continue;
      const last = this.lastThrustPressTime[key.code];
      this.lastThrustPressTime[key.code] = now;
      if (last === undefined || now - last > C.THRUST_LATCH_DOUBLE_TAP_SEC) continue;
      if (this.latchedThrustKeys.has(key.code)) this.latchedThrustKeys.delete(key.code);
      else this.latchedThrustKeys.add(key.code);
      delete this.lastThrustPressTime[key.code];
    }
  }

  // 物理的な押下、またはラッチ中であれば true。
  private isThrustHeld(input: Input, key: KeyBinding): boolean {
    return input.down(key) || this.latchedThrustKeys.has(key.code);
  }

  // key に対応する並進キーがラッチ中かどうかを返す(タッチパッドの点灯表示用)。
  isThrustLatched(key: KeyBinding): boolean {
    return this.latchedThrustKeys.has(key.code);
  }

  // 6方向の並進入力から機体座標系の推力加速度ベクトルを求める。入力が無ければ null。
  private buildThrust(input: Input, q: Attitude['q'], ship: Controllable, simDt: number): Vec3 | null {
    if (isThrustKillSwitchActive(input)) return null;
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
    const consumption = ship.totalFuelConsumptionRate * presetScale * simDt;
    const actualRatio = ship.consumeFuel(consumption);
    thrustAccel *= actualRatio;
    
    if (thrustAccel <= 0) return null;

    const dir = norm(v3(axX, axY, axZ));
    return qRotate(q, scale(dir, thrustAccel));
  }

  // 手動回転キー(ピッチ/ヨー/ロール)がいずれか押されているか。
  hasManualRotationInput(input: Input): boolean {
    return input.down(K.pitchDown) || input.down(K.pitchUp)
      || input.down(K.yawLeft) || input.down(K.yawRight)
      || input.down(K.rollRight) || input.down(K.rollLeft);
  }

  // 手動回転・RCS制動・プログレードホールドを合成したボディフレームトルクを返す。
  // r/v は軌道の位置・速度で、プログレードホールドの目標姿勢(進行方向)を組むのに使う。
  // 時計を2つ取る: 出力ランプは「キーを何秒握ったか」という操作感の量なので実時間 dt、
  // 燃料消費はトルクが積分されるぶんに比例する物理量なのでシミュレーション時間 simDt。
  updateTorque(
    att: Attitude,
    r: Vec3,
    v: Vec3,
    input: Input,
    fineAttitude: boolean,
    dt: number,
    simDt: number,
    ship: Controllable,
    onProgradeHoldReleased: () => void,
  ): Vec3 {
    const inertia = att.inertia;
    const inX = (input.down(K.pitchDown) ? 1 : 0) + (input.down(K.pitchUp) ? -1 : 0);
    const inY = (input.down(K.yawLeft) ? 1 : 0) + (input.down(K.yawRight) ? -1 : 0);
    const inZ = (input.down(K.rollRight) ? 1 : 0) + (input.down(K.rollLeft) ? -1 : 0);

    // 回転指令があればプログレードホールドを解除する
    const isRotating = inX !== 0 || inY !== 0 || inZ !== 0;
    this.rotationHoldTime = isRotating ? this.rotationHoldTime + dt : 0;
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
      const consumption = ship.totalFuelConsumptionRate * rotateIntensity * rcsOutputFactor * angScale * simDt;
      const actualRatio = ship.consumeFuel(consumption);
      maxAngAccel *= actualRatio;
    }
    
    const manualTorque = v3(
      inX * maxAngAccel * inertia.x,
      inY * maxAngAccel * inertia.y,
      inZ * maxAngAccel * inertia.z,
    );

    // 無入力かつホールド中なら自動整列トルクを加える(機首をプログレード v、上方向を r へ)
    if (this.progradeHold && inX === 0 && inY === 0 && inZ === 0) {
      return add(manualTorque, attitudeAlignTorque(v, r, att, C.PROGRADE_HOLD_KP, C.PROGRADE_HOLD_KD));
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
}
