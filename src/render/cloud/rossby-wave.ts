// 中緯度の上層偏西風の中を進む、低次元のロスビー波。表示時刻から位相を直接組み立て、球面の
// 流線関数を解析的に微分した風摂動を返す。波の位相速度は、波を運ぶ上層の平均風とは別に持つ。
// 南北の半球は互いに独立の位相を持ち、蛇行の振幅はストームトラックの海域で大きくなる。
import {
  abs, clamp, cos, exp, float, max, mix, sign, sin, smoothstep, uniform,
} from 'three/tsl';
import { equirectUvFromDirection } from '../field-projection';
import { eastAt, latitudeOf, northAt } from './sphere-frame';
import type { FloatNode, FloatUniform, Vec3Node } from '../tsl-types';

// 長波の東西波数。波長は赤道上で地球一周の 1/5、緯度45°で約5600 kmになる。
// 地表の低気圧・高気圧の配置もこの波の位相へ錨づけるので、波数と位相速度を export する。
export const WAVE_NUMBER = 5;
// 波の位相速度 [rad/s]。上層偏西風の速度とは別の、波の山・谷そのものの東向き移動速度。
export const WAVE_PHASE_SPEED = (3 * Math.PI / 180) / 86400;
// 位相角の進む速さ [rad/s](波数 × 位相速度)。
const WAVE_PHASE_RATE = WAVE_NUMBER * WAVE_PHASE_SPEED;
// 南北の位相差 [rad]。位相 π は谷の間隔(位相 2π/k)の半分に相当し、両半球の谷が同じ経度へ
// 揃うことがなくなる。包絡が熱帯で消えるので、赤道を跨ぐ位相の跳びは場に現れない。
const HEMISPHERE_PHASE_OFFSET = Math.PI / 2;
// 流線関数から出る南北風の代表速度 [m/s]。中緯度の上層平均風より小さく、蛇行を読める振幅にする。
// 8 では波数 5 の波が S 帯の k=4..8 に尖りを作り、中緯度の相関時間も実写より長くなるため
// 半分へ (cloud-lab Phase 3-12: S 帯の尖り 14.65 → 7.90、中緯度の相関時間 12.1/11.3 h →
// 8.3/7.7 h)。波そのものは SPEC「中緯度の偏西風は全球規模のロスビー波によって蛇行する」の
// とおり残す — 全除去は移流の速さ比を崩して motionReference を悪化させる。
const MERIDIONAL_SPEED = 4;

const DEGREE = Math.PI / 180; // [rad]

// 半径 surfaceRadius [m] の天体で、代表速度を与える流線関数の振幅 [m²/s]。
function streamfunctionAmplitude(surfaceRadius: number): number {
  return (MERIDIONAL_SPEED * surfaceRadius * Math.cos(Math.PI / 4)) / WAVE_NUMBER;
}

// 包絡が立ち上がる緯度と落ちる緯度 [rad]。中緯度の上層帯(およそ ±45°)を包み、赤道と極へ
// 滑らかに消える。熱帯で 0 になることが、半球ごとの位相・重みの切替を見えなくする。
const ENVELOPE_RISE_START = 10 * DEGREE;
const ENVELOPE_RISE_END = 35 * DEGREE;
const ENVELOPE_FALL_START = 55 * DEGREE;
const ENVELOPE_FALL_END = 80 * DEGREE;
// 南北風の 1/cos(緯度) で、cos に張る床。包絡の消える極の近くで発散を抑える。
const MIN_LONGITUDE_RADIUS = 0.25;

// ストームトラックを形作る経度の bump。[中心経度 rad, ピークの高さ, 集中度 κ = 1/σ²]。
// 周期ガウス exp(κ(cosΔ−1))(円周へ畳んだガウス)で与えるので、全球で滑らかにつながる。
type TrackBump = readonly [longitude: number, height: number, concentration: number];

// bump の束縛を度数法で書くための組み立て。width はガウスの標準偏差 σ [°]。
function trackBump(longitude: number, height: number, width: number): TrackBump {
  const sigma = width * DEGREE;
  return [longitude * DEGREE, height, 1 / (sigma * sigma)];
}

// 北半球のストームトラック。渦動ジェットが強く蛇行の振幅が大きい海域 — 大陸東岸沖の
// 北西太平洋と北大西洋西岸が主域で、欧州〜地中海の帯を二次的に足す。
const NORTH_TRACKS: readonly TrackBump[] = [
  trackBump(140, 0.7, 30),
  trackBump(-60, 0.7, 30),
  trackBump(20, 0.4, 22),
];
// 南半球のストームトラック。南大西洋〜南インド洋〜南西太平洋へ幅広く続く帯として、
// 南東太平洋側だけが浅くなるよう大きな幅で重ねる。
const SOUTH_TRACKS: readonly TrackBump[] = [
  trackBump(30, 0.5, 70),
  trackBump(150, 0.4, 70),
];
// 帯の外でも波が残るよう張る床。重みの範囲はおよそ床〜1 になる。
const TRACK_FLOOR = 0.3;

