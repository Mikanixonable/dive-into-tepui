import { vec4 } from 'three/tsl';
import { CLOUD_TOP_SPAN } from './cumulus-shape';
import type { FloatNode, Vec4Node } from '../tsl-types';

// 雲場の生成値と焼いたテクスチャの読み値。高度はメートルで扱い、2 枚の RGBA への配置を表現側へ漏らさない。
// 下層は被覆率・雲頂と形態(セル性・活力)、上層は光学的厚み・高さと形態(繊維性・滑らかさ)を持つ。
export type CloudSample = {
  // 下層の雲が柱を覆う割合 0..1。
  readonly coverage: FloatNode;
  // 下層の雲頂の高度 [m]。
  readonly cloudTop: FloatNode;
  // 下層の雲が一枚の板(0)か、ばらばらの対流セル(1)か。
  readonly cellularity: FloatNode;
  // 下層の雲がどれだけ勢いよく盛り上がっているか 0..1。
  readonly vigor: FloatNode;
  // 上層の雲の鉛直柱光学深さ。
  readonly upperOpticalDepth: FloatNode;
  // 上層の雲の高度 [m]。
  readonly upperAltitude: FloatNode;
  // 上層の雲が流れに沿った繊維(1)か、ぼやけた幕(0)か。
  readonly fibrousness: FloatNode;
  // 上層の雲が平らで滑らかな天蓋(1、かなとこ)か 0..1。
  readonly smoothness: FloatNode;
};

// 焼いた雲場の下層・上層の RGBA の対。
export interface CloudFieldTexels {
  readonly lower: Vec4Node;
  readonly upper: Vec4Node;
}

// 焼いた雲場の RGBA の対を、生成側と同じ単位の雲標本へ戻す。
export function cloudSampleFromTexels(texels: CloudFieldTexels): CloudSample {
  return {
    coverage: texels.lower.r,
    cloudTop: texels.lower.g.mul(CLOUD_TOP_SPAN),
    cellularity: texels.lower.b,
    vigor: texels.lower.a,
    upperOpticalDepth: texels.upper.r,
    upperAltitude: texels.upper.g.mul(CLOUD_TOP_SPAN),
    fibrousness: texels.upper.b,
    smoothness: texels.upper.a,
  };
}

// 雲標本を焼き込み用の RGBA の対へ戻す。読み出し側の復号と同じ契約をここで対にして持つ。
export function cloudFieldTexelsFromSample(sample: CloudSample): CloudFieldTexels {
  return {
    lower: vec4(sample.coverage, sample.cloudTop.div(CLOUD_TOP_SPAN), sample.cellularity, sample.vigor),
    upper: vec4(sample.upperOpticalDepth, sample.upperAltitude.div(CLOUD_TOP_SPAN), sample.fibrousness, sample.smoothness),
  };
}
