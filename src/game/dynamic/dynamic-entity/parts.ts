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

export type SerializedPart = Readonly<AnyPart>;

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

const PART_TYPES: readonly PartType[] = [
  'hull', 'cockpit', 'armor', 'thruster', 'rcs_tank', 'radiator', 'solar_panel', 'weapon',
];

// 有限な数なら 0 以上へ切り詰めた値、それ以外は 0。
function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

// 直列化された部品を復元する。id も引き継ぐので、直列化の前後で部品の同一性(id)が保たれる。
// 種別が不正なら null。ほかの項目が不正なら、その項目だけを安全な値へ落とす。
export function deserializePart(serialized: SerializedPart): AnyPart | null {
  if (serialized === null || typeof serialized !== 'object'
    || !PART_TYPES.includes(serialized.type as PartType)) return null;
  // 種別に共通の項目。
  const maxHp = typeof serialized.maxHp === 'number' && Number.isFinite(serialized.maxHp) && serialized.maxHp > 0
    ? serialized.maxHp : 1;
  const hp = typeof serialized.hp === 'number' && Number.isFinite(serialized.hp)
    ? Math.max(0, Math.min(maxHp, serialized.hp)) : 0;
  const common = {
    id: typeof serialized.id === 'string' && serialized.id.length > 0
      ? serialized.id : Math.random().toString(36).slice(2),
    name: typeof serialized.name === 'string' ? serialized.name : 'Unknown Part',
    weight: nonNegative(serialized.weight),
    maxHp,
    hp,
  };
  // 種別ごとの項目。
  switch (serialized.type) {
    case 'armor':
      return createPart('armor', {
        ...common,
        damageReduction: typeof serialized.damageReduction === 'number' && Number.isFinite(serialized.damageReduction)
          ? Math.max(0, Math.min(1, serialized.damageReduction)) : 0,
      });
    case 'thruster':
      return createPart('thruster', {
        ...common,
        torque: nonNegative(serialized.torque),
        thrust: nonNegative(serialized.thrust),
        fuelConsumptionRate: nonNegative(serialized.fuelConsumptionRate),
      });
    case 'rcs_tank': {
      const maxFuel = nonNegative(serialized.maxFuel);
      return createPart('rcs_tank', { ...common, maxFuel, fuel: Math.min(maxFuel, nonNegative(serialized.fuel)) });
    }
    case 'radiator':
      return createPart('radiator', { ...common, coolingRate: nonNegative(serialized.coolingRate) });
    case 'solar_panel':
      return createPart('solar_panel', { ...common, powerGeneration: nonNegative(serialized.powerGeneration) });
    case 'weapon':
      return createPart('weapon', {
        ...common,
        weaponType: serialized.weaponType === 'cannon' || serialized.weaponType === 'missile'
          ? serialized.weaponType : 'gatling',
        fireRate: nonNegative(serialized.fireRate),
        damage: nonNegative(serialized.damage),
        muzzleVelocity: nonNegative(serialized.muzzleVelocity),
      });
    case 'hull':
      return createPart('hull', common);
    case 'cockpit':
      return createPart('cockpit', common);
    default:
      return null;
  }
}
