import type * as THREE from 'three/webgpu';
import { max, mix, vec2, vec4 } from 'three/tsl';
import { cirrusAmountFromOpticalDepthNode, cirrusColumnOpticalDepthNode } from './cloud-kind-node';
import type { FloatNode, Vec2Node, Vec4Node } from '../../tsl-types';

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
  // 積雲の対流セルの大きさ log2(km)。0..1 へ畳まない生値で、焼いた写しの線形補間が径の幾何平均になる。
  readonly cumulusCell: FloatNode;
  // 巻雲の要素径(繊維・鱗のピッチ) log2(km)。0..1 へ畳まない生値。
  readonly cirrusCell: FloatNode;
  // 陸らしさ(0 が海、1 が陸)。生成時の値は天気の landFraction。
  readonly land: FloatNode;
  // 対流の活発さ 0..1。生成時の値は天気の convectiveActivity。
  readonly convection: FloatNode;
  // 気候の雲量 0..1(平年の雲の多さ。砂漠で小さい)。生成時の値は天気の meanCloudiness。
  readonly climateCloudiness: FloatNode;
  // 金床の濃さ 0..1。脱出水のベールが乗った所ではベールの強さを採る。
  readonly anvil: FloatNode;
  // その柱が上層へ放出する氷雲の強さ 0..1。脱出水ベールの写しを焼くときの源になる。
  readonly detrain: FloatNode;
  // 渦の目の濃さ 0..1。脱出水ベールは眼の上へ掛けない門になる。
  readonly eye: FloatNode;
  // 前線・暖気の盾 0..1(前線の上で暖気が流入し、閉塞の芯でない所)。
  readonly shield: FloatNode;
  // 上層の不安定度の代理量 0..1(対流・斑・上昇から作る)。
  readonly upperInstability: FloatNode;
  // 巻雲の鱗の層の深さ [km]。
  readonly layerDepthKm: FloatNode;
}

// 焼いた雲場の 1 枚ぶん。雲・風・環境・セル径・診断量の写しは同じ時刻と cap で焼かれている。
// veil は脱出水が発散と移流で広がった氷雲の写し。雲を持たない場は空の写しを結ぶ。
export interface CloudFieldSlot {
  readonly cloud: THREE.Texture;
  readonly motion: THREE.Texture;
  readonly environment: THREE.Texture;
  readonly cellSize: THREE.Texture;
  readonly veil: THREE.Texture;
  readonly regime: THREE.Texture;
}

// 層の深さ [km] を焼き込み用の 0..1 へ写す除数。半精度に収まる範囲へ畳むための固定の値。焼く側と読む側が共有する。
export const LAYER_DEPTH_TEXEL_SCALE_KM = 4;

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

// 雲の texel へ脱出水ベールの写しを合成した値。氷雲は巻雲の一種として表すので、巻雲の
// 柱の光学深さをベールのぶん足して量へ戻す — 厚いかなとこは下地をほとんど隠す幕まで連続する
// (DEVELOP/SPEC/RENDERING.md「対流雲は下層から発達する」)。veil の R がベールの強さ。
export function cloudTexelWithVeil(cloudTexel: Vec4Node, veilTexel: Vec4Node): Vec4Node {
  const cirrus = cirrusAmountFromOpticalDepthNode(
    cirrusColumnOpticalDepthNode(cloudTexel.g).add(cirrusColumnOpticalDepthNode(veilTexel.r)));
  return vec4(cloudTexel.r, cirrus, cloudTexel.b, cloudTexel.a);
}

// 焼いた雲場のRGBA(R = 積雲、G = 巻雲、B・A = 筋の倍角ベクトル)と環境のRGBA(R = 陸、G = 対流、
// B = 気候の雲量、A = 金床)とセル径のRGBA(R・G = セル径・要素径 log2(km)、B = 脱出水の源、
// A = 渦の眼)と脱出水ベールの写し(R = ベールの強さ)と診断量の写し(R = 盾、G = 上層の不安定度、
// B = 層の深さ / LAYER_DEPTH_TEXEL_SCALE_KM)を、雲標本へ戻す。写しは半精度なので、
// 倍角ベクトルは符号付き(−1..1)のまま入っている。
export function cloudSampleFromTexels(
  cloudTexel: Vec4Node, environmentTexel: Vec4Node, cellTexel: Vec4Node, veilTexel: Vec4Node,
  regimeTexel: Vec4Node,
): CloudSample {
  // ベールは巻雲の柱へ合成し、金床へは強い方を採る。
  const merged = cloudTexelWithVeil(cloudTexel, veilTexel);
  return {
    cumulus: merged.r,
    cirrus: merged.g,
    cirrusFlow: vec2(merged.b, merged.a),
    cumulusCell: cellTexel.r,
    cirrusCell: cellTexel.g,
    land: environmentTexel.r,
    convection: environmentTexel.g,
    climateCloudiness: environmentTexel.b,
    anvil: max(environmentTexel.a, veilTexel.r),
    detrain: cellTexel.b,
    eye: cellTexel.a,
    shield: regimeTexel.r,
    upperInstability: regimeTexel.g,
    layerDepthKm: regimeTexel.b.mul(LAYER_DEPTH_TEXEL_SCALE_KM),
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

// 雲標本のセル径と脱出水の源・渦の眼を焼き込み用のRGBAへ戻す。セル径は log2(km) の生値を
// R・G へ、脱出水の源を B、眼の濃さを A へ入れる。cloudSampleFromTexels の復号と対。
export function cloudCellTexel(sample: CloudSample): Vec4Node {
  return vec4(sample.cumulusCell, sample.cirrusCell, sample.detrain, sample.eye);
}

// 雲標本の診断量を焼き込み用のRGBAへ戻す。層の深さは LAYER_DEPTH_TEXEL_SCALE_KM で割って 0..1 へ写し、
// A は予約で 0。cloudSampleFromTexels の復号と対。
export function cloudRegimeTexel(sample: CloudSample): Vec4Node {
  return vec4(sample.shield, sample.upperInstability, sample.layerDepthKm.div(LAYER_DEPTH_TEXEL_SCALE_KM), 0);
}

// 焼いた風の RGBA(R・G = 地表付近、B・A = 上層)を風へ戻す。
export function cloudMotionFromTexel(texel: Vec4Node): CloudMotion {
  return { surfaceWind: vec2(texel.r, texel.g), upperWind: vec2(texel.b, texel.a) };
}

// 風を焼き込み用の RGBA へ。
export function cloudMotionTexel(motion: CloudMotion): Vec4Node {
  return vec4(motion.surfaceWind.x, motion.surfaceWind.y, motion.upperWind.x, motion.upperWind.y);
}
