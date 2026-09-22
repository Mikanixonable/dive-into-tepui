// 可視率テクスチャの 1 画素の詰め方と読み方。書く側(encodeVisibility)と、光源が遮られないときの寄与へ
// 掛ける係数を読む側(EnvironmentOcclusion)を 1 か所に置く — 詰め方を変えるときは両方を直す。
//
// 1 画素: rg = 曲げた法線(view 空間、oct 符号化)、b = 余弦重みの可視率 V、a = 相互反射の持ち上げ g。
// 見えている空は、曲げた法線を軸に余弦重みで V を張る円錐(半角 β、cos β = √(1 − V))とみなす。
import type * as THREE from 'three/webgpu';
import {
  abs, acos, clamp, dot, exp2, float, luminance, max, mix, select, smoothstep, sqrt, texture, vec4,
} from 'three/tsl';
import { octDecodeNormal } from '../gbuffer';
import type { ShadingSample } from '../lighting/shading-sample';
import type { FloatNode, Vec2Node, Vec3Node, Vec4Node } from '../../tsl-types';

// 0..π の角を、余弦と正弦の組で持ったもの。小さい角でも正弦が桁を失わない。
interface Angle {
  readonly cos: FloatNode;
  readonly sin: FloatNode;
}

// 立体角を割るときの床 [sr]。
const MIN_SOLID_ANGLE = 1e-30;
// 半球の縁の角 π/2。
const RIGHT_ANGLE: Angle = { cos: float(0), sin: float(1) };

// 可視率 visibility と、octEncodeNormal で詰めた曲げた法線 encodedBentNormal と、受け手のアルベド albedo(線形
// RGB)を、可視率テクスチャの 1 画素へ詰める。
export function encodeVisibility(visibility: FloatNode, encodedBentNormal: Vec2Node, albedo: Vec3Node): Vec4Node {
  // GTAO の多重反射の当てはめ G = max(V, ((V·a + b)·V + c)·V)(Jimenez, Wu, Pesce, Jarabo 2016)を V で
  // 割った g = G / V。割らずに書くと V → 0 でもその極限へ落ちる。
  const reflectance = luminance(albedo);
  const a = reflectance.mul(2.0404).sub(0.3324);
  const b = reflectance.mul(-4.7951).add(0.6417);
  const c = reflectance.mul(2.7552).add(0.6903);
  const lift = max(visibility.mul(a).add(b).mul(visibility).add(c), 1);
  return vec4(encodedBentNormal, visibility, lift);
}

export class EnvironmentOcclusion {
  // visibilityTexture は encodeVisibility で詰めた全解像度の 1 枚。
  public constructor(private readonly visibilityTexture: THREE.Texture) {}

  // 球冠の光源(軸 lightDir は view 空間の単位ベクトル、sinSigmaSqr は視半径の正弦の 2 乗)の、遮られない
  // ときの拡散へ掛ける係数。持ち上げ込みなので 1 を超えうる。遮りが無ければ 1。
  public capFactor(sample: ShadingSample, lightDir: Vec3Node, sinSigmaSqr: FloatNode): FloatNode {
    // 曲げた法線まわりの極角を cos θ' = cos θ·|cos θ| で写した球面では、余弦重みの測度が立体角に比例する。
    // 見えている円錐は cos β' = 1 − V、光源の球冠は中心を同じ式で写し、半径を cos σ' = cos²σ に取る。
    const encoded = this.encodedAt(sample);
    const cosCenter = dot(octDecodeNormal(encoded.rg), lightDir);
    const center = angleOfCosine(cosCenter.mul(abs(cosCenter)));
    const aperture = angleOfCosine(float(1).sub(encoded.b));
    const light = { cos: float(1).sub(sinSigmaSqr), sin: sqrt(max(sinSigmaSqr.mul(float(2).sub(sinSigmaSqr)), 0)) };
    // 遮りの無い半球と重ねた量で割る — 地平線に掛かる光源の切れは、遮られないときの寄与がすでに持つ。
    const unoccluded = capOverlap(RIGHT_ANGLE, light, center);
    const ratio = clamp(capOverlap(aperture, light, center).div(max(unoccluded, MIN_SOLID_ANGLE)), 0, 1);
    // 光源がまるごと地平線の下なら、遮られないときの寄与も 0 なので、係数は何でもよい。
    return select(unoccluded.greaterThan(0), ratio.mul(encoded.a), float(1));
  }

  // 一様な環境光の拡散へ掛ける係数(持ち上げ込みの G)。
  public uniformFactor(sample: ShadingSample): FloatNode {
    const encoded = this.encodedAt(sample);
    return encoded.b.mul(encoded.a);
  }

