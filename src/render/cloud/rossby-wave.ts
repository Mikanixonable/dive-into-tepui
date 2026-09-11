// 中緯度の上層偏西風の中を進む、低次元のロスビー波。表示時刻から位相を直接組み立て、球面の
// 流線関数を解析的に微分した風摂動を返す。波の位相速度は、波を運ぶ上層の平均風とは別に持つ。
import {
  abs, clamp, cos, float, max, sign, sin, smoothstep, uniform,
} from 'three/tsl';
import { equirectUvFromDirection } from './field-projection';
import { eastAt, latitudeOf, northAt } from './sphere-frame';
import type { FloatNode, FloatUniform, Vec3Node } from '../tsl-types';

// 長波の東西波数。波長は赤道上で地球一周の 1/5、緯度45°で約5600 kmになる。
const WAVE_NUMBER = 5;
// 波の位相速度 [rad/s]。上層偏西風の速度とは別の、波の山・谷そのものの東向き移動速度。
const WAVE_PHASE_SPEED = (3 * Math.PI / 180) / 86400;
// 位相角の進む速さ [rad/s](波数 × 位相速度)。
const WAVE_PHASE_RATE = WAVE_NUMBER * WAVE_PHASE_SPEED;
// 流線関数から出る南北風の代表速度 [m/s]。中緯度の上層平均風より小さく、蛇行を読める振幅にする。
const MERIDIONAL_SPEED = 8;

// 半径 surfaceRadius [m] の天体で、代表速度を与える流線関数の振幅 [m²/s]。
function streamfunctionAmplitude(surfaceRadius: number): number {
  return (MERIDIONAL_SPEED * surfaceRadius * Math.cos(Math.PI / 4)) / WAVE_NUMBER;
}

// 包絡が立ち上がる緯度と落ちる緯度 [rad]。中緯度の上層帯(およそ ±45°)を包み、赤道と極へ
// 滑らかに消える。
const ENVELOPE_RISE_START = 10 * Math.PI / 180;
const ENVELOPE_RISE_END = 35 * Math.PI / 180;
const ENVELOPE_FALL_START = 55 * Math.PI / 180;
const ENVELOPE_FALL_END = 80 * Math.PI / 180;
// 南北風の 1/cos(緯度) で、cos に張る床。包絡の消える極の近くで発散を抑える。
const MIN_LONGITUDE_RADIUS = 0.25;

export class RossbyWave {
  // 位相角 [rad]。2π で畳んだ値だけを持つので、時間を大きく進めても精度が落ちない。
  private readonly phase: FloatUniform = uniform(0);

  // 位相を初期時刻へそろえる。
  public constructor() {
    this.syncTime(0);
  }

  // 表示時刻 [s] の波の位相を uniform へ写す。位相は時刻だけで決まるので、巻き戻しやセーブ復帰でも
  // 同じ時刻には同じ波になる。
  public syncTime(seconds: number): void {
    this.phase.value = wrapAngle(WAVE_PHASE_RATE * seconds);
  }

  // 波の流線関数 ψ = A·E(φ)·sin(kλ − kct) [m²/s]。surfaceRadius は波が走る天体の半径 [m]。
  public streamfunctionAt(direction: Vec3Node, surfaceRadius: number): FloatNode {
    return this.envelopeAt(latitudeOf(direction)).mul(sin(this.phaseAt(direction)))
      .mul(streamfunctionAmplitude(surfaceRadius));
  }

  // 流線関数を球面上で微分した風摂動 [m/s]。surfaceRadius は波が走る天体の半径 [m]。
  public perturbationAt(direction: Vec3Node, surfaceRadius: number): Vec3Node {
    const latitude = latitudeOf(direction);
    const phase = this.phaseAt(direction);
    const envelope = this.envelopeAt(latitude);
    const envelopeSlope = this.envelopeSlopeAt(latitude);
    const amplitudeOverRadius = streamfunctionAmplitude(surfaceRadius) / surfaceRadius;
    // 東向き u = −(1/R)∂ψ/∂φ、北向き v = (1/(R cos φ))∂ψ/∂λ。
    const eastWind = sin(phase).mul(envelopeSlope).mul(-amplitudeOverRadius);
    const northWind = cos(phase).mul(envelope).mul(amplitudeOverRadius * WAVE_NUMBER)
      .div(max(cos(latitude), MIN_LONGITUDE_RADIUS));
    return eastAt(direction).mul(eastWind).add(northAt(direction).mul(northWind));
  }

  // 経度方向の位相。equirect の経度の継ぎ目は、周期関数へ入ることで連続につながる。
  private phaseAt(direction: Vec3Node): FloatNode {
    const longitude = equirectUvFromDirection(direction).x.sub(0.5).mul(2 * Math.PI);
    return longitude.mul(WAVE_NUMBER).sub(this.phase);
  }

  // 中緯度で 1、赤道と極で 0 になる C1 連続の包絡。
  private envelopeAt(latitude: FloatNode): FloatNode {
    const absolute = abs(latitude);
    return smoothstep(ENVELOPE_RISE_START, ENVELOPE_RISE_END, absolute)
      .mul(smoothstep(ENVELOPE_FALL_START, ENVELOPE_FALL_END, absolute).oneMinus());
  }

  // 包絡の緯度微分 dE/dφ。smoothstep の微分も端で 0 になるため、風速に段差を作らない。
  private envelopeSlopeAt(latitude: FloatNode): FloatNode {
    const absolute = abs(latitude);
    // 上昇区間と下降区間の傾きを別々に組む。
    const rising = smoothstep(ENVELOPE_RISE_START, ENVELOPE_RISE_END, absolute);
    const falling = smoothstep(ENVELOPE_FALL_START, ENVELOPE_FALL_END, absolute);
    const risingT = clamp(absolute.sub(ENVELOPE_RISE_START).div(ENVELOPE_RISE_END - ENVELOPE_RISE_START), 0, 1);
    const fallingT = clamp(absolute.sub(ENVELOPE_FALL_START).div(ENVELOPE_FALL_END - ENVELOPE_FALL_START), 0, 1);
    const risingSlope = risingT.mul(float(1).sub(risingT))
      .mul(6 / (ENVELOPE_RISE_END - ENVELOPE_RISE_START));
    const fallingSlope = fallingT.mul(float(1).sub(fallingT))
      .mul(-6 / (ENVELOPE_FALL_END - ENVELOPE_FALL_START));
    return risingSlope.mul(falling.oneMinus()).add(rising.mul(fallingSlope)).mul(sign(latitude));
  }
}

// 位相角 [rad] を 0..2π へ畳む。
function wrapAngle(angle: number): number {
  const turns = angle / (2 * Math.PI);
  return (turns - Math.floor(turns)) * 2 * Math.PI;
}
