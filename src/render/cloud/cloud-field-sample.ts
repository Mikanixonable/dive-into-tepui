import { clamp, max, vec4 } from 'three/tsl';
import { CLOUD_TOP_SPAN } from './cumulus-shape';
import type { FloatNode, Vec4Node } from '../tsl-types';

// 雲場のRGBAを、排他的な雲種ではなく連続した鉛直 basis として扱う。
// low / middle / convective は不透明雲の coverage を分担し、inSitu は独立した上層雲を表す。
export interface CloudBasis {
  readonly low: FloatNode;
  readonly middle: FloatNode;
  readonly convective: FloatNode;
  readonly inSitu: FloatNode;
}

// 雲場の生成値と焼いたテクスチャの読み値。互換性のため coverage / cloudTop / translucent も公開するが、
// それらは basis から導出され、RGBAの意味を各表現へ複製しない。
export interface CloudSample {
  readonly basis: CloudBasis;
  readonly coverage: FloatNode;
  readonly cloudTop: FloatNode;
  readonly translucent: FloatNode;
}

const LOW_CLOUD_TOP = 1_000;
const MIDDLE_CLOUD_TOP = 6_000;
const CONVECTIVE_CLOUD_TOP = CLOUD_TOP_SPAN;

// basis から既存の表現が必要とする連続量を導出する。4 成分は同じ CloudSample を surface / atmosphere /
// shadow が読むため、どの経路も別々の channel 解釈を持たない。
export function cloudSampleFromTexel(texel: Vec4Node): CloudSample {
  const basis: CloudBasis = {
    low: texel.r,
    middle: texel.g,
    convective: texel.b,
    inSitu: texel.a,
  };
  const coverage = clamp(basis.low.add(basis.middle).add(basis.convective), 0, 1);
  const weightedTop = basis.low.mul(LOW_CLOUD_TOP)
    .add(basis.middle.mul(MIDDLE_CLOUD_TOP))
    .add(basis.convective.mul(CONVECTIVE_CLOUD_TOP));
  return {
    basis,
    coverage,
    cloudTop: max(weightedTop.div(max(coverage, 1e-4)), LOW_CLOUD_TOP),
    translucent: basis.inSitu.add(basis.convective.mul(0.25)).min(1),
  };
}

// 雲標本を焼き込み用のRGBAへ戻す。読み出し側の復号と同じ契約をここで対にして持つ。
export function cloudFieldTexelFromSample(sample: CloudSample): Vec4Node {
  return vec4(sample.basis.low, sample.basis.middle, sample.basis.convective, sample.basis.inSitu);
}
