import { vec2, vec4 } from 'three/tsl';
import type { FloatNode, Vec2Node, Vec4Node } from '../tsl-types';

// 雲場の生成値と焼いたテクスチャの読み値。雲は種類ごとの量(0..1)で持ち、RGBAの配置を
// 表現側へ漏らさない。雲頂高度・光学的厚み・不透明度は量から種類別の曲線(cloud-kind.ts)が導く。
export interface CloudSample {
  // 積雲の量。大きいほど雲頂が高く不透明になる。
  readonly cumulus: FloatNode;
  // 巻雲の量。大きいほど雲頂が高く不透明になる。
  readonly cirrus: FloatNode;
  // 巻雲の筋の向き θ の倍角ベクトル (cos 2θ, sin 2θ) × 揃い度(0..1)。局所の東・北の基底で
  // 符号付き(−1..1)。向きの無い所は 0 ベクトル。組み方の基準式は cirrus-flow.ts。
  readonly cirrusFlow: Vec2Node;
}

// 焼いた雲場のRGBA(R = 積雲、G = 巻雲、B・A = 筋の倍角ベクトル)を、生成側と同じ単位の
// 雲標本へ戻す。写しは半精度なので、倍角ベクトルは符号付き(−1..1)のまま入っている。
export function cloudSampleFromTexel(texel: Vec4Node): CloudSample {
  return {
    cumulus: texel.r,
    cirrus: texel.g,
    cirrusFlow: vec2(texel.b, texel.a),
  };
}

// 雲標本を焼き込み用のRGBAへ戻す。読み出し側の復号と同じ契約をここで対にして持つ。
export function cloudFieldTexelFromSample(sample: CloudSample): Vec4Node {
  return vec4(sample.cumulus, sample.cirrus, sample.cirrusFlow.x, sample.cirrusFlow.y);
}
