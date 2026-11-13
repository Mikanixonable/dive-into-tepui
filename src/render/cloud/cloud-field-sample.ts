import { vec4 } from 'three/tsl';
import type { FloatNode, Vec4Node } from '../tsl-types';

// 雲場の生成値と焼いたテクスチャの読み値。雲は種類ごとの量(0..1)で持ち、RGBAの配置を
// 表現側へ漏らさない。雲頂高度・光学的厚み・不透明度は量から種類別の曲線(cloud-kind.ts)が導く。
export interface CloudSample {
  // 積雲の量。大きいほど雲頂が高く不透明になる。
  readonly cumulus: FloatNode;
  // 巻雲の量。大きいほど雲頂が高く不透明になる。
  readonly cirrus: FloatNode;
}

// 焼いた雲場のRGBA(R = 積雲、G = 巻雲)を、生成側と同じ単位の雲標本へ戻す。
export function cloudSampleFromTexel(texel: Vec4Node): CloudSample {
  return {
    cumulus: texel.r,
    cirrus: texel.g,
  };
}

// 雲標本を焼き込み用のRGBAへ戻す。読み出し側の復号と同じ契約をここで対にして持つ。
export function cloudFieldTexelFromSample(sample: CloudSample): Vec4Node {
  return vec4(sample.cumulus, sample.cirrus, 0, 1);
}
