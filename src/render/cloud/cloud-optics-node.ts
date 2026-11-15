// 雲の光学計算を TSL ノードへ接続するアダプタ。基準式は cloud-optics.ts で定義し、ここでは同じ式を
// シェーダグラフのノードとして構成する。
import { abs, clamp, max, sqrt } from 'three/tsl';
import type { FloatNode } from '../tsl-types';

// 保存散乱の層が拡散入射へ返す光の割合 R = γτ/(1 + γτ) の GPU 版。透過率は 1 − R。
export function cloudReflectanceNode(opticalDepth: FloatNode, asymmetry: number): FloatNode {
  const scaled = max(opticalDepth, 0).mul(0.75 * (1 - asymmetry));
  return scaled.div(scaled.add(1));
}

// 反射率と柱内の経路割合から、柱の一部が通す光の割合を得る。
export function fractionalTransmittanceNode(
  reflectedFraction: FloatNode, pathFraction: FloatNode,
): FloatNode {
  return clamp(reflectedFraction, 0, 1).oneMinus().pow(max(pathFraction, 0));
}

// 球殻の厚みを通る視線airmass。CPUのshellAirmassと同じく接線付近を有限化する。
export function shellAirmassNode(
  cosine: FloatNode, thickness: FloatNode, radius: FloatNode,
): FloatNode {
  const safeRadius = max(radius, Number.EPSILON);
  const grazingCosine = sqrt(max(thickness, Number.EPSILON).div(safeRadius.mul(2)));
  return max(max(abs(cosine), grazingCosine), Number.EPSILON).reciprocal();
}
