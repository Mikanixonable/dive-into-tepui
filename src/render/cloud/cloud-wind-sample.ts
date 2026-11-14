// 風テクスチャの生成値と焼いたテクスチャの読み値。風速は m/s、陸海は 0..1 で扱い、
// RGBA の配置を表現側へ漏らさない。
import { vec2, vec4 } from 'three/tsl';
import type { FloatNode, Vec2Node, Vec4Node } from '../tsl-types';

// 地表風の尺度。風速 [m/s] の正負の両端。lab の風ビューも同じ尺度で風を描く。
export const WIND_SPAN = 45;

// 描画時の風の標本。wind は (東, 北) 成分の地表風 [m/s]、land は陸らしさ 0..1。
export interface WindSample {
  readonly wind: Vec2Node;
  readonly land: FloatNode;
}

// 焼いた風テクスチャの RGBA を、生成側と同じ単位の風標本へ戻す。
export function windSampleFromTexel(texel: Vec4Node): WindSample {
  return {
    wind: vec2(texel.r, texel.g).sub(0.5).mul(2 * WIND_SPAN),
    land: texel.b,
  };
}

// 風標本を焼き込み用の RGBA へ戻す。読み出し側の復号と同じ契約をここで対にして持つ。
export function windTexelFromSample(sample: WindSample): Vec4Node {
  return vec4(sample.wind.div(2 * WIND_SPAN).add(0.5), sample.land, 1);
}
