// 補正の増分(照り返し − 塞がれた照度)を、標本の画面距離と向きから帯へ分ける。帯の座標は log₂(κ·ρ·cos ε)
// で、照り返しにも遮蔽にも同じ。照り返しには、交線の像を越える帯へ天井を置く。
import { clamp, dot, exp2, float, length, log2, max, min, select, vec2, vec4 } from 'three/tsl';
import type { FloatNode, Mat4Uniform, Vec2Node, Vec3Node } from '../../tsl-types';

// 補正を遮りの画面距離 ρ [走査の画素] と向きで分ける帯。count は帯の数(1 なら分けない)で、帯 b は座標 b を受け持つ。
// scale は距離だけの座標 log₂(κ·ρ) の尺度 κ。
export interface BandSplit {
  readonly count: number;
  readonly scale: FloatNode;
}

// 帯の天井(bandCeiling)の形。CEILING_DEPTH は天井が最も下がるときの深さ D [帯]、CEILING_CENTER は天井が最も下がる ρ ÷ ℓ_L の比 R、
// CEILING_FLOOR は天井の下限 F [帯](根元の近くでも帯 F の半径までは均し、漏れをその幅に留める)。κ(BandSplit の scale)と組で決めた値
// (手順22 段A、決めたこと 64)なので、κ を変えたら振り直す。
const CEILING_DEPTH = 2.17;
const CEILING_CENTER = 8;
const CEILING_FLOOR = 1;
// 天井を置かない寄与(遮蔽)に渡す、どの帯も制限しない天井。
export const NO_CEILING = 64;

// 交線の像が無い(同じ平面の標本)ときの距離 [走査の画素]。
const UNLIMITED_DISTANCE = 1e9;

// 帯の座標に入れる、0 の手前の下限。
const COORDINATE_FLOOR = 1e-6;

// 法線 normal と単位ベクトル direction の内積。負値は 0 へ寄せる。
export function facingCosine(normal: Vec3Node, direction: Vec3Node): FloatNode {
  return clamp(dot(normal, direction), 0, 1);
}

// 受け手の画素から、標本の接平面と受け手の接平面の交線 L の像までの画面距離 [走査の画素](位置と法線は view 空間)。受け手の面の
// 上でこの標本の寄与は L で 0 になるので、L の像を越えてぼかす帯へ出すと漏れになる。直線は射影で直線へ写るので、L と視点を含む
// 平面を clip 空間へ写した直線として厳密に求まる(透視でも平行投影でも)。平行に近い平面では像は受け手の面の消失線へ寄るだけで、
// 発散も 0 への潰れもしない。同じ平面の標本(その寄与は 0)は UNLIMITED_DISTANCE。
function intersectionImageDistance(
  senderPosition: Vec3Node, senderNormal: Vec3Node, receiverPosition: Vec3Node, receiverNormal: Vec3Node,
  projection: Mat4Uniform, projectionInverse: Mat4Uniform, scanSize: Vec2Node,
): FloatNode {
  const senderPlane = vec4(senderNormal, dot(senderNormal, senderPosition).negate());
  const receiverPlane = vec4(receiverNormal, dot(receiverNormal, receiverPosition).negate());
  const eye = projectionInverse.mul(vec4(0, 0, 1, 0));
  const linePlane = receiverPlane.mul(dot(senderPlane, eye)).sub(senderPlane.mul(dot(receiverPlane, eye)));
  const imagePlane = projectionInverse.transpose().mul(linePlane);
  const receiverClip = projection.mul(vec4(receiverPosition, 1));
  const q = receiverClip.xy.div(receiverClip.w);
  const pixelNormal = imagePlane.xy.mul(vec2(2).div(scanSize));
  const distance = imagePlane.x.mul(q.x).add(imagePlane.y.mul(q.y)).add(imagePlane.w).abs()
    .div(length(pixelNormal));
  return select(length(pixelNormal).equal(0), float(UNLIMITED_DISTANCE), distance);
}

