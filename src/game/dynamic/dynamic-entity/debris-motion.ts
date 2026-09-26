import type { Attitude } from '../../../physics/attitude';
import type { KinematicState } from '../../../physics/kinematic-state';
import type { SerializedDebrisKind } from './debris-kind';
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

// 破片の種別・振る舞い・接触半径 [m]・熱の状態と生死。熱の状態で省いた項目は環境温度の既定から、
// 生死を省くと生きた状態で始める。
interface DebrisMotionProperties {
  readonly kind: SerializedDebrisKind['kind'];
  readonly behavior: DynamicMotionBehavior;
  readonly radius?: number;
  readonly thermal: Partial<DynamicMotionThermal>;
  readonly alive?: boolean;
}

// 破片の材質ごとの熱の物性。
interface DebrisThermal {
  readonly specificHeat: number;
  readonly bulkDensity: number;
  readonly radiatingAreaPerMass: number;
  readonly maxTemperature: number;
}

// 破片の熱の物性はいずれもアルミ相当。
const DEBRIS_THERMAL: DebrisThermal = {
  specificHeat: SMALL_DEBRIS_SPECIFIC_HEAT,
  bulkDensity: SMALL_DEBRIS_BULK_DENSITY,
  radiatingAreaPerMass: SMALL_DEBRIS_RADIATING_AREA_PER_MASS,
  maxTemperature: SMALL_DEBRIS_MAX_TEMP,
};

// 破片・薬莢・分離金物の物性、熱、接触可否、寿命境界を所有する。
export class DebrisMotion extends DynamicMotion {
  // state・attitude から始まる破片を、種別ごとの物性で組む。
  public constructor(
    state: KinematicState,
    attitude: Attitude,
    properties: DebrisMotionProperties,
  ) {
    const thermal = DEBRIS_THERMAL;
    super(state, {
      alive: properties.alive,
      attitude,
      mass: 0,
      radius: properties.radius ?? 0,
      collides: properties.kind !== 'fragment',
      contactDamageWeight: 0,
      bcInv: SMALL_DEBRIS_BCINV,
      srpCoeff: SMALL_DEBRIS_SRP_COEFF,
      // 熱の状態は与えられた値、熱の物性は材質の値
      ...properties.thermal,
      specificHeat: thermal.specificHeat,
      bulkDensity: thermal.bulkDensity,
      radiatingAreaPerMass: thermal.radiatingAreaPerMass,
      maxTemperature: thermal.maxTemperature,
      behavior: properties.behavior,
    });
  }
}
