// 巻雲の鱗の間隔と、鱗が立つ強さを決める CPU 基準式。風のシア・上層の不安定度・鱗の層の深さ・
// 量という診断量を受けて数値を返す。ここにある式が正本で、cirrus-scale-node.ts が同じ式をシェーダグラフへ組む。
// 定数は cloud-tuning.ts の既定値から読む。
import { CLOUD_TUNING_DEFAULTS } from './cloud-tuning';

// 標準の smoothstep(t = clamp((x−a)/(b−a), 0, 1); t²(3−2t))。
function smoothstepOf(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

function clamp01(x: number): number {
  return Math.min(Math.max(x, 0), 1);
}

// 上層と地表の風の差 [m/s] から、風のシア 0..1 を取る。diff は東・北の成分の差のベクトルの長さ。
export function scaleShearOf(upperSpeedDiffMs: number): number {
  return smoothstepOf(CLOUD_TUNING_DEFAULTS.scaleShearLo, CLOUD_TUNING_DEFAULTS.scaleShearHi, upperSpeedDiffMs);
}

// 鱗の型の重み。和は常に 1。closed は閉じた鱗、open は開いた鱗、roll は列、wave は波。
export interface ScaleRegimeWeights {
  readonly closed: number;
  readonly open: number;
  readonly roll: number;
  readonly wave: number;
}

// シア s が小さいほど鱗の型(閉じた・開いた)になり、大きいほど列か波になる。開き具合は上層の不安定度と量で決まる。
export function scaleRegimeWeights(shear: number, instability: number, amount: number): ScaleRegimeWeights {
  const openness = clamp01(instability + CLOUD_TUNING_DEFAULTS.scaleOpenByAmount * (0.5 - amount));
  return {
    closed: (1 - shear) * (1 - openness),
    open: (1 - shear) * openness,
    roll: shear * instability,
    wave: shear * (1 - instability),
  };
}

// 鱗の間隔 [km]。層の深さに、型ごとの縦横比を重みの幾何平均で掛けて求める。
export function scaleSpacingKm(depthKm: number, weights: ScaleRegimeWeights): number {
  const logAspect = weights.closed * Math.log(CLOUD_TUNING_DEFAULTS.scaleAspectClosed)
    + weights.open * Math.log(CLOUD_TUNING_DEFAULTS.scaleAspectOpen)
    + weights.roll * Math.log(CLOUD_TUNING_DEFAULTS.scaleAspectRoll)
    + weights.wave * Math.log(CLOUD_TUNING_DEFAULTS.scaleAspectWave);
  return depthKm * Math.exp(logAspect);
}

// 鱗が立つ強さ 0..1。シアか上層の不安定度のどちらかが立っていれば鱗が立つ。
export function scaleGate(shear: number, instability: number): number {
  return smoothstepOf(
    CLOUD_TUNING_DEFAULTS.scaleGateOnset, CLOUD_TUNING_DEFAULTS.scaleGateFull,
    Math.max(instability, shear * (1 - instability)),
  );
}