export class RossbyWave {
  // 位相角 [rad]。2π で畳んだ値だけを持つので、時間を大きく進めても精度が落ちない。
  private readonly phase: FloatUniform = uniform(0);

  // 位相を初期時刻へそろえる。
  public constructor() {
    this.syncTime(0);
  }

  // 表示時刻 [s] における波の位相を uniform に反映する。位相は時刻だけで決まるので、巻き戻しやセーブ復帰でも
  // 同じ時刻には同じ波になる。
  public syncTime(seconds: number): void {
    this.phase.value = wrapAngle(WAVE_PHASE_RATE * seconds);
  }

  // 波の流線関数 ψ = A·E(φ)·W(φ,λ)·sin(kλ − ωt + 半球位相) [m²/s]。surfaceRadius は波が走る
  // 天体の半径 [m]。
  public streamfunctionAt(direction: Vec3Node, surfaceRadius: number): FloatNode {
    const latitude = latitudeOf(direction);
    const longitude = longitudeOf(direction);
    return this.envelopeAt(latitude).mul(trackWeightsAt(latitude, longitude)[0])
      .mul(sin(this.phaseAt(latitude, longitude)))
      .mul(streamfunctionAmplitude(surfaceRadius));
  }

  // 流線関数を球面上で微分した風摂動 [m/s]。surfaceRadius は波が走る天体の半径 [m]。
  public perturbationAt(direction: Vec3Node, surfaceRadius: number): Vec3Node {
    const latitude = latitudeOf(direction);
    const longitude = longitudeOf(direction);
    const phase = this.phaseAt(latitude, longitude);
    const envelope = this.envelopeAt(latitude);
    const envelopeSlope = this.envelopeSlopeAt(latitude);
    const [weight, weightSlope] = trackWeightsAt(latitude, longitude);
    const amplitudeOverRadius = streamfunctionAmplitude(surfaceRadius) / surfaceRadius;
    // 東向き u = −(1/R)∂ψ/∂φ = −(A/R)E'W sin(phase)。W の緯度微分は半球ブレンドを通るだけで
    // 包絡の消える熱帯に限られるので項を立てない。
    const eastWind = sin(phase).mul(envelopeSlope).mul(weight).mul(-amplitudeOverRadius);
    // 北向き v = (1/(R cos φ))∂ψ/∂λ = (AE/(R cos φ))·(kW cos(phase) + ∂W/∂λ sin(phase))。
    const northWind = weight.mul(WAVE_NUMBER).mul(cos(phase))
      .add(weightSlope.mul(sin(phase)))
      .mul(envelope).mul(amplitudeOverRadius)
      .div(max(cos(latitude), MIN_LONGITUDE_RADIUS));
    return eastAt(direction).mul(eastWind).add(northAt(direction).mul(northWind));
  }

  // 方向 direction における蛇行振幅の重み(0〜1)。緯度包絡とストームトラック重みの積で、
  // 流線関数へ掛かる係数と同じもの。発生判定などが振幅場を引くための口。
  public amplitudeAt(direction: Vec3Node): FloatNode {
    const latitude = latitudeOf(direction);
    const longitude = longitudeOf(direction);
    return this.envelopeAt(latitude).mul(trackWeightsAt(latitude, longitude)[0]);
  }

  // 現在の時刻における、半球 hemisphere (北 +1 / 南 −1) の index 番目の谷の経度 [rad]。
  // 畳んだ位相から組むので、経度は波の間隔 2π/k の整数倍を除いて定まる。
  public troughLongitude(index: number, hemisphere: number): number {
    return (this.phase.value - Math.PI / 2 - hemisphere * HEMISPHERE_PHASE_OFFSET
      + 2 * Math.PI * index) / WAVE_NUMBER;
  }

