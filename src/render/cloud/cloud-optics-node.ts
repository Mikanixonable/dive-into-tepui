// 雲の光学計算を TSL ノードへ接続するアダプタ。基準式は cloud-optics.ts で定義し、ここでは同じ式を
// シェーダグラフのノードとして構成する。
import { abs, exp, log, max, min, sqrt } from 'three/tsl';
import { MAX_COLUMN_COVERAGE } from './cloud-optics';
import type { CloudBasis } from './cloud-field-sample';
import { CLOUD_MODEL_PARAMETERS } from './cloud-model-parameters';
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

// CloudSample の4 basisを共通の optical column へ写す。上層 basis は液相柱へ直接足さない。
export function cloudBasisColumnOpticalDepthNode(
  basis: CloudBasis, liquidWeight: FloatNode, iceWeight: FloatNode,
): FloatNode {
  const opaque = columnOpticalDepthFromCoverageNode(
    basis.low.add(basis.middle).add(basis.convective.mul(0.8)),
  ).mul(liquidWeight).mul(CLOUD_MODEL_PARAMETERS.liquidTauScale);
  const ice = basis.inSitu.add(basis.convective.mul(0.25))
    .mul(iceWeight).mul(CLOUD_MODEL_PARAMETERS.iceTauScale);
  return opaque.add(ice);
}
