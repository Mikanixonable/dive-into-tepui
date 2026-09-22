import type { Attitude } from '../../../physics/attitude';
import type { KinematicState } from '../../../physics/kinematic-state';
import {
  DynamicMotion,
  SMALL_DEBRIS_BCINV,
  SMALL_DEBRIS_BULK_DENSITY,
  SMALL_DEBRIS_MAX_TEMP,
  SMALL_DEBRIS_RADIATING_AREA_PER_MASS,
  SMALL_DEBRIS_SPECIFIC_HEAT,
  SMALL_DEBRIS_SRP_COEFF,
  type DynamicMotionThermal,
} from '../dynamic-motion';

// 補給物の種別。接触種別としても識別される。
export type PickupKind = 'ammo' | 'rcs-fuel';

const PICKUP_PHYSICAL_RADIUS = 1.3; // [m]

// 補給物の軌道・姿勢・物性・接触種別を所有する。
export class PickupMotion extends DynamicMotion {
  // 小さな金属片と同じ物性で、質量と接触ダメージの重みを 0 にした漂流物として組む。thermal は熱の
  // 状態で、省くと環境温度から始める。alive は生死で、省くと生きた状態で始める。
  public constructor(
    state: KinematicState, attitude: Attitude | undefined, kind: PickupKind, thermal?: DynamicMotionThermal,
    alive?: boolean,
  ) {
    super(state, {
      alive,
      attitude,
      ...thermal,
      mass: 0,
      radius: PICKUP_PHYSICAL_RADIUS,
      collides: true,
      contactDamageWeight: 0,
      // 空力・輻射圧・熱の物性は小さな金属片の値
      bcInv: SMALL_DEBRIS_BCINV,
      srpCoeff: SMALL_DEBRIS_SRP_COEFF,
      specificHeat: SMALL_DEBRIS_SPECIFIC_HEAT,
      bulkDensity: SMALL_DEBRIS_BULK_DENSITY,
      radiatingAreaPerMass: SMALL_DEBRIS_RADIATING_AREA_PER_MASS,
      maxTemperature: SMALL_DEBRIS_MAX_TEMP,
      followsPredictedArc: true,
      behavior: { contactKind: kind },
    });
  }
}