  // 経度方向の位相 kλ − ωt + 半球位相。equirect の経度の継ぎ目は、周期関数へ入ることで
  // 連続につながる。半球位相は赤道で不連続になるが、包絡が熱帯で消えるので場には現れない。
  private phaseAt(latitude: FloatNode, longitude: FloatNode): FloatNode {
    return longitude.mul(WAVE_NUMBER).sub(this.phase)
      .add(sign(latitude).mul(HEMISPHERE_PHASE_OFFSET));
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

// 時刻 seconds [s] における、半球 hemisphere (北 +1 / 南 −1) の index 番目の谷の経度
// [rad](畳まない)。流線関数の位相 kλ − ωt + sδ の極小は kλ − ωt + sδ = −π/2 + 2πn 。
// 地表の低気圧は谷の下流側で発達し、高気圧は谷と谷の中間(尾根)へ座るので、
// 両者の配置がこの関数へ錨づく。
export function waveTroughLongitude(index: number, seconds: number, hemisphere: number): number {
  return (WAVE_PHASE_RATE * seconds - Math.PI / 2 - hemisphere * HEMISPHERE_PHASE_OFFSET
    + 2 * Math.PI * index) / WAVE_NUMBER;
}

// 経度 longitude [rad]・半球 hemisphere (北 +1 / 南 −1) でいちばん強く効いている
// ストームトラックの bump の中心経度 [rad]。帯の束はこのモジュールの bump 表が正本なので、
// 発生した帯を知りたい利用側(低気圧の進路の組み立てなど)が表を複製せずに済む口。
// 高い bump ほど広い海域を代表するので、円周上の距離を高さで割って主域を優先する。
export function stormTrackAxisAt(longitude: number, hemisphere: number): number {
  const tracks = hemisphere >= 0 ? NORTH_TRACKS : SOUTH_TRACKS;
  let nearest = tracks[0]![0];
  let nearestScore = Infinity;
  for (const [center, height] of tracks) {
    const distance = Math.abs(Math.atan2(Math.sin(longitude - center), Math.cos(longitude - center)));
    const score = distance / height;
    if (score < nearestScore) {
      nearest = center;
      nearestScore = score;
    }
  }
  return nearest;
}

// 緯度・経度 [rad] における蛇行振幅の重み(0〜1)。GPU 上の amplitudeAt と同じ場を CPU 側から
// 引く口 — 低気圧・高気圧の発生判定が同じ振幅地図を共有する。
export function waveAmplitudeAt(latitude: number, longitude: number): number {
  const absolute = Math.abs(latitude);
  const envelope = smoothstepJs(ENVELOPE_RISE_START, ENVELOPE_RISE_END, absolute)
    * (1 - smoothstepJs(ENVELOPE_FALL_START, ENVELOPE_FALL_END, absolute));
  return envelope * trackWeightAtJs(latitude, longitude);
}

// 単位方向の経度 [rad](−π〜π)。継ぎ目は周期関数へ入ることで連続につながる。
function longitudeOf(direction: Vec3Node): FloatNode {
  return equirectUvFromDirection(direction).x.sub(0.5).mul(2 * Math.PI);
}

// bump 群の和と、経度微分の和を組む。戻り値は [重み, 経度微分]。
function trackSumsAt(longitude: FloatNode, tracks: readonly TrackBump[]): [FloatNode, FloatNode] {
  let weight: FloatNode = float(0);
  let slope: FloatNode = float(0);
  for (const [center, height, concentration] of tracks) {
    // 周期ガウス exp(κ(cosΔ−1)) とその経度微分 −κ sin(Δ) exp(κ(cosΔ−1))。
    const bump = exp(float(concentration).mul(cos(longitude.sub(center)).sub(1)));
    weight = weight.add(float(height).mul(bump));
    slope = slope.sub(float(height * concentration).mul(sin(longitude.sub(center))).mul(bump));
  }
  return [weight, slope];
}

// 緯度・経度におけるストームトラック重みとその経度微分を [重み, ∂W/∂λ] で返す。半球で別の
// 帯の束を持ち、包絡が消える熱帯の中で滑らかにブレンドする。ブレンド自身の緯度勾配は
// 包絡の消える熱帯に限られるので、微分は半球ごとの微分の混合で足す。
function trackWeightsAt(latitude: FloatNode, longitude: FloatNode): [FloatNode, FloatNode] {
  const hemisphereMix = smoothstep(-ENVELOPE_RISE_START, ENVELOPE_RISE_START, latitude);
  const [northWeight, northSlope] = trackSumsAt(longitude, NORTH_TRACKS);
  const [southWeight, southSlope] = trackSumsAt(longitude, SOUTH_TRACKS);
  // bump の重なりで 1 をわずかに超えることがあるので、重みは 1 へ留める。
  return [
    mix(southWeight.add(TRACK_FLOOR), northWeight.add(TRACK_FLOOR), hemisphereMix).min(1),
    mix(southSlope, northSlope, hemisphereMix),
  ];
}

// CPU 側の smoothstep。エッジ外では 0/1 へ留まり、端での微分も 0 になる。
function smoothstepJs(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

// CPU 側のストームトラック重み。TSL 版の trackWeightAt と同じ式を素の数で組む。
function trackWeightAtJs(latitude: number, longitude: number): number {
  const hemisphereMix = smoothstepJs(-ENVELOPE_RISE_START, ENVELOPE_RISE_START, latitude);
  const trackSum = (tracks: readonly TrackBump[]): number => {
    let sum = 0;
    for (const [center, height, concentration] of tracks) {
      sum += height * Math.exp(concentration * (Math.cos(longitude - center) - 1));
    }
    return sum;
  };
  const south = TRACK_FLOOR + trackSum(SOUTH_TRACKS);
  const north = TRACK_FLOOR + trackSum(NORTH_TRACKS);
  return Math.min(south + (north - south) * hemisphereMix, 1);
}

// 位相角 [rad] を 0..2π へ畳む。
function wrapAngle(angle: number): number {
  const turns = angle / (2 * Math.PI);
  return (turns - Math.floor(turns)) * 2 * Math.PI;
}
