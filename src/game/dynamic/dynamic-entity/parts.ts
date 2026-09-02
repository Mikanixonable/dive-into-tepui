export type PartType = 'hull' | 'cockpit' | 'armor' | 'thruster' | 'rcs_tank' | 'radiator' | 'solar_panel' | 'weapon';

export interface Part {
  readonly id: string;
  readonly type: PartType;
  readonly name: string;
  readonly weight: number; // kg

  maxHp: number;
  hp: number; // 0 = 破壊/機能停止
}

interface HullPart extends Part {
  readonly type: 'hull';
}

export interface CockpitPart extends Part {
  readonly type: 'cockpit';
}

export interface ArmorPart extends Part {
  readonly type: 'armor';
  damageReduction: number; // 0-1
}

export interface ThrusterPart extends Part {
  readonly type: 'thruster';
  torque: number;
  thrust: number;
  fuelConsumptionRate: number; // kg/s(スロットル100%時)
}

export interface RcsTankPart extends Part {
  readonly type: 'rcs_tank';
  maxFuel: number; // kg
  fuel: number; // kg
}

export interface RadiatorPart extends Part {
  readonly type: 'radiator';
  coolingRate: number; // 展開しきった1枚の実効放熱面積 [m^2]
}

export interface SolarPanelPart extends Part {
  readonly type: 'solar_panel';
  powerGeneration: number; // W
}

export interface WeaponPart extends Part {
  readonly type: 'weapon';
  weaponType: 'gatling' | 'cannon' | 'missile';
  fireRate: number; // rounds/s
  damage: number; // 命中1回あたりのダメージ
  muzzleVelocity: number; // m/s
}

export type AnyPart = HullPart | CockpitPart | ArmorPart | ThrusterPart | RcsTankPart | RadiatorPart | SolarPanelPart | WeaponPart;

type ExtractPart<TType extends PartType> = Extract<AnyPart, { type: TType }>;

// type の既定値に overrides を重ねてパーツを作る。id は呼び出しごとにランダム発行される。
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

// セーブされた AnyPart の生データを createPart 経由で組み立てる。id も引き継ぐので、
// セーブ前後でパーツの同一性(id)が保たれる。
export function partFromSaveData(data: AnyPart): AnyPart {
  return createPart(data.type, data);
}
