// 巻雲の鱗の間隔と鱗が立つ強さの TSL ノード版。基準式と同じ式をシェーダグラフへ組む。
// 定数は調整値の uniform から読む。
import { clamp, exp, float, length, log, max, smoothstep } from 'three/tsl';
import { CLOUD_TUNING } from './cloud-tuning';
import type { FloatNode, Vec2Node } from '../../tsl-types';

// 風のシア 0..1。上層と地表の風の差のベクトルの長さで決まる。基準式 scaleShearOf と同じ式。
export function scaleShearNode(upperWind: Vec2Node, surfaceWind: Vec2Node): FloatNode {
  return smoothstep(CLOUD_TUNING.scaleShearLo, CLOUD_TUNING.scaleShearHi, length(upperWind.sub(surfaceWind)));
}

// 鱗の型の重み。基準式 ScaleRegimeWeights と同じ。
export interface ScaleRegimeWeightNodes {
  readonly closed: FloatNode;
  readonly open: FloatNode;
  readonly roll: FloatNode;
  readonly wave: FloatNode;
}

// 基準式 scaleRegimeWeights と同じ式。
export function scaleRegimeWeightsNode(
  shear: FloatNode, instability: FloatNode, amount: FloatNode,
): ScaleRegimeWeightNodes {
  const openness = clamp(
    instability.add(CLOUD_TUNING.scaleOpenByAmount.mul(float(0.5).sub(amount))), 0, 1);
  const calm = shear.oneMinus();
  return {
    closed: calm.mul(openness.oneMinus()),
    open: calm.mul(openness),
    roll: shear.mul(instability),
    wave: shear.mul(instability.oneMinus()),
  };
}

// 鱗の間隔 [km]。基準式 scaleSpacingKm と同じ式。
export function scaleSpacingKmNode(depthKm: FloatNode, weights: ScaleRegimeWeightNodes): FloatNode {
  const logAspect = weights.closed.mul(log(CLOUD_TUNING.scaleAspectClosed))
    .add(weights.open.mul(log(CLOUD_TUNING.scaleAspectOpen)))
    .add(weights.roll.mul(log(CLOUD_TUNING.scaleAspectRoll)))
    .add(weights.wave.mul(log(CLOUD_TUNING.scaleAspectWave)));
  return depthKm.mul(exp(logAspect));
}

// 鱗が立つ強さ 0..1。基準式 scaleGate と同じ式。
export function scaleGateNode(shear: FloatNode, instability: FloatNode): FloatNode {
  return smoothstep(
    CLOUD_TUNING.scaleGateOnset, CLOUD_TUNING.scaleGateFull,
    max(instability, shear.mul(instability.oneMinus())),
  );
}
