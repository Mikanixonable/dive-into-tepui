// 雲の場(R = 被覆率、G = 雲頂高度)を、不透明な積雲の形として読む規則。場の階調は濃さではなく
// 「その texel が雲に覆われている割合」なので、どこから不透明な雲になるかと、雲頂がどの高さに
// 立つかをここが決める。雲を描く側と、その雲が落とす影を引く側が、同じ形を見るための場。
import { clamp, float, smoothstep } from 'three/tsl';
import { gradientNoise } from './gradient-noise';
import type { FloatNode, Vec3Node } from '../tsl-types';

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
const GRAIN_COVERAGE_DEPTH = 0.25;
const GRAIN_TOP_RELIEF = 0.15;

// 積雲の粒の一辺 [m]。場の texel(赤道 9.8 km)より細かく、かつ低軌道から見下ろして解像できる
// 大きさ(高度 900km 以下で全振幅)に取る。これより細かくすると、実際の積雲の塊には近づく代わりに
// 軌道上のどの構図でも 1 画素を切って消える。**場ではなく天体の半径から決まる**ので、場の解像度が
// 変わっても粒は動かない。
export const CUMULUS_GRAIN_SIZE = 6000;

// 場の G が 8bit で持つ刻み(場と同じ 0..1 の目盛り)。
const FIELD_TOP_STEP = 1 / 256;

// 粒を引かない読み手から見た、雲頂の高さの不確かさ(場と同じ 0..1 の目盛り)。粒が雲頂を振る
// 幅と、場の刻みの和。**この幅に入る受け手は雲頂に立っていると見なしてよい。**
export const CLOUD_TOP_UNCERTAINTY = GRAIN_TOP_RELIEF + FIELD_TOP_STEP;

// 天体固定の単位方向における粒 −1..1 に amplitude を掛けたもの。frequency は 1 rad あたりの
// 山の数(天体の基準半径 / CUMULUS_GRAIN_SIZE)。**殻も影もここから引く** — 別々に引くと、
// 影が雲のシルエットから外れる。
export function grainAt(
  direction: Vec3Node, frequency: FloatNode | number, amplitude: FloatNode,
): FloatNode {
  return gradientNoise(direction.mul(frequency)).mul(amplitude);
}

// 標本 1 つが実寸 width [m] を張る読み手が引ける粒の振幅 0..1。**幅が粒の 1 波長ぶんまでは
// 全振幅** — そこまでは引いた粒が形として残る。2 波長を超えると標本の中で粒が均されるだけなので
// 0 へ落とし、引けなかったぶんは opaqueFractionOf が境目の幅へ回す。
//
// **画面の標本化(`cumulus-shell.ts` の grainAmplitudeAt)より緩い。** あちらは隣り合う画素の
// あいだのモアレを避けるので Nyquist の 2 倍を要るが、こちらの標本は光路上に散っていて画面の
// 隣の画素と揃わないため、モアレにならない。
export function grainAmplitudeForWidth(width: FloatNode): FloatNode {
  return smoothstep(CUMULUS_GRAIN_SIZE, 2 * CUMULUS_GRAIN_SIZE, width).oneMinus();
}

// 粒を重ねた被覆率を、画素ごとのディザと比べる「覆い尽くされている割合」0..1 へ伸ばしたもの。
// grain は amplitude を掛けたあとの粒、smoothedGrain は **引けなかった粒のうち均して境目の幅へ
// 回す割合** 0..1。粒は境目を通す前に被覆率を ±GRAIN_COVERAGE_DEPTH 振るので、均した粒はその
// 幅ぶん境目の前後へなだらかに広がる。
//
// **均すかどうかは読み手が決める。** 殻は画素ごとのディザを持つので、引けなかった粒は 0 を渡して
// 縁の内外へ振り分けさせる(均すと雲そのものが砂に散る)。影はディザを持てない — 受け手の画素
// ごとに散らすと影が砂になる — ので、引けなかったぶんを均して幅へ回す。
export function opaqueFractionOf(
  coverage: FloatNode, grain: FloatNode, smoothedGrain: FloatNode,
): FloatNode {
  const band = smoothedGrain.mul(2 * GRAIN_COVERAGE_DEPTH).add(COVERAGE_DITHER_WIDTH);
  return saturatedBand(coverage.add(grain.mul(GRAIN_COVERAGE_DEPTH)), band);
}

// 場の雲頂高度へ粒の起伏を重ねた雲頂高度 0..1。
export function cloudTopOf(fieldTop: FloatNode, grain: FloatNode): FloatNode {
  return clamp(fieldTop.add(grain.mul(GRAIN_TOP_RELIEF)), 0, 1);
}

// 境目の前後 band で 0 から 1 へ渡す。
function saturatedBand(coverage: FloatNode, band: FloatNode): FloatNode {
  return clamp(coverage.sub(float(COVERAGE_THRESHOLD).sub(band.mul(0.5))).div(band), 0, 1);
}
