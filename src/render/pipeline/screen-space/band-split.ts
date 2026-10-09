// 補正の増分(照り返し − 塞がれた照度)を、標本の画面距離と向きから帯へ分ける。帯の座標は log₂(κ·ρ·cos ε ÷ √(n_s·v_s))
// で、照り返しにも遮蔽にも同じ。受け手の視線の因子 c と送り手の視線の因子 d は固定で掛かる。
import { abs, clamp, dot, float, log2, max, pow } from 'three/tsl';
import type { FloatNode, Vec3Node } from '../../tsl-types';

// 補正を遮りの画面距離 ρ [走査の画素] と向きで分ける帯。count は帯の数(1 なら分けない)で、帯 b は座標 b を受け持つ。
// scale は距離だけの座標 log₂(κ·ρ) の尺度 κ。
export interface BandSplit {
  readonly count: number;
  readonly scale: FloatNode;
}

// 送り手の法線と送り手→カメラの内積 n_s·v_s を割る因子 d の冪。画面に側面を向ける送り手は踏まれにくく、切片を交点まで
// 延ばす方式で大きく数えられて疎な輝点になるので、大きな帯で均す。冪は f(0) = 0・f(1) = 1 を保ち、側面を最も粗い帯へ送る。
// tools/screen-space-chain-factors.mjs の FIXED_FACTORS が撮影の条件に写しを持つ。
export const SENDER_VIEW_EXPONENT = 0.5;

// 帯の座標に入れる、0 の手前の下限。
const COORDINATE_FLOOR = 1e-6;

// 法線 normal と単位ベクトル direction の内積。負値は 0 へ寄せる。
export function facingCosine(normal: Vec3Node, direction: Vec3Node): FloatNode {
  return clamp(dot(normal, direction), 0, 1);
}

// 受け手の法線と受け手→カメラの内積 cos ε を、弱めずに帯の座標へ掛ける因子 c。斜めに見る受け手は画面上で縮むので、
// 同じ世界の波長が画面では短い。cos ε = 0 は帯 0 へ頭打ちで、NaN は出ない。
function receiverViewMultiplier(cosine: FloatNode): FloatNode {
  return max(cosine, COORDINATE_FLOOR);
}

// 因子 d。0 は最も粗い帯へ頭打ちになるだけで安全。pow に渡す前の下限は NaN を避けるため。
function senderViewDivisor(senderView: FloatNode): FloatNode {
  return pow(max(senderView, COORDINATE_FLOOR), SENDER_VIEW_EXPONENT);
}

// 帯の座標 log₂(κ·ρ·multiply / divide) を 0..count − 1 へ寄せる。
// **掛ける因子の区別に注意**
// - 標本(送り手)ごとに変わる掛ける因子は、0 へ近づくと踏まれにくく値の大きい標本だけを帯 0(均さない帯)へ落として
//   輝点にする。掛けるなら弱めて下限を持たせること。
// - 受け手ごとに一定の掛ける因子(c)は、その受け手の寄与をまとめて細かい帯へ移すだけで、受け手が画面上で狭く写る
//   という本当の尺度を表す。弱めない。
// - 割る因子は最も粗い帯への頭打ちで済むので安全。
export function bandCoordinate(
  count: number, scale: FloatNode, rho: FloatNode, multiply: FloatNode, divide: FloatNode,
): FloatNode {
  const wavelength = log2(max(scale.mul(rho).mul(multiply), COORDINATE_FLOOR));
  return clamp(wavelength.sub(log2(max(divide, COORDINATE_FLOOR))), 0, count - 1);
}

// 帯の座標 coordinate が両隣の帯へ分ける重み。0 以上で和は 1(1 帯なら重み 1)。
export function bandWeights(count: number, coordinate: FloatNode): FloatNode[] {
  if (count === 1) return [float(1)];
  return Array.from({ length: count }, (_, band) => max(float(1).sub(abs(coordinate.sub(band))), 0));
}

// 画面距離 rho の標本の、補正の増分の帯ごとの重み。receiverView は受け手の法線と受け手→カメラの内積 cos ε、senderView は
// 標本(送り手)の法線と送り手→カメラの内積 n_s·v_s(どちらも facingCosine)。
export function sampleBandWeights(
  bands: BandSplit, rho: FloatNode, receiverView: FloatNode, senderView: FloatNode,
): FloatNode[] {
  // 試して保留した因子(8-15。再開は計画書の Backlog)。
  // a = cos θ(送り手の法線 · 送り手→受け手)を掛ける。送り手の地平による空間波長の異方性で、源の地平に沿うハードエッジの芯を
  //   残すが、標本ごとの因子なので、まれに踏まれる値の大きい標本を帯 0 へ落とし、輝点と cornell-box の色ムラを作る。
  //   const senderFacing = (1 - s) + s * pow(max(cosTheta, COORDINATE_FLOOR), p);  // p = 1 のオフセット形は (cosθ + o)/(1 + o)、o = (1 - s)/s
  // b = cos φ(受け手の法線 · 受け手→送り手)で割る。a で狭まった波長を受け手の側で広げる。a を採るときだけ要る。
  //   const receiverFacing = pow(max(cosPhi, COORDINATE_FLOOR), s);
  // 色ムラをどこまで均せるかを手順12(時間方向の蓄積)以降に決めてから、a を採るかを決める。
  const coordinate = bandCoordinate(
    bands.count, bands.scale, rho, receiverViewMultiplier(receiverView), senderViewDivisor(senderView));
  return bandWeights(bands.count, coordinate);
}