// 画面距離 rho の標本の帯の天井の座標 max(log₂(κ·ρ) − D + |log₂(R·ℓ_L ÷ ρ)|, F)(scale は κ、ℓ_L は intersectionImageDistance、D・R・F は
// CEILING_DEPTH・CEILING_CENTER・CEILING_FLOOR)。天井は交線の像までの距離が ρ ÷ R の標本で距離だけの座標より D 帯下がり、そこから 2 倍離れるごとに
// 1 帯戻る — 根元にごく近い標本も、根元より十分遠い標本も縛らない。
export function bandCeiling(
  scale: FloatNode, rho: FloatNode, senderPosition: Vec3Node, senderNormal: Vec3Node, receiverPosition: Vec3Node,
  receiverNormal: Vec3Node, projection: Mat4Uniform, projectionInverse: Mat4Uniform, scanSize: Vec2Node,
): FloatNode {
  const distance = intersectionImageDistance(senderPosition, senderNormal, receiverPosition, receiverNormal,
    projection, projectionInverse, scanSize);
  const offCenter = log2(max(distance.mul(CEILING_CENTER).div(max(rho, COORDINATE_FLOOR)), COORDINATE_FLOOR)).abs();
  return max(log2(max(scale.mul(rho), COORDINATE_FLOOR)).sub(CEILING_DEPTH).add(offCenter), CEILING_FLOOR);
}

// 受け手の法線と受け手→カメラの内積 cos ε を、弱めずに帯の座標へ掛ける因子 c。斜めに見る受け手は画面上で縮むので、
// 同じ世界の波長が画面では短い。cos ε = 0 は帯 0 が最も重い形へ寄り、NaN は出ない。
function receiverViewMultiplier(cosine: FloatNode): FloatNode {
  return max(cosine, COORDINATE_FLOOR);
}

// 帯の座標 log₂(κ·ρ·multiply)。帯 b の山は座標 b にあり、帯の範囲へは寄せない。
// **掛ける因子の区別に注意**
// - 標本(送り手)ごとに変わる掛ける因子は、0 へ近づくと踏まれにくく値の大きい標本だけを帯 0(均さない帯)へ落として
//   輝点にする。掛けるなら弱めて下限を持たせること。
// - 受け手ごとに一定の掛ける因子(c)は、その受け手の寄与をまとめて細かい帯へ移すだけで、受け手が画面上で狭く写る
//   という本当の尺度を表す。弱めない。
export function bandCoordinate(scale: FloatNode, rho: FloatNode, multiply: FloatNode): FloatNode {
  return log2(max(scale.mul(rho).mul(multiply), COORDINATE_FLOOR));
}

// 帯の座標 coordinate の増分を帯へ分ける重み。0 以上で和は 1(1 帯なら重み 1)。帯 b は、線形の距離で山 d_b を頂点に 0〜2d_b に張った
// 左右対称な三角 max(1 − |u − 1|, 0)(u = 2^{coordinate − b})を全帯の和で割った重みで、近い側の裾は ρ = 0 まで伸び、粗い隣の帯との比は 1/2。
// 最後の帯は山より遠くを 1 で受け持つ。座標の下限で u > 0 なので、帯 0 の三角は正で和は 0 にならない。
// 天井 ceiling(bandCeiling)より粗い帯は 1 帯の幅で 0 へ落とす。帯 0 は均さないので天井を持たない。座標も天井で頭打ちにする —
// しないと、天井より上の寄与で許された帯の三角がすべて 0 になる。
export function bandWeights(count: number, coordinate: FloatNode, ceiling: FloatNode): FloatNode[] {
  if (count === 1) return [float(1)];
  const capped = min(coordinate, ceiling);
  const peaks = Array.from({ length: count }, (_, band) => {
    const ratio = exp2(capped.sub(band));
    const u = band === count - 1 ? min(ratio, 1) : ratio;
    const peak = max(float(1).sub(u.sub(1).abs()), 0);
    const ceilingWeight = band === 0 ? float(1) : clamp(float(1).add(ceiling).sub(band), 0, 1);
    return peak.mul(ceilingWeight);
  });
  const total = peaks.reduce((sum, peak) => sum.add(peak), float(0));
  return peaks.map((peak) => peak.div(total));
}

// 天井が許す最も粗い帯へ寄与を送る。
export function coarsestBandWeights(bands: BandSplit, ceiling: FloatNode): FloatNode[] {
  return bandWeights(bands.count, float(NO_CEILING), ceiling);
}

// 画面距離 rho の標本の、補正の増分の帯ごとの重み。receiverView は受け手の法線と受け手→カメラの内積 cos ε。
export function sampleBandWeights(
  bands: BandSplit, rho: FloatNode, receiverView: FloatNode, ceiling: FloatNode,
): FloatNode[] {
  // 試して保留した帯座標の因子 a(送り手の向き)・b(受け手の向き)は、計画書 screenspace-diffuse_backlog.md の Backlog にある。
  const coordinate = bandCoordinate(bands.scale, rho, receiverViewMultiplier(receiverView));
  return bandWeights(bands.count, coordinate, ceiling);
}
