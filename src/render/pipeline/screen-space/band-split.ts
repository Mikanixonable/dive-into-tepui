// 補正の増分を、標本の画面距離と向きから帯へ分ける。帯の座標は、距離だけの log₂(κ·ρ) に、向きの内積の因子を
// 掛ける・割る形で補う。照り返しと遮蔽は別の κ と強さで別の帯へ積む(8-15 の撮影用。採った因子だけの固定の式に直す)。
import { abs, clamp, dot, float, length, log2, max, pow } from 'three/tsl';
import type { FloatNode, Vec3Node } from '../../tsl-types';

// 因子の強さ(0..1)。s = 0 なら因子は 1(効かない)、s = 1 ならそのまま cos。中間の弱め方は、掛ける因子(a・c)は
// 線形 (1 − s) + s·cos、割る因子(b・d)は冪 cos^s。
// senderFacing は送り手の法線と送り手→受け手、receiverFacing は受け手の法線と受け手→送り手、receiverView は
// 受け手の法線と受け手→カメラ、senderView は送り手の法線と送り手→カメラの内積。
export interface FacingStrengths {
  readonly senderFacing: FloatNode;
  readonly receiverFacing: FloatNode;
  readonly receiverView: FloatNode;
  readonly senderView: FloatNode;
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

// 割る因子の弱め方。0 は最も粗い帯へ頭打ちになるだけで安全なので下限は要らず、冪なら側面(cos → 0)を最も粗い帯へ送りつつ
// 中くらいの cos の動きを s で縮められる(線形だと cos = 0 でも最大 log₂(1/(1 − s)) 帯しか動かない)。
// pow に渡す前の下限は NaN と 0^0 を避けるためで、s = 0 なら 1。
function weakenedDivisor(strength: FloatNode, cosine: FloatNode): FloatNode {
  return pow(max(cosine, COORDINATE_FLOOR), strength);
}

// 帯の座標 log₂(κ·ρ·multiply / divide) を 0..count − 1 へ寄せる。
// **掛ける因子と割る因子の非対称に注意** — 波長を割って大きくする向きは最も粗い帯への頭打ちで済むので安全。掛けて 0 へ
// 近づける向きは帯 0(均さない帯)へ潰れ、踏まれにくく値の大きい標本(画面上で遠い・小さく写る源、とくに側面)を
// 輝点にする。掛ける因子は必ず下限を持たせて弱めること(weakened の強さ s < 1)。
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

// 画面距離 rho の標本の、遮蔽の増分の帯ごとの重み。receiverView は受け手の法線と受け手→カメラの内積。
export function occlusionWeights(
  bands: BandSplit, rho: FloatNode, receiverView: FloatNode, facing: SampleFacing,
): FloatNode[] {
  const { occlusionScale, occlusion } = bands;
  const coordinate = bandCoordinate(
    bands.count, occlusionScale, rho, weakened(occlusion.receiverView, receiverView),
    weakenedDivisor(occlusion.receiverFacing, facing.receiverFacing)
      .mul(weakenedDivisor(occlusion.senderView, facing.senderView)),
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
    weakened(bounce.senderFacing, facing.senderFacing).mul(weakened(bounce.receiverView, receiverView)),
    weakenedDivisor(bounce.receiverFacing, facing.receiverFacing)
      .mul(weakenedDivisor(bounce.senderView, facing.senderView)),
  );
  return bandWeights(bands.count, coordinate);
}
