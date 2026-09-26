// 破片の種別と、種別ごとの値。直列化した形を兼ねる。accent / size / segment は見た目を、
// bornTemperature / bornThermalDeviation / bornSim は熱と寿命を決める。
import type { Quat } from '../../../math/quat';
import type { Vec3 } from '../../../math/vec3';

// 破片が生まれた直後に機体に沿って進む経路。排出機構の内側から排出口へ向かう滑りで、生まれた
// 時点の機体座標系(位置 r0・姿勢 q0・速度 v0 を持つ等速の座標系)で、質量中心基準の from→to を
// duration 秒かけて進む。機体の加速・回転中は経路が正確には追従しないので、滑りは短く保つ。
export interface DebrisSlide {
  readonly bornSim: number;
  readonly duration: number;
  readonly r0: Vec3;
  readonly q0: Quat;
  readonly v0: Vec3;
  readonly from: Vec3;
  readonly to: Vec3;
}

export type DebrisKind =
  | { readonly kind: 'fragment'; readonly accent: string | number; readonly size: number; }
  | { readonly kind: 'barrel'; readonly bornTemperature: number; readonly bornThermalDeviation: number; }
  | { readonly kind: 'magazineFrame'; readonly slide?: DebrisSlide; }
  | { readonly kind: 'casing'; readonly bornSim: number; }
  | { readonly kind: 'decouplerPanel'; readonly segment: number; readonly bornSim: number; };
