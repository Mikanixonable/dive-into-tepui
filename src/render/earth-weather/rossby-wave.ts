// 中緯度の上層偏西風の中を進む、低次元のロスビー波。表示時刻から位相を直接組み立て、球面の
// 流線関数を解析的に微分した風摂動と、流線の南北変位を返す。波は複数の波長の重ね合わせで、
// 全体を運ぶキャリアのドリフトはゆっくり東へ進むか停滞・逆行する。蛇行の強さは時期で盛衰し、
// 南北の半球は互いに独立の位相を持ち、振幅はストームトラックの海域で大きくなる。
// 地表の低気圧・高気圧の配置はこの波の谷・尾根へ錨づき、錨は波と同じドリフトで運ばれる。
import * as THREE from 'three/webgpu';
import {
  abs, clamp, cos, exp, float, max, mix, sign, sin, smoothstep, uniform,
} from 'three/tsl';
import { wrapAngle } from '../../math/angle';
import { equirectUvFromDirection } from '../field-projection';
import { eastAt, latitudeOf, northAt } from './sphere-frame';
import type { FloatNode, FloatUniform, Vec3Node, Vec3Uniform } from '../tsl-types';

// 錨づくキャリアの東西波数。波長は赤道上で地球一周の 1/5、緯度45°で約5600 kmになる。
// 地表の低気圧・高気圧の配置はこの波数で等間隔に立つ谷・尾根へ錨づく。
const WAVE_NUMBER = 5;
// 谷(とその中間の尾根)の経度の間隔 [°]。波へ錨づく配置の下流方向の揺れの尺になる。
export const WAVE_TROUGH_WIDTH = 360 / WAVE_NUMBER;
// キャリアの南北の位相差の単位 [rad]。位相 π は谷の間隔(位相 2π/k)の半分に相当し、
// 両半球の谷が同じ経度へ揃うことがなくなる。包絡が熱帯で消えるので、赤道を跨ぐ位相の跳びは
// 場に現れない。各成分はこの単位の違う倍率を持ち、半球どうしの形は完全には鏡写しにならない。
const HEMISPHERE_PHASE_OFFSET = Math.PI / 2;

const DEGREE = Math.PI / 180; // [rad]
const DAY = 86400; // [s]

// キャリアのドリフト [°/日]。平均してゆっくり東へ進むが、2 つの長周期の変調が重なると
// ほぼ停滞する局面や逆行する局面が訪れる。錨づく低気圧・高気圧はこのドリフトで運ばれるので、
// 波が止まる時期には配置も止まる(ブロッキング)。
const DRIFT_MEAN = 3;
const DRIFT_SWINGS: readonly (readonly [amplitude: number, periodDays: number, phase: number])[] = [
  [4.2, 60, 0],
  [1.8, 27, 2.44],
];

// 時刻 seconds [s] におけるキャリアの累積ドリフト [°](畳まない)。各成分の位相は
// kλ − k·D(t) + 半球位相 + 揺れ で、この D が谷・尾根の錨の経度を進める。
export function waveDriftDegAt(seconds: number): number {
  const days = seconds / DAY;
  let drift = DRIFT_MEAN * days;
  let offset = 0;
  for (const [amplitude, periodDays, phase] of DRIFT_SWINGS) {
    const rate = (2 * Math.PI) / periodDays;
    drift += amplitude * Math.sin(days * rate + phase) / rate;
    offset += amplitude * Math.sin(phase) / rate;
  }
  return drift - offset;
}

