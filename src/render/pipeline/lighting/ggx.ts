// GGX の鏡面。点光源近似で放射照度へ掛ける係数と、像をぼかす鏡面ローブの幅、ローブから選んだ反射の向きを返す。
// 係数と重みは F0=1 で仮に評価した値で、フレネル項はマテリアルパス側が掛け直す。
import {
  D_GGX, F_Schlick, V_GGX_SmithCorrelated, clamp, cos, dot, float, max, normalize, saturate, select, sin, sqrt, vec3,
} from 'three/tsl';
import type { FloatNode, Vec2Node, Vec3Node } from '../../tsl-types';
import type { ShadingSample } from './shading-sample';

// 鏡面ローブの半幅 [rad] の、GGX の α(知覚的粗さの 2 乗)に対する比。
const LOBE_HALF_WIDTH_PER_ALPHA = 2;

// 面 sample の鏡面ローブの半幅 [rad]。遠くの光の写しも近くの物体の像も、同じ粗さの面ではこの幅でぼかす。
export function specularLobeHalfWidth(sample: ShadingSample): FloatNode {
  return sample.roughness.mul(sample.roughness).mul(LOBE_HALF_WIDTH_PER_ALPHA);
}

// 鏡面ローブから選んだ反射の向き 1 本と、その向きで見た放射輝度に掛ける重み。
export interface GgxReflectionSample {
  // view 空間の単位ベクトル。
  readonly direction: Vec3Node;
  // G2 / G1。向きが面の下へ潜った標本では 0。期待値は F0=1 の方向アルベドで、1 以下。
  readonly weight: FloatNode;
}

// 面 sample の鏡面ローブから、反射の向きを 1 本選ぶ。マイクロ法線を可視法線分布(VNDF)から選んで視線を映す
// (Dupuy & Benyoub 2023 の球冠による Heitz 2018 の標本化)。この向きの密度は D·G1(v) / (4·N·V) なので、重み
// G2 / G1 を掛けた放射輝度の期待値が、F0=1 の鏡面の積分 ∫ L·D·V·(N·L) dl になる。u は画素ごとの 0..1 の 2 つ組。
export function sampleGgxReflection(sample: ShadingSample, u: Vec2Node): GgxReflectionSample {
  const alpha = sample.roughness.mul(sample.roughness);
  const alphaSqr = alpha.mul(alpha);
  // 法線を z とする正規直交基底(Duff ら 2017)。法線の向きによらず分岐なしで組める。
  const normal = sample.normal;
  const sign = select(normal.z.greaterThanEqual(0), float(1), float(-1));
  const a = float(-1).div(sign.add(normal.z));
  const b = normal.x.mul(normal.y).mul(a);
  const tangent = vec3(float(1).add(sign.mul(normal.x).mul(normal.x).mul(a)), sign.mul(b), sign.mul(normal.x).negate());
  const bitangent = vec3(b, sign.add(normal.y.mul(normal.y).mul(a)), normal.y.negate());
  const view = vec3(dot(sample.viewDir, tangent), dot(sample.viewDir, bitangent), dot(sample.viewDir, normal));
  // 粗さ 1 の半球へ引き伸ばした視線のまわりの球冠から点を選び、引き伸ばしを戻してマイクロ法線にする。
  const stretchedView = normalize(vec3(view.xy.mul(alpha), view.z)).toVar();
  const phi = u.x.mul(2 * Math.PI);
  const z = float(1).sub(u.y).mul(stretchedView.z.add(1)).sub(stretchedView.z);
  const sinTheta = sqrt(clamp(float(1).sub(z.mul(z)), 0, 1));
  const cap = vec3(sinTheta.mul(cos(phi)), sinTheta.mul(sin(phi)), z).add(stretchedView);
  const micro = normalize(vec3(cap.xy.mul(alpha), max(cap.z, 0)));
  const halfDir = normalize(tangent.mul(micro.x).add(bitangent.mul(micro.y)).add(normal.mul(micro.z))).toVar();
  const direction = halfDir.mul(dot(sample.viewDir, halfDir).mul(2)).sub(sample.viewDir).toVar();
  // 高さ相関の Smith の G2 / G1(v)。
  const dotNV = max(view.z, 1e-4);
  const dotNL = dot(normal, direction);
  const rootV = sqrt(alphaSqr.add(float(1).sub(alphaSqr).mul(dotNV.mul(dotNV))));
  const rootL = sqrt(alphaSqr.add(float(1).sub(alphaSqr).mul(dotNL.mul(dotNL))));
  const ratio = dotNL.mul(dotNV.add(rootV)).div(dotNL.mul(rootV).add(dotNV.mul(rootL)));
  return { direction, weight: select(dotNL.greaterThan(0), ratio, float(0)) };
}

// 光源方向 lightDir(view 空間、正規化済み)からの放射照度へ掛ける鏡面の係数。
export function ggxSpecularFactor(sample: ShadingSample, lightDir: Vec3Node): FloatNode {
  const alpha = sample.roughness.mul(sample.roughness);
  const dotNL = saturate(dot(sample.normal, lightDir));
  const halfDir = normalize(lightDir.add(sample.viewDir));
  const dotNH = saturate(dot(sample.normal, halfDir));
  const dotNV = saturate(dot(sample.normal, sample.viewDir));
  const dotVH = saturate(dot(sample.viewDir, halfDir));
  // D_GGX/V_GGX_SmithCorrelated/F_Schlick の @types/three 上の戻り値型 OperatorNode は
  // メソッドチェインを持たない(実体は他の TSL ノードと同じプロキシで、型定義側の欠落)ため、
  // FloatNode へ読み替えてから掛け合わせる。
  const fresnel = F_Schlick({ f0: float(1), f90: float(1), dotVH }) as unknown as FloatNode;
  const visibility = V_GGX_SmithCorrelated({ alpha, dotNL, dotNV }) as unknown as FloatNode;
  const distribution = D_GGX({ alpha, dotNH }) as unknown as FloatNode;
  return fresnel.mul(visibility).mul(distribution);
}
