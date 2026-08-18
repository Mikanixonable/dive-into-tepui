// 機体の質量特性。形状から導出するか、直接与えられるかのどちらかで決まる。
import { Vec3, v3 } from '../../physics/vec3';

export interface MassProperties {
  // 質量 [kg]。剛体接触の換算質量であり、推力から加速度を出す分母でもある。
  readonly mass: number;
  // 機体座標系での重心位置 [m]。
  readonly centerOfMass: Vec3;
  // 機体座標系の主慣性モーメント [kg·m^2]。3軸が非対称なら中間軸不安定性が現れる。
  readonly inertia: Vec3;
}

// 質量と主慣性モーメントから、重心を原点に置いた質量特性を組む。
export function massPropertiesOf(mass: number, inertia: Vec3): MassProperties {
  return { mass, centerOfMass: v3(), inertia };
}
