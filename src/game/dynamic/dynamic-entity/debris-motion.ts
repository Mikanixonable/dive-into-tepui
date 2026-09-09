import type { WorldSfx } from '../../../audio/sfx/world-sfx';
import type { Attitude } from '../../../physics/attitude';
import type { KinematicState } from '../../../physics/kinematic-state';
import type { FlashEffects } from '../../vfx/flash-effects';
import {
  DynamicMotion,
  SMALL_DEBRIS_BCINV,
  SMALL_DEBRIS_BULK_DENSITY,
  SMALL_DEBRIS_MAX_TEMP,
  SMALL_DEBRIS_RADIATING_AREA_PER_MASS,
  SMALL_DEBRIS_SPECIFIC_HEAT,
  SMALL_DEBRIS_SRP_COEFF,
} from '../dynamic-motion';
import { DebrisReaction } from './debris-reaction';

const BARREL_BULK_DENSITY = 7850;
const BARREL_MAX_TEMP = 1700;
export const BARREL_SPECIFIC_HEAT = 500;
export const BARREL_RADIATING_AREA_PER_MASS = 0.047;

export type DebrisKind =
  | { kind: 'fragment'; accent: string | number; size: number; }
  | { kind: 'barrel'; bornTemperature: number; bornThermalDeviation: number; }
  | { kind: 'magazineFrame'; }
  | { kind: 'casing'; bornSim: number; }
  | { kind: 'boosterCover'; segment: number; bornSim: number; }
  | { kind: 'boosterBolt'; segment: number; bornSim: number; };

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
    debrisKind: DebrisKind,
    worldSfx: WorldSfx,
    effects: FlashEffects,
    radius = 0,
  ) {
    const thermal = debrisThermal(debrisKind.kind);
    super(state, {
      attitude,
      mass: 0,
      radius,
      collides: debrisKind.kind !== 'fragment'
        && debrisKind.kind !== 'boosterCover'
        && debrisKind.kind !== 'boosterBolt',
      contactDamageWeight: 0,
      bcInv: SMALL_DEBRIS_BCINV,
      srpCoeff: SMALL_DEBRIS_SRP_COEFF,
      temperature: debrisKind.kind === 'barrel' ? debrisKind.bornTemperature : undefined,
      thermalDeviation: debrisKind.kind === 'barrel' ? debrisKind.bornThermalDeviation : undefined,
      specificHeat: thermal.specificHeat,
      bulkDensity: thermal.bulkDensity,
      radiatingAreaPerMass: thermal.radiatingAreaPerMass,
      maxTemperature: thermal.maxTemperature,
      behavior: new DebrisReaction(debrisKind, worldSfx, effects),
    });
  }
}
