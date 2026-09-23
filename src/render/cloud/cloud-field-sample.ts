import { vec4 } from 'three/tsl';
import { CLOUD_TOP_SPAN } from './cumulus-shape';
import type { FloatNode, Vec4Node } from '../tsl-types';

// 雲場の1鉛直柱を表すマクロ契約。液相と氷相を別に持ち、描画側はRGBAの配置を知らない。
// coverage は厚い液相雲の柱被覆、cloudTop / iceCenter は高度[m]、iceOpticalDepth は
// 上層氷雲の鉛直光学深さ。細かな3D構造は CloudDensityEvaluator がこの柱量から導く。
export type CloudSample = {
  readonly coverage: FloatNode;
  readonly cloudTop: FloatNode;
  readonly iceOpticalDepth: FloatNode;
  readonly iceCenter: FloatNode;
};

// 焼いた雲場のRGBAを、生成側と同じ単位の雲標本へ戻す。
export function cloudSampleFromTexel(texel: Vec4Node): CloudSample {
  return {
    coverage: texel.r,
    cloudTop: texel.g.mul(CLOUD_TOP_SPAN),
    iceOpticalDepth: texel.b,
    iceCenter: texel.a.mul(CLOUD_TOP_SPAN),
  };
}

// 雲標本を焼き込み用のRGBAへ戻す。読み出し側の復号と同じ契約をここで対にして持つ。
export function cloudFieldTexelFromSample(sample: CloudSample): Vec4Node {
  return vec4(
    sample.coverage,
    sample.cloudTop.div(CLOUD_TOP_SPAN),
    sample.iceOpticalDepth,
    sample.iceCenter.div(CLOUD_TOP_SPAN),
  );
}
