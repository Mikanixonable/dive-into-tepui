// 雲の場(R = 被覆率、G = 雲頂高度)を、不透明な積雲の形として読む規則。場の階調は濃さではなく
// 「その texel が雲に覆われている割合」なので、どこから不透明な雲になるかと、雲頂がどの高さに
// 立つかをここが決める。雲を描く側と、その雲が落とす影を引く側が、同じ形を見るための場。
import { clamp } from 'three/tsl';
import type { FloatNode } from '../tsl-types';

// 場の G(雲頂高度)が張る高さ [m]。
export const CLOUD_TOP_SPAN = 15000;

// 被覆率を二値化する境目と、その周りでディザへ渡す幅。**境目は場の被覆率の平均を動かさない
// ように選ぶ** — 実写を分離した `src/assets/cloud-field.png` では、これを超える texel の面積が
// 被覆率の平均 0.125(緯度余弦で重みを付けた面積平均)に一致する。場を差し替えたら測り直す。
// 幅は粒が届かない遠さでの縁の当たりを和らげるだけなので、狭く取って粒へ譲る。
const COVERAGE_THRESHOLD = 0.347;
const COVERAGE_DITHER_WIDTH = 0.04;

// 粒が被覆率と雲頂高度をそれぞれどれだけ振るか(どちらも場と同じ 0..1 の目盛り)。**被覆率へは
// 境目を通す前に足す** — 通したあとに足すと、覆いの無い空にも粒が雲を生やす。生成側が高周波を
// 持つようになったら、この 2 つを縮めて譲る。
export const GRAIN_COVERAGE_DEPTH = 0.25;
const GRAIN_TOP_RELIEF = 0.15;

// 場の G が 8bit で持つ刻み(場と同じ 0..1 の目盛り)。
const FIELD_TOP_STEP = 1 / 256;

// 粒を引かない読み手から見た、雲頂の高さの不確かさ(場と同じ 0..1 の目盛り)。粒が雲頂を振る
// 幅と、場の刻みの和。**この幅に入る受け手は雲頂に立っていると見なしてよい。**
export const CLOUD_TOP_UNCERTAINTY = GRAIN_TOP_RELIEF + FIELD_TOP_STEP;

// 被覆率を、画素ごとのディザと比べる「覆い尽くされている割合」0..1 へ伸ばしたもの。
export function opaqueFractionOf(coverage: FloatNode): FloatNode {
  return saturatedBand(coverage, COVERAGE_DITHER_WIDTH);
}

// 粒を引かない読み手のための、粒で均した「覆われている割合」0..1。粒は境目を通す前に被覆率へ
// 足されるので、均すと境目の前後 GRAIN_COVERAGE_DEPTH ぶんへなだらかに広がる。
export function meanOpaqueFractionOf(coverage: FloatNode): FloatNode {
  return saturatedBand(coverage, 2 * GRAIN_COVERAGE_DEPTH);
}

// 場の雲頂高度へ粒の起伏を重ねた雲頂高度 0..1。
export function cloudTopOf(fieldTop: FloatNode, grain: FloatNode): FloatNode {
  return clamp(fieldTop.add(grain.mul(GRAIN_TOP_RELIEF)), 0, 1);
}

// 境目の前後 band で 0 から 1 へ渡す。
function saturatedBand(coverage: FloatNode, band: number): FloatNode {
  return clamp(coverage.sub(COVERAGE_THRESHOLD - band / 2).div(band), 0, 1);
}
