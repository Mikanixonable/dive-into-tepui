// 雲の光学契約をTSLへ写すアダプター。数値の基準式はcloud-optics.tsに置き、ここでは同じ式を
// シェーダグラフのノードとして組み立てる。CPUの光学テストへThree/TSLを持ち込まないための境界。
import { abs, exp, log, max, min, sqrt } from 'three/tsl';
import { MAX_COLUMN_COVERAGE } from './cloud-optics';
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
