import type * as THREE from 'three/webgpu';
import { mix, vec2, vec4 } from 'three/tsl';
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
  // 陸らしさ(0 が海、1 が陸)。生成時の値は天気の landFraction。
  readonly land: FloatNode;
  // 対流の活発さ 0..1。生成時の値は天気の convectiveActivity。
  readonly convection: FloatNode;
  // 気候の雲量 0..1(平年の雲の多さ。砂漠で小さい)。生成時の値は天気の meanCloudiness。
  readonly climateCloudiness: FloatNode;
  // 金床の濃さ 0..1。生成時の値は天気の anvil。
  readonly anvil: FloatNode;
}

// 焼いた雲場の 1 枚ぶん。雲・風・環境の写しは同じ時刻と cap で焼かれている。
export interface CloudFieldSlot {
  readonly cloud: THREE.Texture;
  readonly motion: THREE.Texture;
  readonly environment: THREE.Texture;
}

// 焼いた雲場の 2 枚の混ぜ方。parity は古い側の枚の番号(0 か 1)、fraction は古い側から新しい側への混合比(0..1)。
// 源が毎フレーム書き換えるので、読み手は読んだ時点の値を使う。
export interface CloudBlend {
  parity: 0 | 1;
  fraction: number;
}

// 雲を運ぶ風。低い雲を運ぶ地表付近の風と、巻雲を運ぶ上層の風の、局所の東・北の成分 [m/s]。
// 止まった雲場(実写)では 0。
export interface CloudMotion {
  readonly surfaceWind: Vec2Node;
  readonly upperWind: Vec2Node;
}

// 焼いた 2 枚の RGBA を、古い側の枚 parity と混合比 fraction で混ぜる。古い側と新しい側の役割を
// parity で入れ替え、テクスチャの参照は 2 枚のまま固定する。
export function blendBakedTexels(a: Vec4Node, b: Vec4Node, parity: FloatNode, fraction: FloatNode): Vec4Node {
  const older = mix(a, b, parity);
  const newer = mix(b, a, parity);
  return mix(older, newer, fraction);
}

// 焼いた雲場のRGBA(R = 積雲、G = 巻雲、B・A = 筋の倍角ベクトル)と環境のRGBA(R = 陸、G = 対流、
// B = 気候の雲量、A = 金床)を、雲標本へ戻す。写しは半精度なので、倍角ベクトルは符号付き(−1..1)のまま入っている。
export function cloudSampleFromTexels(cloudTexel: Vec4Node, environmentTexel: Vec4Node): CloudSample {
  return {
    cumulus: cloudTexel.r,
    cirrus: cloudTexel.g,
    cirrusFlow: vec2(cloudTexel.b, cloudTexel.a),
    land: environmentTexel.r,
    convection: environmentTexel.g,
    climateCloudiness: environmentTexel.b,
    anvil: environmentTexel.a,
  };
}

// 雲標本を焼き込み用のRGBAへ戻す。読み出し側の復号と同じ契約をここで対にして持つ。
export function cloudFieldTexelFromSample(sample: CloudSample): Vec4Node {
  return vec4(sample.cumulus, sample.cirrus, sample.cirrusFlow.x, sample.cirrusFlow.y);
}

// 雲標本の環境の量を焼き込み用のRGBAへ戻す。cloudSampleFromTexels の復号と対。
export function cloudEnvironmentTexel(sample: CloudSample): Vec4Node {
  return vec4(sample.land, sample.convection, sample.climateCloudiness, sample.anvil);
}

// 焼いた風の RGBA(R・G = 地表付近、B・A = 上層)を風へ戻す。
export function cloudMotionFromTexel(texel: Vec4Node): CloudMotion {
  return { surfaceWind: vec2(texel.r, texel.g), upperWind: vec2(texel.b, texel.a) };
}

// 風を焼き込み用の RGBA へ。
export function cloudMotionTexel(motion: CloudMotion): Vec4Node {
  return vec4(motion.surfaceWind.x, motion.surfaceWind.y, motion.upperWind.x, motion.upperWind.y);
}
