// 巻雲の鱗の形と大きさを決める気象の診断量(上層の不安定度・鱗の層の深さ・前線の盾)の CPU 基準式。
// 数値を受けて数値を返す。ここにある式が正本で、cirrus-regime-node.ts が同じ式をシェーダグラフへ組む。
// 重みと深さの上下限は cloud-tuning.ts の既定値から読む。
import { CLOUD_TUNING_DEFAULTS } from './cloud-tuning';

// 境目の位置。式の形そのものに属する定数なので調整値にはしない。
export const UPPER_INSTABILITY_ACTIVITY_ONSET = 0.3;
export const UPPER_INSTABILITY_ACTIVITY_FULL = 1.0;
export const UPPER_INSTABILITY_LIFT_ONSET = 0;
export const UPPER_INSTABILITY_LIFT_FULL = 0.03;
export const LAYER_DEPTH_HUMIDITY_ONSET = 0.45;
export const LAYER_DEPTH_HUMIDITY_FULL = 0.9;

// 標準の smoothstep(t = clamp((x−a)/(b−a), 0, 1); t²(3−2t))。
function smoothstepOf(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

// 上層の不安定度 0..1。上層の不安定そのものは物理量として持たず、対流の活発度・薄い雲の斑・
// 上昇流という既存の量から作る代理量。活発度・斑・上昇の順に効きを重ねる。
// convectiveActivity は 0.3..1、cirrusPatch は −1..1、lift は上昇流 [m/s]。
export function upperInstabilityOf(convectiveActivity: number, cirrusPatch: number, lift: number): number {
  const activity = smoothstepOf(
    UPPER_INSTABILITY_ACTIVITY_ONSET, UPPER_INSTABILITY_ACTIVITY_FULL, convectiveActivity);
  const patch = 0.5 + 0.5 * cirrusPatch;
  const rising = smoothstepOf(UPPER_INSTABILITY_LIFT_ONSET, UPPER_INSTABILITY_LIFT_FULL, Math.max(lift, 0));
  const sum = CLOUD_TUNING_DEFAULTS.upperInstabilityActivity * activity
    + CLOUD_TUNING_DEFAULTS.upperInstabilityPatch * patch
    + CLOUD_TUNING_DEFAULTS.upperInstabilityLift * rising;
  return Math.min(Math.max(sum, 0), 1);
}

// 鱗の層の深さ [km]。上層の湿度が高いほど厚い層になり、既定の下限から上限へ滑らかに移る。
export function layerDepthKm(upperHumidity: number): number {
  const t = smoothstepOf(LAYER_DEPTH_HUMIDITY_ONSET, LAYER_DEPTH_HUMIDITY_FULL, upperHumidity);
  const minKm = CLOUD_TUNING_DEFAULTS.layerDepthMinKm;
  const maxKm = CLOUD_TUNING_DEFAULTS.layerDepthMaxKm;
  return minKm + (maxKm - minKm) * t;
}

// 前線・暖気の盾 0..1。前線の帯の上で、暖気が流入し、閉塞の芯でない所に立つ。
// warmth は暖気の流入 [rad](負で寒気なので盾は立たない)。
export function shieldOf(front: number, warmth: number, occludedCore: number): number {
  const warm = smoothstepOf(0, CLOUD_TUNING_DEFAULTS.shieldWarmthFull, warmth);
  return front * warm * (1 - occludedCore);
}
