// 破片の種別と、外観・寿命・熱など種別固有の値。
import type { Quat } from '../../../math/quat';
import type { Vec3 } from '../../../math/vec3';

// 破片が生まれた直後に機体座標系でたどる排出口への経路。from/to は重心基準、r0・q0・v0 は
// 出生時の等速座標系を表す。
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
  | { readonly kind: 'magazineFrame'; readonly slide?: DebrisSlide; }
  | { readonly kind: 'casing'; readonly bornSim: number; }
  | { readonly kind: 'decouplerPanel'; readonly segment: number; readonly bornSim: number; }
  | { readonly kind: 'barrel'; readonly bornTemperature: number; readonly bornThermalDeviation: number; };
