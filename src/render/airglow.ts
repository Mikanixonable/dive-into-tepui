// 大気自身が放つ淡い光。オーロラの局所的なカーテンとは分け、発光層の高度と太陽時の
// 日照だけから、既存の大気レイマーチへ渡す単位長さあたりの放射を作る。
import { exp, float, max, smoothstep } from 'three/tsl';
import type { FloatNode, Vec3Node } from './tsl-types';

// 発光量は1 mあたりの表示放射輝度。色は線形RGBで持つ。
export interface AirglowOptics {
  readonly color: readonly [number, number, number];
  readonly strength: number;
  readonly altitude: number;
  readonly scaleHeight: number;
}

// ガウスの4標準偏差までを大気の候補球へ含める。これより外側の発光は無視できるほど薄い。
const AIRGLOW_CUTOFF_SIGMA = 4;

export function airglowCutoffAltitude(optics: AirglowOptics): number {
  return Math.max(0, optics.altitude + AIRGLOW_CUTOFF_SIGMA * Math.max(optics.scaleHeight, 0));
}

// 夜側で最大、昼側でも完全には消えない発光係数。日没境界を段差にしない。
const NIGHT_SIDE_MINIMUM = 0.35;
const NIGHT_TRANSITION_START = -0.15;
const NIGHT_TRANSITION_END = 0.25;

// 発光層の中心高度まわりのガウス分布と、昼夜による発光量を合わせる。
// strength は単位長さあたりなので、大気のrayMarchが持つ消散係数で割って使う。
export function airglowEmission(
  altitude: FloatNode,
  sunMu: FloatNode,
  color: Vec3Node,
  strength: FloatNode,
  layerAltitude: FloatNode,
  scaleHeight: FloatNode,
): Vec3Node {
  const normalizedHeight = altitude.sub(layerAltitude).div(max(scaleHeight, 1));
  const layer = exp(normalizedHeight.mul(normalizedHeight).negate());
  const daylight = smoothstep(NIGHT_TRANSITION_START, NIGHT_TRANSITION_END, sunMu);
  const nightFactor = float(NIGHT_SIDE_MINIMUM).add(
    float(1 - NIGHT_SIDE_MINIMUM).mul(float(1).sub(daylight)),
  );
  return color.mul(strength).mul(layer).mul(nightFactor);
}
