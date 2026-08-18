// 姿勢に依存する空力特性(§11-2)。低軌道の高度は自由分子流域であり、この領域では抗力係数が形状に
// ほとんど依存しないので、形状の差は速度方向から見た投影面積だけに現れる。
import { Vec3, dot } from './vec3';

// 自由分子流域の抗力係数。形状によらずこの値を採る。
export const FREE_MOLECULAR_CD = 2.2;

// 太陽輻射圧の反射係数 C_R。完全吸収の 1 と完全鏡面反射の 2 の間の、一般的な機体の値。
export const RADIATION_PRESSURE_COEFF = 1.3;

// 主軸3方向の投影面積を持つ剛体を、機体座標系の向き dir から見たときの投影面積 [m²]。
// A(d̂) = |d̂·x̂|·A_x + |d̂·ŷ|·A_y + |d̂·ẑ|·A_z。直方体に対して厳密で、他の形状にも十分な近似になる。
// dir は単位ベクトルでなくてよい — 長さで割ってから畳む。
export function projectedArea(principalAreas: Vec3, dir: Vec3): number {
  const length = Math.sqrt(dot(dir, dir));
  if (!(length > 0)) return meanProjectedArea(principalAreas);
  return (
    Math.abs(dir.x) * principalAreas.x +
    Math.abs(dir.y) * principalAreas.y +
    Math.abs(dir.z) * principalAreas.z
  ) / length;
}

// 向きを一様に平均した投影面積 [m²]。単位球上で |d̂·x̂| の平均が 1/2 なので、3軸の和の半分になる。
// 向きを問えない場面(姿勢を持たない個体、太陽方向を解決できない場面)の投影面積として使う。
export function meanProjectedArea(principalAreas: Vec3): number {
  return (principalAreas.x + principalAreas.y + principalAreas.z) / 2;
}

// 弾道係数の逆数 Cd·A/m [m²/kg]。dirBody は機体座標系で表した対気速度の向き。
export function ballisticCoeffInv(principalAreas: Vec3, mass: number, dirBody: Vec3): number {
  if (!(mass > 0)) return 0;
  return (FREE_MOLECULAR_CD * projectedArea(principalAreas, dirBody)) / mass;
}

// 輻射圧の係数 C_R·A/m [m²/kg]。太陽方向は係数を解決する場所では引けないので、向きを平均した
// 投影面積を採る。
export function radiationPressureCoeff(principalAreas: Vec3, mass: number): number {
  if (!(mass > 0)) return 0;
  return (RADIATION_PRESSURE_COEFF * meanProjectedArea(principalAreas)) / mass;
}
