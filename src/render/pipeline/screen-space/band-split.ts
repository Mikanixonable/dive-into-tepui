// 補正の増分を、標本の画面距離と向きから帯へ分ける。帯の座標は、距離だけの log₂(κ·ρ) に、向きの内積の因子を
// 掛ける・割る形で補う。照り返しと遮蔽は別の κ と強さで別の帯へ積む(因子 a・b は 8-15 の撮影用の切り替えで、採った
// 因子だけの固定の式に直す)。送り手の向きの因子 d と受け手の視線の因子 c は強さを持たず、照り返しにも遮蔽にも固定で掛かる。
import { abs, clamp, dot, float, length, log2, max, pow } from 'three/tsl';
import type { FloatNode, Vec3Node } from '../../tsl-types';

// 因子の強さ(0..1)。s = 0 なら因子は 1(効かない)、s = 1 ならそのまま cos。中間の弱め方は、掛ける因子(a)は
// 線形 (1 − s) + s·cos、割る因子(b)は冪 cos^s。
// senderFacing は送り手の法線と送り手→受け手、receiverFacing は受け手の法線と受け手→送り手の内積。
export interface FacingStrengths {
  readonly senderFacing: FloatNode;
  readonly receiverFacing: FloatNode;
}

// 補正を遮りの画面距離 ρ [走査の画素] と向きで分ける帯。count は帯の数(1 なら分けない)で、帯 b は座標 b を受け持つ。
// 遮蔽に送り手の向きの因子 senderFacing はない(光を返す面の向きの話)。
export interface BandSplit {
  readonly count: number;
  readonly bounceScale: FloatNode;
  readonly bounce: FacingStrengths;
  readonly occlusionScale: FloatNode;
  readonly occlusion: Omit<FacingStrengths, 'senderFacing'>;
}

// 標本(送り手)ごとの向きの内積(0..1)。受け手→カメラの内積は受け手ごとに 1 つなので別に渡す。
export interface SampleFacing {
  readonly senderFacing: FloatNode;
  readonly receiverFacing: FloatNode;
  readonly senderView: FloatNode;
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

// 受け手→送り手の変位 toSample と、受け手・送り手の法線・送り手→カメラの単位ベクトルから、標本の向きの内積を作る。
export function sampleFacing(
  receiverNormal: Vec3Node, senderNormal: Vec3Node, toSample: Vec3Node, senderToCamera: Vec3Node,
): SampleFacing {
  const toSender = toSample.div(max(length(toSample), COORDINATE_FLOOR));
  return {
    senderFacing: facingCosine(senderNormal, toSender.negate()),
    receiverFacing: facingCosine(receiverNormal, toSender),
    senderView: facingCosine(senderNormal, senderToCamera),
  };
}

function weakened(strength: FloatNode, cosine: FloatNode): FloatNode {
  return float(1).sub(strength).add(strength.mul(cosine));
}

// 受け手の法線と受け手→カメラの内積 cos ε を、弱めずに帯の座標へ掛ける因子 c。斜めに見る受け手は画面上で縮むので、
// 同じ世界の波長が画面では短い。cos ε = 0 は帯 0 へ頭打ちで、NaN は出ない。
function receiverViewMultiplier(cosine: FloatNode): FloatNode {
  return max(cosine, COORDINATE_FLOOR);
}

// 割る因子の弱め方。0 は最も粗い帯へ頭打ちになるだけで安全なので下限は要らず、冪なら側面(cos → 0)を最も粗い帯へ送りつつ
// 中くらいの cos の動きを s で縮められる(線形だと cos = 0 でも最大 log₂(1/(1 − s)) 帯しか動かない)。
// pow に渡す前の下限は NaN と 0^0 を避けるためで、s = 0 なら 1。
function weakenedDivisor(strength: FloatNode | number, cosine: FloatNode): FloatNode {
  return pow(max(cosine, COORDINATE_FLOOR), strength);
}

function senderViewDivisor(facing: SampleFacing): FloatNode {
  return weakenedDivisor(SENDER_VIEW_EXPONENT, facing.senderView);
}

// 帯の座標 log₂(κ·ρ·multiply / divide) を 0..count − 1 へ寄せる。
// **掛ける因子の区別に注意**
// - 標本(送り手)ごとに変わる掛ける因子は、0 へ近づくと踏まれにくく値の大きい標本だけを帯 0(均さない帯)へ落として
//   輝点にする。弱めて下限を持たせること(weakened の強さ s < 1)。
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

// 画面距離 rho の標本の、遮蔽の増分の帯ごとの重み。receiverView は受け手の法線と受け手→カメラの内積 cos ε。
export function occlusionWeights(
  bands: BandSplit, rho: FloatNode, receiverView: FloatNode, facing: SampleFacing,
): FloatNode[] {
  const { occlusionScale, occlusion } = bands;
  const coordinate = bandCoordinate(
    bands.count, occlusionScale, rho, receiverViewMultiplier(receiverView),
    weakenedDivisor(occlusion.receiverFacing, facing.receiverFacing)
      .mul(senderViewDivisor(facing)),
  );
  return bandWeights(bands.count, coordinate);
}

// 画面距離 rho の標本の、照り返しの増分の帯ごとの重み。
export function bounceWeights(
  bands: BandSplit, rho: FloatNode, receiverView: FloatNode, facing: SampleFacing,
): FloatNode[] {
  const { bounceScale, bounce } = bands;
  const coordinate = bandCoordinate(
    bands.count, bounceScale, rho,
    weakened(bounce.senderFacing, facing.senderFacing).mul(receiverViewMultiplier(receiverView)),
    weakenedDivisor(bounce.receiverFacing, facing.receiverFacing)
      .mul(senderViewDivisor(facing)),
  );
  return bandWeights(bands.count, coordinate);
}
