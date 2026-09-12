import type { Attitude } from '../../../physics/attitude';
import type { KinematicState } from '../../../physics/kinematic-state';
import type { DebrisKind } from './debris-kind';
import {
  DynamicMotion,
  type DynamicMotionBehavior,
  SMALL_DEBRIS_BCINV,
  SMALL_DEBRIS_BULK_DENSITY,
  SMALL_DEBRIS_MAX_TEMP,
  SMALL_DEBRIS_RADIATING_AREA_PER_MASS,
  SMALL_DEBRIS_SPECIFIC_HEAT,
  SMALL_DEBRIS_SRP_COEFF,
} from '../dynamic-motion';

const BARREL_BULK_DENSITY = 7850;
const BARREL_MAX_TEMP = 1700;
export const BARREL_SPECIFIC_HEAT = 500;
export const BARREL_RADIATING_AREA_PER_MASS = 0.047;

interface DebrisMotionProperties {
  readonly kind: DebrisKind['kind'];
  readonly behavior: DynamicMotionBehavior;
  readonly radius?: number;
  readonly temperature?: number;
  readonly thermalDeviation?: number;
}

interface DebrisThermal {
  readonly specificHeat: number;
  readonly bulkDensity: number;
  readonly radiatingAreaPerMass: number;
  readonly maxTemperature: number;
}

const ALUMINIUM_DEBRIS: DebrisThermal = {
  specificHeat: SMALL_DEBRIS_SPECIFIC_HEAT,
  bulkDensity: SMALL_DEBRIS_BULK_DENSITY,
  radiatingAreaPerMass: SMALL_DEBRIS_RADIATING_AREA_PER_MASS,
  maxTemperature: SMALL_DEBRIS_MAX_TEMP,
};

const STEEL_BARREL: DebrisThermal = {
  specificHeat: BARREL_SPECIFIC_HEAT,
  bulkDensity: BARREL_BULK_DENSITY,
  radiatingAreaPerMass: BARREL_RADIATING_AREA_PER_MASS,
  maxTemperature: BARREL_MAX_TEMP,
};

function debrisThermal(kind: DebrisKind['kind']): DebrisThermal {
  return kind === 'barrel' ? STEEL_BARREL : ALUMINIUM_DEBRIS;
}

// 破片・薬莢・分離金物の物性、熱、接触可否、寿命境界を所有する。
export class DebrisMotion extends DynamicMotion {
  public constructor(
    state: KinematicState,
    attitude: Attitude,
    options: DebrisMotionProperties,
  ) {
    const thermal = debrisThermal(options.kind);
    super(state, {
      attitude,
      mass: 0,
      radius: options.radius ?? 0,
      collides: options.kind !== 'fragment'
        && options.kind !== 'boosterCover'
        && options.kind !== 'boosterBolt',
      contactDamageWeight: 0,
      bcInv: SMALL_DEBRIS_BCINV,
      srpCoeff: SMALL_DEBRIS_SRP_COEFF,
      temperature: options.temperature,
      thermalDeviation: options.thermalDeviation,
      specificHeat: thermal.specificHeat,
      bulkDensity: thermal.bulkDensity,
      radiatingAreaPerMass: thermal.radiatingAreaPerMass,
      maxTemperature: thermal.maxTemperature,
      behavior: options.behavior,
    });
  }
}
