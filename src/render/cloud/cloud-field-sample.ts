import { vec4 } from 'three/tsl';
import { CLOUD_TOP_SPAN } from './cumulus-shape';
import type { FloatNode, Vec4Node } from '../tsl-types';

// 雲場の生成値と焼いたテクスチャの読み値。雲頂高度はメートル、cellSizeVariationは地域別のセル幅
// プロファイル(0..1)として扱い、RGBAの配置を表現側へ漏らさない。
export type CloudSample = {
  readonly coverage: FloatNode;
  readonly cloudTop: FloatNode;
  readonly translucent: FloatNode;
  // 積雲のセル幅プロファイルを 0..1 で表す。値は雲場とともに補間され、表面・雲影で代表幅と分散へ戻す。
  readonly cellSizeVariation: FloatNode;
};

// 焼いた雲場のRGBAを、生成側と同じ単位の雲標本へ戻す。
export function cloudSampleFromTexel(texel: Vec4Node): CloudSample {
  return {
    coverage: texel.r,
    cloudTop: texel.g.mul(CLOUD_TOP_SPAN),
    translucent: texel.b,
    cellSizeVariation: texel.a,
  };
}

// 雲標本を焼き込み用のRGBAへ戻す。読み出し側の復号と同じ契約をここで対にして持つ。
export function cloudFieldTexelFromSample(sample: CloudSample): Vec4Node {
  return vec4(
    sample.coverage,
    sample.cloudTop.div(CLOUD_TOP_SPAN),
    sample.translucent,
    sample.cellSizeVariation,
  );
}
