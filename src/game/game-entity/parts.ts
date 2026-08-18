import { Vec3 } from '../../physics/vec3';

export type PartType =
  | 'hull' | 'cockpit' | 'armor' | 'thruster' | 'rcs_tank' | 'radiator' | 'solar_panel' | 'weapon'
  | 'base_module' | 'communication' | 'autopilot';

export interface Part {
  readonly id: string;
  readonly type: PartType;
  readonly name: string;
  readonly weight: number; // kg

  maxHp: number;
  hp: number; // 0 = 破壊/機能停止
}

export interface HullPart extends Part {
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
  coolingRate: number; // ThermalSystem 内の任意単位
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

// 機体を受け入れる口。ハッチとスロットの位置・法線、受け入れ条件の閾値を持つ。
// ドッキングポートによる結合はまだ無く、格納の判定は距離と相対速度だけで決まる。
export interface DockPort {
  readonly localPos: Vec3;
  readonly localNormal: Vec3;
}

export interface BaseModulePart extends Part {
  readonly type: 'base_module';
  // 中央ハッチ。機体が正面から近づく1つ目の口。
  readonly hatch: DockPort;
  // ドックスロット。格納した機体を並べる場所でもある。
  readonly dockSlots: readonly DockPort[];
  // 格納できる機体数。
  readonly capacity: number;
  // 受け入れの閾値。距離 [m] と、口の法線に対する向きの内積の下限。
  readonly hatchCaptureDist: number;
  readonly hatchCaptureAlignment: number;
  readonly slotCaptureDist: number;
  readonly slotCaptureAlignment: number;
  // 相対速度の上限 [m/s]。
  readonly captureRelSpeed: number;
}

export interface CommunicationPart extends Part {
  readonly type: 'communication';
  // 通信圏の判定へ渡す到達距離 [m]。
  readonly range: number;
}

export interface AutopilotPart extends Part {
  readonly type: 'autopilot';
}

export type AnyPart =
  | HullPart | CockpitPart | ArmorPart | ThrusterPart | RcsTankPart | RadiatorPart | SolarPanelPart | WeaponPart
  | BaseModulePart | CommunicationPart | AutopilotPart;

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
  switch (data.type) {
    case 'hull': return createPart('hull', data);
    case 'cockpit': return createPart('cockpit', data);
    case 'armor': return createPart('armor', data);
    case 'thruster': return createPart('thruster', data);
    case 'rcs_tank': return createPart('rcs_tank', data);
    case 'radiator': return createPart('radiator', data);
    case 'solar_panel': return createPart('solar_panel', data);
    case 'weapon': return createPart('weapon', data);
    case 'base_module': return createPart('base_module', data);
    case 'communication': return createPart('communication', data);
    case 'autopilot': return createPart('autopilot', data);
  }
}