// 波を形作る成分。変位はこれらの正弦の重ね合わせで、波長の違いが谷の間隔と形を場所ごとに
// 変える。wobble は成分ごとのゆっくりした位相の揺れで、同じ場所でも時期で形が揃わないように
// する。hemiPhase は半球位相を HEMISPHERE_PHASE_OFFSET の倍率でずらす量 — 成分ごとに違う
// 位相差を持つので、両半球の蛇行は互いに独立した形になる。
interface WaveComponent {
  readonly k: number; // 東西波数
  readonly displacementDeg: number; // 変位の重み [°]
  readonly hemiPhase: number; // 半球位相のずらし(HEMISPHERE_PHASE_OFFSET の倍率)
  readonly wobbleAmplitude: number; // 位相揺れの振幅 [rad]
  readonly wobblePeriod: number; // 位相揺れの周期 [日]
  readonly wobblePhase: number; // 位相揺れの初期位相 [rad]
}
const WAVE_COMPONENTS: readonly WaveComponent[] = [
  { k: 4, displacementDeg: 3.2, hemiPhase: 0.45, wobbleAmplitude: 0.7, wobblePeriod: 41, wobblePhase: 1.3 },
  { k: 5, displacementDeg: 6.0, hemiPhase: 1.0, wobbleAmplitude: 0.4, wobblePeriod: 53, wobblePhase: 4.0 },
  { k: 7, displacementDeg: 3.0, hemiPhase: 1.8, wobbleAmplitude: 0.9, wobblePeriod: 29, wobblePhase: 2.2 },
];

// 蛇行の強さの時間変調 g(t)。平らな局面と深く蛇行する局面が交互に訪れる。低気圧の発生の門
// (waveAmplitudeAt)にもそのまま効くので、振幅の強い時期に群発・弱い時期に静穏になる。
const AMPLITUDE_BASE = 0.62;
const AMPLITUDE_SWINGS: readonly (readonly [amplitude: number, periodDays: number, phase: number])[] = [
  [0.24, 29, 0.9],
  [0.14, 43, 2.6],
];

// 時刻 seconds [s] における蛇行の強さの変調。0..1 の範囲で盛衰する。
function amplitudeSwingAt(seconds: number): number {
  const days = seconds / DAY;
  let swing = AMPLITUDE_BASE;
  for (const [amplitude, periodDays, phase] of AMPLITUDE_SWINGS) {
    swing += amplitude * Math.sin(((2 * Math.PI) / periodDays) * days + phase);
  }
  return swing;
}

// 包絡が立ち上がる緯度と落ちる緯度 [rad]。中緯度の上層帯(およそ ±45°)を包み、赤道と極へ
// 滑らかに消える。熱帯で 0 になることが、半球ごとの位相・重みの切替を見えなくする。
const ENVELOPE_RISE_START = 10 * DEGREE;
const ENVELOPE_RISE_END = 35 * DEGREE;
const ENVELOPE_FALL_START = 55 * DEGREE;
const ENVELOPE_FALL_END = 80 * DEGREE;
// 南北風の 1/cos(緯度) で、cos に張る床。包絡の消える極の近くで発散を抑える。
const MIN_LONGITUDE_RADIUS = 0.25;
// 変位場から風を解くときの、流線を運ぶ上層の平均風の代表速度 [m/s]。流線関数
// ψ = U·R·η(η は変位 [rad])として書くと、南北風は U·∂η/∂λ、東西風は −U·∂η/∂φ で
// 出る。変位そのものは数度あっても、微分して出る風速はこの程度に収まる。
const DISPLACEMENT_WIND = 4;

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

// 半球 hemisphere (北 +1 / 南 −1) のストームトラックの bump 表。
function trackBumpsOf(hemisphere: number): readonly TrackBump[] {
  return hemisphere >= 0 ? NORTH_TRACKS : SOUTH_TRACKS;
}

// 半球 hemisphere (北 +1 / 南 −1) が持つストームトラックの本数。
export function stormTrackCountAt(hemisphere: number): number {
  return trackBumpsOf(hemisphere).length;
}

// 経度 longitude [rad]・半球 hemisphere (北 +1 / 南 −1) でいちばん強く効いている
// ストームトラックの番号(bump 表の index)。高い bump ほど広い海域を代表するので、
// 円周上の距離を高さで割って主域を優先する。
export function stormTrackIndexAt(longitude: number, hemisphere: number): number {
  const tracks = trackBumpsOf(hemisphere);
  let nearest = 0;
  let nearestScore = Infinity;
  for (const [index, [center, height]] of tracks.entries()) {
    const distance = Math.abs(Math.atan2(Math.sin(longitude - center), Math.cos(longitude - center)));
    const score = distance / height;
    if (score < nearestScore) {
      nearest = index;
      nearestScore = score;
    }
  }
  return nearest;
}

