export type PartType = 'hull' | 'cockpit' | 'armor' | 'thruster' | 'rcs_tank' | 'radiator' | 'solar_panel' | 'weapon';

export interface Part {
  readonly id: string;
  readonly type: PartType;
  readonly name: string;
  readonly weight: number; // kg

  readonly maxHp: number;
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
  readonly damageReduction: number; // 0-1
}

export interface ThrusterPart extends Part {
  readonly type: 'thruster';
  readonly torque: number;
  readonly thrust: number;
  readonly fuelConsumptionRate: number; // kg/s(スロットル100%時)
}

export interface RcsTankPart extends Part {
  readonly type: 'rcs_tank';
  readonly maxFuel: number; // kg
  fuel: number; // kg
}

export interface RadiatorPart extends Part {
  readonly type: 'radiator';
  readonly coolingRate: number; // 展開しきった1枚の実効放熱面積 [m^2]
}

export interface SolarPanelPart extends Part {
  readonly type: 'solar_panel';
  readonly powerGeneration: number; // W
}

export interface WeaponPart extends Part {
  readonly type: 'weapon';
  readonly weaponType: 'gatling' | 'cannon' | 'missile';
  readonly fireRate: number; // rounds/s
  readonly damage: number; // 命中1回あたりのダメージ
  readonly muzzleVelocity: number; // m/s
}

export type AnyPart = HullPart | CockpitPart | ArmorPart | ThrusterPart | RcsTankPart | RadiatorPart | SolarPanelPart | WeaponPart;

type ExtractPart<TType extends PartType> = Extract<AnyPart, { type: TType }>;

// 旧 Ship が必要とする最小の部品集合。敵は PartInventory、移行中の自機は
// ShipAssembly 側の adapter を渡せるよう、Ship から具体コンテナの生成を切り離す。
export interface ShipPartCollection {
  readonly parts: readonly AnyPart[];
  replace(parts: readonly Part[]): void;
  has(part: Part): boolean;
  ofType<T extends PartType>(type: T): readonly ExtractPart<T>[];
  healthySum<T extends PartType>(type: T, valueOf: (part: ExtractPart<T>) => number): number;
  totalFuel(): number;
  totalMaxFuel(): number;
  consumeFuel(amount: number): number;
  refuelFuel(amount: number): number;
}

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

// 直列化された部品を id ごと復元する。種別が不正なら null、ほかの項目が不正ならその項目を安全な値へ
// 落とす。
export function deserializePart(serialized: AnyPart): AnyPart | null {
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

// 直列化された部品の一覧を復元する。種別が不正な部品は落とす。1つも残らなければ、既定の構成で
// 組ませるため undefined を返す。
export function deserializeParts(serialized: readonly AnyPart[]): AnyPart[] | undefined {
  const parts = Array.isArray(serialized)
    ? serialized.map(deserializePart).filter((part) => part !== null)
    : [];
  return parts.length > 0 ? parts : undefined;
}
