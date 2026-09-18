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
  type DynamicMotionThermal,
} from '../dynamic-motion';

// 砲身(鋼)の物性。
const BARREL_BULK_DENSITY = 7850; // [kg/m^3]
const BARREL_MAX_TEMP = 1700; // [K]
export const BARREL_SPECIFIC_HEAT = 500; // [J/(kg·K)]
export const BARREL_RADIATING_AREA_PER_MASS = 0.047; // [m^2/kg]

// 破片の種別・振る舞い・接触半径 [m] と熱の状態。熱の状態で省いた項目は環境温度の既定から始める。
interface DebrisMotionProperties {
  readonly kind: DebrisKind['kind'];
  readonly behavior: DynamicMotionBehavior;
  readonly radius?: number;
  readonly thermal: Partial<DynamicMotionThermal>;
}

// 破片の材質ごとの熱の物性。
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

// 種別 kind の破片の熱の物性。砲身は鋼、ほかはアルミ相当。
function debrisThermal(kind: DebrisKind['kind']): DebrisThermal {
  return kind === 'barrel' ? STEEL_BARREL : ALUMINIUM_DEBRIS;
}

// 破片・薬莢・分離金物の物性、熱、接触可否、寿命境界を所有する。
export class DebrisMotion extends DynamicMotion {
  // state・attitude から始まる破片を、種別ごとの物性で組む。
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
      // 熱の状態は与えられた値、熱の物性は材質の値
      ...options.thermal,
      specificHeat: thermal.specificHeat,
      bulkDensity: thermal.bulkDensity,
      radiatingAreaPerMass: thermal.radiatingAreaPerMass,
      maxTemperature: thermal.maxTemperature,
      behavior: options.behavior,
    });
  }
}
