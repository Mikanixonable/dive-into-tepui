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
} from '../dynamic-motion';

// 補給物の種別。接触の種別としても名乗る。
export type PickupKind = 'ammo' | 'rcs-fuel';

const PICKUP_PHYSICAL_RADIUS = 1.3; // [m]

// 補給物の軌道・姿勢・物性・接触種別を所有する。
export class PickupMotion extends DynamicMotion {
  public constructor(state: KinematicState, attitude: Attitude | undefined, kind: PickupKind) {
    super(state, {
      attitude,
      mass: 0,
      radius: PICKUP_PHYSICAL_RADIUS,
      collides: true,
      contactDamageWeight: 0,
      bcInv: SMALL_DEBRIS_BCINV,
      srpCoeff: SMALL_DEBRIS_SRP_COEFF,
      specificHeat: SMALL_DEBRIS_SPECIFIC_HEAT,
      bulkDensity: SMALL_DEBRIS_BULK_DENSITY,
      radiatingAreaPerMass: SMALL_DEBRIS_RADIATING_AREA_PER_MASS,
      maxTemperature: SMALL_DEBRIS_MAX_TEMP,
      predictedForGhost: true,
      behavior: { contactKind: kind },
    });
  }
}
