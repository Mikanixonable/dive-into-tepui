export type PartType = 'hull' | 'cockpit' | 'armor' | 'thruster' | 'rcs_tank' | 'radiator' | 'solar_panel' | 'weapon';

export interface Part {
  readonly id: string; // Unique ID for the part instance
  readonly type: PartType;
  readonly name: string;
  readonly weight: number; // kg
  
  maxHp: number;
  hp: number; // 0 = destroyed/non-functional
}

export interface HullPart extends Part {
  readonly type: 'hull';
}

export interface CockpitPart extends Part {
  readonly type: 'cockpit';
}

export interface ArmorPart extends Part {
  readonly type: 'armor';
  damageReduction: number; // 0-1, e.g. 0.5 means 50% damage reduced
}

export interface ThrusterPart extends Part {
  readonly type: 'thruster';
  torque: number; // Torque output
  thrust: number; // Linear thrust
  fuelConsumptionRate: number; // kg/s per 100% throttle
}

export interface RcsTankPart extends Part {
  readonly type: 'rcs_tank';
  maxFuel: number; // kg
  fuel: number; // kg
}

export interface RadiatorPart extends Part {
  readonly type: 'radiator';
  coolingRate: number; // Arbitrary unit used in ThermalSystem
}

export interface SolarPanelPart extends Part {
  readonly type: 'solar_panel';
  powerGeneration: number; // Watts
}

export interface WeaponPart extends Part {
  readonly type: 'weapon';
  weaponType: 'gatling' | 'cannon' | 'missile';
  fireRate: number; // rounds per second
  damage: number; // damage per hit
  muzzleVelocity: number; // m/s
}

export type AnyPart = HullPart | CockpitPart | ArmorPart | ThrusterPart | RcsTankPart | RadiatorPart | SolarPanelPart | WeaponPart;

type ExtractPart<TType extends PartType> = Extract<AnyPart, { type: TType }>;

export function createPart<TType extends PartType>(
  type: TType,
  overrides: Partial<ExtractPart<TType>>
): ExtractPart<TType> {
  const base = {
    id: Math.random().toString(36).slice(2),
    type,
    name: 'Unknown Part',
    weight: 100,
    maxHp: 100,
    hp: 100,
  };
  return { ...base, ...overrides } as unknown as ExtractPart<TType>;
}

// セーブされた AnyPart の生データを createPart 経由で復元する。id も上書きするので、
// セーブ前後でパーツの同一性(id)が保たれる。
export function restorePart(data: AnyPart): AnyPart {
  switch (data.type) {
    case 'hull': return createPart('hull', data);
    case 'cockpit': return createPart('cockpit', data);
    case 'armor': return createPart('armor', data);
    case 'thruster': return createPart('thruster', data);
    case 'rcs_tank': return createPart('rcs_tank', data);
    case 'radiator': return createPart('radiator', data);
    case 'solar_panel': return createPart('solar_panel', data);
    case 'weapon': return createPart('weapon', data);
  }
}
