// 雲の光学計算を TSL ノードへ接続するアダプタ。基準式は cloud-optics.ts で定義し、ここでは同じ式を
// シェーダグラフのノードとして構成する。
import { abs, exp, log, max, min, pow, sqrt } from 'three/tsl';
import {
  CLOUD_ASYMMETRY, LOW_CLOUD_OPTICAL_DEPTH_EXPONENT, LOW_CLOUD_OPTICAL_DEPTH_PER_KM, MAX_COLUMN_COVERAGE,
  MAX_LOW_CLOUD_OPTICAL_DEPTH,
} from './cloud-optics';
import type { FloatNode } from '../tsl-types';

// 積雲の被覆率を鉛直柱光学深さへ変換するGPU版。
export function columnOpticalDepthFromCoverageNode(coverage: FloatNode): FloatNode {
  return log(min(coverage, MAX_COLUMN_COVERAGE).oneMinus()).negate();
}

// 鉛直柱光学深さと視線airmassから、イベント1回ぶんの透過率を得るGPU版。
export function transmittanceFromColumnOpticalDepthNode(
  columnOpticalDepth: FloatNode, airmass: FloatNode,
): FloatNode {
  return exp(max(columnOpticalDepth, 0).mul(max(airmass, 0)).negate());
}

// 球殻の厚みを通る視線airmass。CPUのshellAirmassと同じく接線付近を有限化する。
export function shellAirmassNode(
  cosine: FloatNode, thickness: FloatNode, radius: FloatNode,
): FloatNode {
  const safeRadius = max(radius, Number.EPSILON);
  const grazingCosine = sqrt(max(thickness, Number.EPSILON).div(safeRadius.mul(2)));
  return max(max(abs(cosine), grazingCosine), Number.EPSILON).reciprocal();
}

// 鉛直柱光学深さ tau の雲層の反射率のGPU版。
export function cloudReflectanceNode(columnOpticalDepth: FloatNode): FloatNode {
  const scaled = max(columnOpticalDepth, 0).mul(3 * (1 - CLOUD_ASYMMETRY));
  return scaled.div(scaled.add(4));
}

// 雲底から雲頂までの厚み depth [m] の下層の雲の鉛直柱光学深さのGPU版。
export function lowCloudOpticalDepthNode(depth: FloatNode): FloatNode {
  return min(
    pow(max(depth, 0).div(1000), LOW_CLOUD_OPTICAL_DEPTH_EXPONENT).mul(LOW_CLOUD_OPTICAL_DEPTH_PER_KM),
    MAX_LOW_CLOUD_OPTICAL_DEPTH);
}
