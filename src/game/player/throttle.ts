// 操作対象の並進スロットル・姿勢制御(RCS)・プログレードホールド。
import type { Attitude } from '../../physics/attitude';
import { attitudeAlignTorque } from '../../physics/attitude';
import { qRotate } from '../../math/quat';
import type { Vec3 } from '../../math/vec3';
import { add, norm, scale, v3 } from '../../math/vec3';
import {
  OPPOSITE_THRUST_DIRECTION, THRUST_DIRECTIONS, thrustKillSwitchActive,
} from '../dynamic/dynamic-entity/pilot-controls';
import type { PilotControls, ThrustDirection } from '../dynamic/dynamic-entity/pilot-controls';
import type { RunEventSink } from '../run-events';
import type { FuelConsumer } from '../dynamic/dynamic-entity/controllable';

// 並進推力(全 6 方向で共通)の出力 4 段階の加速度 [m/s^2]。
export const THROTTLE_LEVELS = [5.0, 20.0, 100.0, 400.0];
export const THROTTLE_LABELS = ['弱', '中', '強', '最強'] as const;

const MAX_ANG_ACCEL = 1.4; // 操舵トルクを持たない個体に使う角加速度 [rad/s^2]
const THROTTLE_DEFAULT_IDX = 1;

const RCS_DAMP_RATE = 3.5; // RCS 回転制動の減衰係数 [1/s]

// 手動回転RCSの出力ランプ: 握り始めは MIN、RAMP_TIME 秒かけて (MIN + RAMP) まで増加する
const RCS_MANUAL_OUTPUT_MIN = 0.3;
const RCS_MANUAL_OUTPUT_RAMP = 1.0;
const RCS_MANUAL_RAMP_TIME = 3.0; // [s]

// 微調整モードで角加速度に掛ける倍率
const FINE_ATTITUDE_SCALE = 0.5;

// 進行方向ホールド: 機首をプログレードへ向けるオートパイロットの PD ゲイン
const PROGRADE_HOLD_KP = 3.2; // 姿勢誤差角に対する比例ゲイン
const PROGRADE_HOLD_KD = 2.6; // 角速度に対する減衰ゲイン

// 残量 available [kg] が要求 amount [kg] を賄える割合 [0, 1]。
function suppliedFuelRatio(available: number, amount: number): number {
  return amount <= 0 ? 1 : Math.min(available, amount) / amount;
}

export interface SerializedThrottle {
  readonly throttleIdx: number;
  readonly rcsDamp: boolean;
  readonly progradeHold: boolean;
  readonly rotationHoldTime: number;
  readonly latchedThrust: ThrustDirection[];
}

export class Throttle {
  // 直近の操作で出した並進の推力加速度(ECI)[m/s^2] と、機体座標系のトルク。操作量から毎フレーム
  // 求め直すキャッシュで、噴射していなければ推力は null。
  private _thrust: Vec3 | null = null;
  private _torque: Vec3 = v3();

  // ラッチ中の並進方向。押しっぱなしと同じに扱う。
  private readonly latchedThrust: Set<ThrustDirection>;

  // throttleIdx は THROTTLE_LEVELS の段、rotationHoldTime は手動回転を握り続けている実時間 [s]、
  // latchedThrust はラッチ中の並進方向。
  public constructor(
    private _throttleIdx = THROTTLE_DEFAULT_IDX,
    private _rcsDamp = true,
    private _progradeHold = true,
    private rotationHoldTime = 0,
    latchedThrust: readonly ThrustDirection[] = [],
  ) {
    this.latchedThrust = new Set(latchedThrust);
  }

  public get thrust(): Vec3 | null { return this._thrust; }
  public get torque(): Vec3 { return this._torque; }
  public get throttleIdx(): number { return this._throttleIdx; }
  public get rcsDamp(): boolean { return this._rcsDamp; }
  public get progradeHold(): boolean { return this._progradeHold; }

  // 直列化した段・制動・ホールド・回転の保持時間・噴射ラッチから復元する。壊れた値は既定へ落とし、
  // 知らない方向のラッチは捨てる。
  public static deserialize(serialized: SerializedThrottle): Throttle {
    const { throttleIdx, rcsDamp, progradeHold, rotationHoldTime, latchedThrust } = serialized;
    // 壊れた値は undefined として渡し、コンストラクタの既定引数に補わせる
    return new Throttle(
      Number.isInteger(throttleIdx) && throttleIdx >= 0 && throttleIdx < THROTTLE_LEVELS.length
        ? throttleIdx : undefined,
      typeof rcsDamp === 'boolean' ? rcsDamp : undefined,
      typeof progradeHold === 'boolean' ? progradeHold : undefined,
      Number.isFinite(rotationHoldTime) && rotationHoldTime >= 0 ? rotationHoldTime : undefined,
      Array.isArray(latchedThrust)
        ? latchedThrust.filter(direction => THRUST_DIRECTIONS.includes(direction)) : undefined,
    );
  }