// 時刻 seconds [s] における、半球 hemisphere (北 +1 / 南 −1) の index 番目の谷の経度
// [rad](畳まない)。谷はキャリアの位相 kλ − k·D(t) + sδ の極小 — 錨はドリフトとともに
// 進み、停滞・逆行の局面では谷も止まる・戻る。地表の低気圧は谷の下流側で発達し、
// 高気圧は谷と谷の中間(尾根)へ座るので、両者の配置がこの関数へ錨づく。
export function waveTroughLongitude(index: number, seconds: number, hemisphere: number): number {
  return waveDriftDegAt(seconds) * DEGREE
    + (-Math.PI / 2 - hemisphere * HEMISPHERE_PHASE_OFFSET + 2 * Math.PI * index) / WAVE_NUMBER;
}

// 世代 generation で枡 slot が座る波の錨(谷・尾根)の番号と、同じ錨へ並ぶ枡の中での順番。
// 枡は世代ごとに錨を順繰りに回るので、同じ錨には複数の枡が下流方向へ位相差で並ぶ。
export function waveAnchoredSlot(
  slot: number, generation: number,
): { readonly index: number; readonly rank: number } {
  const index = (slot + generation) % WAVE_NUMBER;
  let rank = 0;
  for (let s = 0; s < slot; s++) {
    if ((s + generation) % WAVE_NUMBER === index) rank++;
  }
  return { index, rank };
}

// 緯度・経度 [rad] における蛇行振幅(0 強)。緯度包絡 × ストームトラック重み × 時間変調 —
// 低気圧の発生の門と高気圧の高さの抑揚がこの場を共有する。時刻 seconds [s] で盛衰する。
export function waveAmplitudeAt(latitude: number, longitude: number, seconds: number): number {
  return envelopeAtJs(latitude) * trackWeightAtJs(latitude, longitude) * amplitudeSwingAt(seconds);
}

// 緯度・経度 [rad]・時刻 seconds [s] における流線の南北変位 [°]。複数波長の重ね合わせで、
// 谷の間隔と形は場所と時期で揃わない。緯度包絡が赤道と極で 0 へ消え、半球ごとの位相と
// トラックの束を持つ。循環の帯や上層の流れの読み位置をずらす量 — 高い雲の筋はこの変位に
// 沿って南北へ曲がる。
export function waveDisplacementDegAt(latitude: number, longitude: number, seconds: number): number {
  const hemisphere = Math.sign(latitude);
  const drift = waveDriftDegAt(seconds) * DEGREE;
  const days = seconds / DAY;
  let displacement = 0;
  for (const component of WAVE_COMPONENTS) {
    const phase = component.k * longitude - component.k * drift
      + hemisphere * component.hemiPhase * HEMISPHERE_PHASE_OFFSET
      + component.wobbleAmplitude
        * Math.sin(((2 * Math.PI) / component.wobblePeriod) * days + component.wobblePhase);
    displacement += component.displacementDeg * Math.sin(phase);
  }
  return envelopeAtJs(latitude) * trackWeightAtJs(latitude, longitude)
    * amplitudeSwingAt(seconds) * displacement;
}

// 緯度包絡の JS 版。中緯度で 1、赤道と極で 0 になる C1 連続の包絡。
function envelopeAtJs(latitude: number): number {
  const absolute = Math.abs(latitude);
  return THREE.MathUtils.smoothstep(absolute, ENVELOPE_RISE_START, ENVELOPE_RISE_END)
    * (1 - THREE.MathUtils.smoothstep(absolute, ENVELOPE_FALL_START, ENVELOPE_FALL_END));
}

