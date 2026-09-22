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

// 雲場の生成値と焼いたテクスチャの読み値。coverage と cloudTop は basis の重み付け前の形状値なので、
// basis から導出せず専用 shape テクスチャから読む。translucent は basis から導出する。
export interface CloudSample {
  readonly basis: CloudBasis;
  readonly coverage: FloatNode;
  readonly cloudTop: FloatNode;
  readonly translucent: FloatNode;
}

const LOW_CLOUD_TOP = 1_000;
// basis テクスチャと shape テクスチャから、既存の表現が必要とする連続量を導出する。
// 2 つは同じ CloudSample として surface / atmosphere / shadow が読むため、経路ごとの channel 解釈を増やさない。
export function cloudSampleFromTexels(basisTexel: Vec4Node, shapeTexel: Vec4Node): CloudSample {
  const basis: CloudBasis = {
    low: basisTexel.r,
    middle: basisTexel.g,
    convective: basisTexel.b,
    inSitu: basisTexel.a,
  };
  const coverage = clamp(shapeTexel.r, 0, 1);
  return {
    basis,
    coverage,
    cloudTop: max(clamp(shapeTexel.g, 0, 1).mul(CLOUD_TOP_SPAN), LOW_CLOUD_TOP),
    translucent: basis.inSitu.add(basis.convective.mul(0.25)).min(1),
  };
}

// 雲標本の basis を焼き込み用のRGBAへ戻す。coverage / cloudTop は shape へ焼く。
export function cloudBasisTexelFromSample(sample: CloudSample): Vec4Node {
  return vec4(sample.basis.low, sample.basis.middle, sample.basis.convective, sample.basis.inSitu);
}

// 雲標本の形状値をRGへ戻す。Rはcoverage、GはcloudTopの正規化値。
export function cloudShapeTexelFromSample(sample: CloudSample): Vec4Node {
  return vec4(sample.coverage, sample.cloudTop.div(CLOUD_TOP_SPAN), 0, 1);
}