  // RCS 回転制動の ON/OFF を切り替える。
  public toggleRcsDamp(events: RunEventSink): void {
    this._rcsDamp = !this._rcsDamp;
    events.record({ kind: 'rcsDampToggled', on: this._rcsDamp });
  }

  // プログレードホールドを ON にする。
  public enableProgradeReset(events: RunEventSink): void {
    this._progradeHold = true;
    events.record({ kind: 'progradeHoldReset' });
  }

  // プログレードホールドの ON/OFF を切り替える。
  public toggleProgradeHold(events: RunEventSink): void {
    this._progradeHold = !this._progradeHold;
    events.record({ kind: 'progradeHoldToggled', on: this._progradeHold });
  }

  // 並進出力のプリセットを idx 段階目へ切り替える。段の範囲外なら何もしない。
  public setThrottlePreset(idx: number, events: RunEventSink): void {
    if (!Number.isInteger(idx) || idx < 0 || idx >= THROTTLE_LEVELS.length) return;
    this._throttleIdx = idx;
    events.record({ kind: 'throttlePresetSelected', index: idx });
  }

  // 推力・トルクと噴射ラッチを初期化する。
  public clearTransientState(): void {
    this._thrust = null;
    this._torque = v3();
    this.latchedThrust.clear();
  }

  // 段・制動・ホールド・回転の保持時間・噴射ラッチをシリアライズ形式へ変換する。
  public serialize(): SerializedThrottle {
    return {
      throttleIdx: this._throttleIdx,
      rcsDamp: this._rcsDamp,
      progradeHold: this._progradeHold,
      rotationHoldTime: this.rotationHoldTime,
      latchedThrust: [...this.latchedThrust],
    };
  }

  // 操作量から推力加速度(ECI)を組み立てて thrust へ置く。噴射のぶんの燃料を ship から消費する。
  public updateThrustState(controls: PilotControls, att: Attitude, simDt: number, ship: FuelConsumer): void {
    this._thrust = this.buildThrust(controls, att.q, ship, simDt);
  }

  // 押している方向の対向のラッチを外す。緊急停止の間は全ラッチを外す。逆方向を離した瞬間に、
  // ラッチ側の噴射が復活しないようにするため。
  public updateThrustLatches(controls: PilotControls): void {
    if (thrustKillSwitchActive(controls.thrust)) {
      this.latchedThrust.clear();
      return;
    }
    for (const direction of THRUST_DIRECTIONS) {
      if (controls.thrust.has(direction)) this.latchedThrust.delete(OPPOSITE_THRUST_DIRECTION[direction]);
    }
  }

  // direction の噴射ラッチを反転する。
  public toggleThrustLatch(direction: ThrustDirection): void {
    if (this.latchedThrust.has(direction)) this.latchedThrust.delete(direction);
    else this.latchedThrust.add(direction);
  }

  // 押されている、またはラッチ中であれば true。
  private isThrustHeld(controls: PilotControls, direction: ThrustDirection): boolean {
    return controls.thrust.has(direction) || this.latchedThrust.has(direction);
  }

  // その方向の噴射がラッチ中かどうかを返す。
  public isThrustLatched(direction: ThrustDirection): boolean {
    return this.latchedThrust.has(direction);
  }

  // 6方向の並進の操作量から推力加速度(ECI)を求め、そのぶんの燃料を ship から消費する。噴射しないなら null。
  private buildThrust(controls: PilotControls, q: Attitude['q'], ship: FuelConsumer, simDt: number): Vec3 | null {
    if (thrustKillSwitchActive(controls.thrust)) return null;
    const axX = (this.isThrustHeld(controls, 'left') ? 1 : 0) + (this.isThrustHeld(controls, 'right') ? -1 : 0);
    const axY = (this.isThrustHeld(controls, 'up') ? 1 : 0) + (this.isThrustHeld(controls, 'down') ? -1 : 0);
    const axZ = (this.isThrustHeld(controls, 'forward') ? 1 : 0) + (this.isThrustHeld(controls, 'backward') ? -1 : 0);
    if (axX === 0 && axY === 0 && axZ === 0) return null;

    // 段は最大段に対する比として全開加速度へ掛ける。既定部品の艦では段の値と実加速度が一致する。
    const maxAccel = ship.motion.mass > 0 ? ship.totalThrust / ship.motion.mass : 0;
    const presetScale = THROTTLE_LEVELS[this._throttleIdx]! / THROTTLE_LEVELS[THROTTLE_LEVELS.length - 1]!;
    let thrustAccel = maxAccel * presetScale;

    // 燃料残量に応じて実際の加速度を絞る
    const consumption = ship.totalFuelConsumptionRate * presetScale * simDt;
    thrustAccel *= suppliedFuelRatio(ship.totalFuel, consumption);
    ship.consumeFuel(consumption);

    if (thrustAccel <= 0) return null;

    const dir = norm(v3(axX, axY, axZ));
    return qRotate(q, scale(dir, thrustAccel));
  }