  // 鏡面のローブ(峰 lobe は view 空間の単位ベクトル、roughness は知覚的な粗さ)の、遮られないときの鏡面へ
  // 掛ける係数 0..1。遮りが無ければ 1。ローブを円錐とみなして見えている円錐と重ねる(GTSO)。粗さの小さい端
  // では 1 へ戻す — ローブの円錐が細すぎて、重なりが画素ごとに 0 と 1 を跳ぶ。
  public lobeFactor(sample: ShadingSample, lobe: Vec3Node, roughness: FloatNode): FloatNode {
    const encoded = this.encodedAt(sample);
    const alpha = roughness.mul(roughness);
    const lobeCone = angleOfCosine(exp2(alpha.mul(alpha).mul(-3.32193)));
    const aperture = { cos: sqrt(clamp(float(1).sub(encoded.b), 0, 1)), sin: sqrt(clamp(encoded.b, 0, 1)) };
    const center = angleOfCosine(clamp(dot(octDecodeNormal(encoded.rg), lobe), -1, 1));
    // 遮りの無い半球と重ねた量で割る — 地平線に掛かるローブの切れは、遮られないときの鏡面がすでに持つ。
    const unoccluded = capOverlap(RIGHT_ANGLE, lobeCone, center);
    const ratio = clamp(capOverlap(aperture, lobeCone, center).div(max(unoccluded, MIN_SOLID_ANGLE)), 0, 1);
    // ローブがまるごと地平線の下なら、遮られないときの鏡面も 0 なので、係数は何でもよい。
    const visible = select(unoccluded.greaterThan(0), ratio, float(1));
    return mix(float(1), visible, smoothstep(0.01, 0.09, alpha));
  }

  // 見えている空の円錐の軸(view 空間の単位ベクトル)。拡散の写しはこの向きで読む。
  public bentNormal(sample: ShadingSample): Vec3Node {
    return octDecodeNormal(this.encodedAt(sample).rg);
  }

  // 見えている空の円錐の半角 β [rad]。
  public apertureAngle(sample: ShadingSample): FloatNode {
    return acos(sqrt(clamp(float(1).sub(this.encodedAt(sample).b), 0, 1)));
  }

  // 画面の uv の画素の余弦重みの可視率 V 0..1。
  public visibilityAt(uv: Vec2Node): FloatNode {
    return texture(this.visibilityTexture, uv).b;
  }

  // 受け手の画素に詰められた 1 画素。
  private encodedAt(sample: ShadingSample): Vec4Node {
    return texture(this.visibilityTexture, sample.uv);
  }
}

// 余弦 cosine(−1..1)の角。
function angleOfCosine(cosine: FloatNode): Angle {
  return { cos: cosine, sin: sqrt(max(float(1).sub(cosine.mul(cosine)), 0)) };
}

// 単位球の上で、角半径 r1 と r2 の球冠が、中心どうしの角距離 d で重なる立体角 [sr]。r1 + r2 ≤ π が前提。
// 重なりが三日月形になる範囲は厳密式(Mazonka 2012)。
function capOverlap(r1: Angle, r2: Angle, d: Angle): FloatNode {
  const cosSpread = r1.cos.mul(r2.cos);
  const sinSpread = r1.sin.mul(r2.sin);
  // select はどの枝も評価するので、使わない枝でも割り算と acos を定義域に収める。
  const sin1 = max(r1.sin, 1e-6);
  const sin2 = max(r2.sin, 1e-6);
  const sinD = max(d.sin, 1e-6);
  const lens = float(2 * Math.PI)
    .sub(acos(clamp(d.cos.sub(cosSpread).div(sin1.mul(sin2)), -1, 1)).mul(2))
    .sub(r1.cos.mul(acos(clamp(r2.cos.sub(d.cos.mul(r1.cos)).div(sinD.mul(sin1)), -1, 1))).mul(2))
    .sub(r2.cos.mul(acos(clamp(r1.cos.sub(d.cos.mul(r2.cos)).div(sinD.mul(sin2)), -1, 1))).mul(2));
  const smaller = select(r1.cos.greaterThan(r2.cos), capArea(r1), capArea(r2));
  // d ≤ |r1 − r2| なら小さいほうがまるごと他方の中、d ≥ r1 + r2 なら離れている。
  return select(
    d.cos.greaterThanEqual(cosSpread.add(sinSpread)), smaller,
    select(d.cos.lessThanEqual(cosSpread.sub(sinSpread)), float(0), clamp(lens, 0, smaller)),
  );
}

// 角半径 r の球冠の立体角 2π(1 − cos r) [sr]。小さい球冠で桁を失わないよう正弦から引く。
function capArea(r: Angle): FloatNode {
  return r.sin.mul(r.sin).div(max(r.cos.add(1), 1e-6)).mul(2 * Math.PI);
}
