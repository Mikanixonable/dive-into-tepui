// GGX の鏡面。点光源近似で放射照度へ掛ける係数と、像をぼかす鏡面ローブの幅を返す。係数は F0=1 で仮に評価した値で、
// フレネル項はマテリアルパス側が掛け直す。
import {
  D_GGX, F_Schlick, V_GGX_SmithCorrelated, dot, float, normalize, saturate,
} from 'three/tsl';
import type { FloatNode, Vec3Node } from '../../tsl-types';
import type { ShadingSample } from './shading-sample';

// 鏡面ローブの半幅 [rad] の、GGX の α(知覚的粗さの 2 乗)に対する比。
const LOBE_HALF_WIDTH_PER_ALPHA = 2;

// 面 sample の鏡面ローブの半幅 [rad]。遠くの光の写しも近くの物体の像も、同じ粗さの面ではこの幅でぼかす。
export function specularLobeHalfWidth(sample: ShadingSample): FloatNode {
  return sample.roughness.mul(sample.roughness).mul(LOBE_HALF_WIDTH_PER_ALPHA);
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