  // 手動回転・RCS制動・プログレードホールドを合成した機体座標系のトルクを torque へ置く。r・v はホールドの
  // 目標姿勢(進行方向)を組む軌道の位置・速度。出力ランプは操作感の量なので実時間 dt、燃料消費は物理量なので
  // simDt で数える。回転の入力はホールドを外し、events があればそれを記録する。
  public updateTorque(
    att: Attitude,
    r: Vec3,
    v: Vec3,
    controls: PilotControls,
    fineAttitude: boolean,
    dt: number,
    simDt: number,
    ship: FuelConsumer,
    events: RunEventSink | null,
  ): void {
    const inertia = att.inertia;
    const rotation = controls.rotation;
    const inX = (rotation.has('pitchDown') ? 1 : 0) + (rotation.has('pitchUp') ? -1 : 0);
    const inY = (rotation.has('yawLeft') ? 1 : 0) + (rotation.has('yawRight') ? -1 : 0);
    const inZ = (rotation.has('rollRight') ? 1 : 0) + (rotation.has('rollLeft') ? -1 : 0);

    // 回転指令があればプログレードホールドを解除する
    const isRotating = inX !== 0 || inY !== 0 || inZ !== 0;
    this.rotationHoldTime = isRotating ? this.rotationHoldTime + dt : 0;
    if (this._progradeHold && isRotating) {
      this._progradeHold = false;
      events?.record({ kind: 'progradeHoldReleasedByInput' });
    }

    // 保持時間に応じてRCS出力を増強しつつ手動トルクを組む
    const rcsOutputFactor =
      RCS_MANUAL_OUTPUT_MIN +
      RCS_MANUAL_OUTPUT_RAMP *
      (Math.min(RCS_MANUAL_RAMP_TIME, this.rotationHoldTime) / RCS_MANUAL_RAMP_TIME);

    const baseAngAccel = ship.totalTorque > 0
      ? ship.totalTorque / Math.max(inertia.x, inertia.y, inertia.z)
      : MAX_ANG_ACCEL;

    const angScale = fineAttitude ? FINE_ATTITUDE_SCALE : 1;
    let maxAngAccel = baseAngAccel * angScale * rcsOutputFactor;

    // 燃料残量に応じて実際の角加速度を絞る
    const rotateIntensity = Math.max(Math.abs(inX), Math.abs(inY), Math.abs(inZ));
    if (rotateIntensity > 0) {
      const rate = ship.rcsFuelConsumptionRate ?? ship.totalFuelConsumptionRate;
      const consumption = rate * rotateIntensity * rcsOutputFactor * angScale * simDt;
      const actualRatio = ship.consumeRcsFuel?.(consumption) ?? ship.consumeFuel(consumption);
      maxAngAccel *= actualRatio;
    }

    const manualTorque = v3(
      inX * maxAngAccel * inertia.x,
      inY * maxAngAccel * inertia.y,
      inZ * maxAngAccel * inertia.z,
    );

    // 無入力かつホールド中なら自動整列トルクを加える(機首をプログレード v、上方向を r へ)
    if (this._progradeHold && inX === 0 && inY === 0 && inZ === 0) {
      this._torque = add(manualTorque, attitudeAlignTorque(v, r, att, PROGRADE_HOLD_KP, PROGRADE_HOLD_KD));
      return;
    }
    // 無入力の軸だけRCS制動を掛ける
    this._torque = this._rcsDamp
      ? v3(
        manualTorque.x - (inX === 0 ? RCS_DAMP_RATE * inertia.x * att.w.x : 0),
        manualTorque.y - (inY === 0 ? RCS_DAMP_RATE * inertia.y * att.w.y : 0),
        manualTorque.z - (inZ === 0 ? RCS_DAMP_RATE * inertia.z * att.w.z : 0),
      )
      : manualTorque;
  }
}