// CPU 側のストームトラック重み。TSL 版の trackWeightsAt と同じ式を素の数で組む。
function trackWeightAtJs(latitude: number, longitude: number): number {
  const hemisphereMix = THREE.MathUtils.smoothstep(latitude, -ENVELOPE_RISE_START, ENVELOPE_RISE_START);
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

export class RossbyWave {
  // 成分ごとの位相の時刻依存分 −k·D(t) + ε(t) [rad]。2π で畳んだ値だけを持つので、
  // 時間を大きく進めても精度が落ちない。
  private readonly carrierPhases: Vec3Uniform = uniform(new THREE.Vector3());
  // 蛇行の強さの時間変調 g(t)。
  private readonly swing: FloatUniform = uniform(0);

  public constructor() {
    this.syncTime(0);
  }

  // 表示時刻 [s] における波の位相と強さを uniform に反映する。位相は時刻だけで決まるので、
  // 巻き戻しやセーブ復帰でも同じ時刻には同じ波になる。
  public syncTime(seconds: number): void {
    const drift = waveDriftDegAt(seconds) * DEGREE;
    const days = seconds / DAY;
    const phases = WAVE_COMPONENTS.map((component) => wrapAngle(
      -component.k * drift
        + component.wobbleAmplitude
          * Math.sin(((2 * Math.PI) / component.wobblePeriod) * days + component.wobblePhase),
    ));
    this.carrierPhases.value.set(...(phases as [number, number, number]));
    this.swing.value = amplitudeSwingAt(seconds);
  }

  // 成分 index の位相の時刻依存分を vec3 の成分から引く。
  private carrierPhaseOf(index: number): FloatNode {
    return [this.carrierPhases.x, this.carrierPhases.y, this.carrierPhases.z][index]!;
  }

  // 単位方向 direction での流線の南北変位 [rad]。緯度の帯や流れの読み位置をずらす量で、
  // JS 版の waveDisplacementDegAt と同じ式を TSL で組む。
  public displacementAt(direction: Vec3Node): FloatNode {
    const latitude = latitudeOf(direction);
    const longitude = longitudeOf(direction);
    const hemisphere = sign(latitude);
    let displacement: FloatNode = float(0);
    for (const [index, component] of WAVE_COMPONENTS.entries()) {
      const phase = longitude.mul(component.k)
        .add(hemisphere.mul(component.hemiPhase * HEMISPHERE_PHASE_OFFSET))
        .add(this.carrierPhaseOf(index));
      displacement = displacement.add(sin(phase).mul(component.displacementDeg));
    }
    const [weight] = trackWeightsAt(latitude, longitude);
    return displacement.mul(this.envelopeAt(latitude)).mul(weight).mul(this.swing).mul(DEGREE);
  }

  // 流線関数 ψ = U·R·η(η は南北変位 [rad])を球面上で微分した風摂動 [m/s]。
  // 角度の微分では天体の半径が分子分母で相殺されるので、変位の形だけで決まる。
  public perturbationAt(direction: Vec3Node): Vec3Node {
    const latitude = latitudeOf(direction);
    const longitude = longitudeOf(direction);
    const hemisphere = sign(latitude);
    const envelope = this.envelopeAt(latitude);
    const envelopeSlope = this.envelopeSlopeAt(latitude);
    const [weight, weightSlope] = trackWeightsAt(latitude, longitude);
    // η [rad] とその微分。u = −U·∂η/∂φ、v = (U/cos φ)·∂η/∂λ。
    let displacement: FloatNode = float(0);
    let displacementLon: FloatNode = float(0);
    for (const [index, component] of WAVE_COMPONENTS.entries()) {
      const phase = longitude.mul(component.k)
        .add(hemisphere.mul(component.hemiPhase * HEMISPHERE_PHASE_OFFSET))
        .add(this.carrierPhaseOf(index));
      const amplitude = component.displacementDeg * DEGREE;
      displacement = displacement.add(sin(phase).mul(amplitude));
      displacementLon = displacementLon.add(cos(phase).mul(amplitude * component.k));
    }
    const northWind = weight.mul(displacementLon)
      .add(weightSlope.mul(displacement))
      .mul(envelope).mul(this.swing).mul(DISPLACEMENT_WIND)
      .div(max(cos(latitude), MIN_LONGITUDE_RADIUS));
    const eastWind = envelopeSlope.mul(weight).mul(displacement)
      .mul(this.swing).mul(DISPLACEMENT_WIND).negate();
    return eastAt(direction).mul(eastWind).add(northAt(direction).mul(northWind));
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
