// 雲の場を読む規則と、雲を材質として見たときの明るさ。場の階調は濃さではなく「その texel が
// 雲に覆われている割合」なので、どこから不透明な雲になるか・雲頂がどの高さに立つか・場をどの
// 細かさで引くかをここが決める。積雲の殻・その影・大気へ挟む散乱の層は、同じ形と同じ明るさを
// ここから引く。
import * as THREE from 'three/webgpu';
import { clamp, float, log, log2, max, min, smoothstep, uniform } from 'three/tsl';
import { gradientNoise } from './gradient-noise';
import type { FloatNode, FloatUniform, Vec3Node } from '../tsl-types';

// 雲のアルベド。厚い雲の白さは多重散乱の産物で、単散乱アルベド ≈ 1・光学的厚みが十分に大きい
// 層の反射は拡散反射の極限へ漸近する。
export const CLOUD_ALBEDO = 0.8;

// 場を持たない天体のスロットへ結ぶ、被覆率 0 の写し。**読み方の契約は本物の場と揃える** —
// シェーダグラフはここに結んだテクスチャのフィルタと巻きから組まれるので、既定の Nearest の
// ままだと補間の無い texel フェッチが焼き込まれ、あとで本物へ差し替えても格子が出たままになる。
export const EMPTY_CLOUD_FIELD = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
EMPTY_CLOUD_FIELD.minFilter = THREE.LinearMipmapLinearFilter;
EMPTY_CLOUD_FIELD.magFilter = THREE.LinearFilter;
EMPTY_CLOUD_FIELD.wrapS = THREE.RepeatWrapping;
EMPTY_CLOUD_FIELD.needsUpdate = true;

// 柱の光学的厚みへ直すときに割合へ張る上限。
const MAX_COLUMN_COVERAGE = 0.99;

// 場の G(雲頂高度)を実寸へ戻す上限 [m]。場の G 自体は 0..1 で持つ。
export const CLOUD_TOP_SPAN = 15000;

// 被覆率を二値化する境目(center)と、その前後でディザへ渡す半幅(halfWidth)。被覆率が
// center±halfWidth に入る柱だけがディザに掛かり、外は 0 か 1 へ飽和する。どちらも目で追い込んだ
// 値で、場を差し替えたら追い込み直す。
//
// **仮設**: render-lab のつまみ(tools/render-lab/main.ts)から動かせるよう uniform にしてある。
// 生成側の場へ差し替えたあとにもう一段の追い込みが要るので、それまでは畳まない。
export const CUMULUS_DITHER_KNOB: {
  readonly center: FloatUniform;
  readonly halfWidth: FloatUniform;
} = { center: uniform(0.34), halfWidth: uniform(0.12) };

// 粒が被覆率と雲頂高度をそれぞれどれだけ振るか(どちらも場と同じ 0..1 の目盛り)。生成側が高周波を
// 持つようになったら、この 2 つを縮めて譲る。
const GRAIN_COVERAGE_DEPTH = 0.25;
const GRAIN_TOP_RELIEF = 0.15;

// 積雲の粒の一辺 [m]。場の texel(赤道 9.8 km)より細かく、かつ低軌道から見下ろして解像できる
// 大きさ(高度 900km 以下で全振幅)に取る。これより細かくすると、実際の積雲の塊には近づく代わりに
// 軌道上のどの構図でも 1 画素を切って消える。
export const CUMULUS_GRAIN_SIZE = 6000;

// 場の G が 8bit で持つ刻み(場と同じ 0..1 の目盛り)。
const FIELD_TOP_STEP = 1 / 256;

// 粒を引かない読み手から見た、雲頂の高さの不確かさ(場と同じ 0..1 の目盛り)。粒が雲頂を振る
// 幅と、場の刻みの和。**この幅に入る受け手は雲頂に立っていると見なしてよい。**
export const CLOUD_TOP_UNCERTAINTY = GRAIN_TOP_RELIEF + FIELD_TOP_STEP;

// 天体固定の単位方向における粒 −1..1 に amplitude を掛けたもの。frequency は 1 rad あたりの
// 山の数(天体の基準半径 / CUMULUS_GRAIN_SIZE)。
export function grainAt(
  direction: Vec3Node, frequency: FloatNode | number, amplitude: FloatNode,
): FloatNode {
  return gradientNoise(direction.mul(frequency)).mul(amplitude);
}

// 標本 1 つが実寸 width [m] を張る読み手が場を引く mip 段。texel の実寸は正距円筒に固有の式で、
// 半径 radius の赤道の 1 行(2πR を場の幅 fieldWidth [texel] で割る)を基準に取る — 極では
// 1 texel の経度方向の実寸がこれより cos(緯度) ぶん狭いので、段はそのぶん細かい側へ寄る。
export function fieldLodForWidth(
  width: FloatNode, radius: FloatNode, fieldWidth: FloatNode,
): FloatNode {
  return max(log2(width.div(max(radius.mul(2 * Math.PI).div(fieldWidth), 1))), float(0));
}

// 標本 1 つが実寸 width [m] を張る読み手が引ける粒の振幅 0..1。幅が粒の 1 波長までは全振幅、
// 2 波長を超えると標本の中で粒が均されるので 0。標本が光路上に散って画面の隣の画素と揃わない
// 読み手向けなので、境目は画面の標本化の Nyquist より緩い。
export function grainAmplitudeForWidth(width: FloatNode): FloatNode {
  return smoothstep(CUMULUS_GRAIN_SIZE, 2 * CUMULUS_GRAIN_SIZE, width).oneMinus();
}

// 粒を重ねた被覆率を、境目の前後 halfWidth で 0..1 へ伸ばした「覆い尽くされている割合」。grain は
// amplitude を掛けたあとの粒で、**境目を通す前に足す** — 通したあとに足すと、覆いの無い空にも粒が
// 雲を生やす。粒を引けない読み手は grain 0 で場の被覆率をそのまま通してよい — 粒は釣鐘型に散る
// ので、粒で千切った雲を均した平均はこの斜面で近似できる。
export function opaqueFractionOf(coverage: FloatNode, grain: FloatNode): FloatNode {
  const band = CUMULUS_DITHER_KNOB.halfWidth.mul(2);
  return saturatedBand(coverage.add(grain.mul(GRAIN_COVERAGE_DEPTH)), band);
}

// 場の雲頂高度へ粒の起伏を重ねた雲頂高度 0..1。
export function cloudTopOf(fieldTop: FloatNode, grain: FloatNode): FloatNode {
  return clamp(fieldTop.add(grain.mul(GRAIN_TOP_RELIEF)), 0, 1);
}

// 覆われている割合を、その柱を光が通り抜けない確率と読んだときの光学的厚み。割合 1 では
// 発散するので、その手前で頭打ちにする。
export function columnOpticalDepth(coverage: FloatNode): FloatNode {
  return log(min(coverage, MAX_COLUMN_COVERAGE).oneMinus()).negate();
}

// 境目の前後 band で 0 から 1 へ渡す。band は 0 を取れない(割り算が NaN へ落ちる)。
// **幅は境目の 2 倍で止める** — 斜面の下端が負へ伸びると、覆いの無い柱(被覆率 0)まで正の割合を
// 返す。2 倍なら下端がちょうど 0 で止まり、境目の位置は動かない。
function saturatedBand(coverage: FloatNode, band: FloatNode): FloatNode {
  const center = CUMULUS_DITHER_KNOB.center;
  const clampedBand = min(band, center.mul(2));
  return clamp(coverage.sub(center.sub(clampedBand.mul(0.5))).div(clampedBand), 0, 1);
}
