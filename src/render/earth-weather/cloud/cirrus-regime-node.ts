// 巻雲の鱗の診断量(上層の不安定度・鱗の層の深さ・前線の盾)の TSL ノード版。基準式と境目の定数は
// cirrus-regime.ts が持ち、ここは同じ式をシェーダグラフへ組む。重みと深さの上下限は調整値の uniform から読む。
import { clamp, max, mix, smoothstep } from 'three/tsl';
import { CLOUD_TUNING } from './cloud-tuning';
import {
  LAYER_DEPTH_HUMIDITY_FULL, LAYER_DEPTH_HUMIDITY_ONSET,
  UPPER_INSTABILITY_ACTIVITY_FULL, UPPER_INSTABILITY_ACTIVITY_ONSET,
  UPPER_INSTABILITY_LIFT_FULL, UPPER_INSTABILITY_LIFT_ONSET,
} from './cirrus-regime';
import type { FloatNode } from '../../tsl-types';

// 上層の不安定度 0..1。基準式 upperInstabilityOf と同じ式。
export function upperInstabilityNode(
  convectiveActivity: FloatNode, cirrusPatch: FloatNode, lift: FloatNode,
): FloatNode {
  const activity = smoothstep(
    UPPER_INSTABILITY_ACTIVITY_ONSET, UPPER_INSTABILITY_ACTIVITY_FULL, convectiveActivity);
  const patch = cirrusPatch.mul(0.5).add(0.5);
  const rising = smoothstep(UPPER_INSTABILITY_LIFT_ONSET, UPPER_INSTABILITY_LIFT_FULL, max(lift, 0));
  const sum = CLOUD_TUNING.upperInstabilityActivity.mul(activity)
    .add(CLOUD_TUNING.upperInstabilityPatch.mul(patch))
    .add(CLOUD_TUNING.upperInstabilityLift.mul(rising));
  return clamp(sum, 0, 1);
}

// 鱗の層の深さ [km]。基準式 layerDepthKm と同じ式。
export function layerDepthKmNode(upperHumidity: FloatNode): FloatNode {
  const t = smoothstep(LAYER_DEPTH_HUMIDITY_ONSET, LAYER_DEPTH_HUMIDITY_FULL, upperHumidity);
  return mix(CLOUD_TUNING.layerDepthMinKm, CLOUD_TUNING.layerDepthMaxKm, t);
}

// 前線・暖気の盾 0..1。基準式 shieldOf と同じ式。
export function shieldNode(front: FloatNode, warmth: FloatNode, occludedCore: FloatNode): FloatNode {
  const warm = smoothstep(0, CLOUD_TUNING.shieldWarmthFull, warmth);
  return front.mul(warm).mul(occludedCore.oneMinus());
}
