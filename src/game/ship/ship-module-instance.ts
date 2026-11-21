// モジュール定義から HP・温度・資源を持つ可変 instance を生成・複製する。
import type { ShipModuleDefinition, ShipModuleKind, FuelKind } from './ship-module-definition';
import { MAG_ROUNDS, START_SPARE_MAGS } from '../player/ammo-spec';

interface InstanceBase {
  readonly id: string;
  readonly definitionId: string;
  readonly kind: ShipModuleKind;
  hp: number;
  temperature: number; // K
}

export interface CockpitInstance extends InstanceBase { readonly kind: 'cockpit'; }
export interface TankInstance extends InstanceBase {
  readonly kind: 'tank';
  readonly fuelKind: FuelKind;
  fuel: number;
}
interface ThrusterInstance extends InstanceBase { readonly kind: 'thruster'; }
interface RcsInstance extends InstanceBase { readonly kind: 'rcs'; }
// 機関砲1門。弾薬は砲ごとに持つ(SPEC COMBAT.md「機関砲の数と弾薬の持ち主」)。rounds は装填中の
// マガジンの残弾、mags は予備マガジンの本数。
export interface WeaponInstance extends InstanceBase {
  readonly kind: 'weapon';
  rounds: number;
  mags: number;
}
interface ArmorInstance extends InstanceBase { readonly kind: 'armor'; }
interface RadiatorInstance extends InstanceBase {
  readonly kind: 'radiator';
  deployed: number; // 0..1
}
interface SolarPanelInstance extends InstanceBase {
  readonly kind: 'solar_panel';
  deployed: number; // 0..1
}
interface BoosterInstance extends InstanceBase {
  readonly kind: 'booster';
  fuel: number;
  ignited: boolean;
}
interface DockingPortInstance extends InstanceBase { readonly kind: 'docking_port'; }
interface DockInstance extends InstanceBase { readonly kind: 'dock'; }
interface DecouplerInstance extends InstanceBase { readonly kind: 'decoupler'; }

export type ShipModuleInstance =
  | CockpitInstance | TankInstance | ThrusterInstance | RcsInstance | WeaponInstance | ArmorInstance
  | RadiatorInstance | SolarPanelInstance | BoosterInstance | DockingPortInstance | DockInstance
  | DecouplerInstance;

export type ShipModuleState = Partial<Pick<ShipModuleInstance, 'hp'>>
  & Partial<Record<'temperature' | 'fuel' | 'deployed' | 'rounds' | 'mags', number | null>>
  & Partial<Record<'fuelKind', FuelKind | null>>
  & Partial<Record<'ignited', boolean | null>>;

let nextGeneratedId = 1;

function instanceId(): string {
  return `module-${nextGeneratedId++}`;
}

function normalizedHp(value: number | null, maxHp: number): number {
  return value !== null && Number.isFinite(value) ? Math.max(0, Math.min(maxHp, value)) : maxHp;
}

function normalizedFraction(value: number | null): number {
  return value !== null && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

// 0 以上 max 以下の整数。読めない値は fallback。
function normalizedCount(value: number | null, max: number, fallback: number): number {
  return value !== null && Number.isFinite(value) ? Math.max(0, Math.min(max, Math.floor(value))) : fallback;
}

function normalizedFuel(value: number | null, capacity: number): number {
  return value !== null && Number.isFinite(value) ? Math.max(0, Math.min(capacity, value)) : capacity;
}

// 定義と任意の保存 state から、assembly が所有する可変 instance を作る。
export function createShipModuleInstance(
  definition: ShipModuleDefinition, id = instanceId(), state: ShipModuleState = {},
): ShipModuleInstance {
  if (id.length === 0) throw new Error('ship module instance id must not be empty');
  const temperatureValue = state.temperature ?? null;
  const temperature = temperatureValue !== null && Number.isFinite(temperatureValue)
    ? Math.max(0, temperatureValue) : 255;
  const base = {
    id, definitionId: definition.id, kind: definition.kind,
    hp: normalizedHp(state.hp ?? null, definition.maxHp), temperature,
  };
  switch (definition.kind) {
    case 'tank': {
      const fuelKind = definition.abilities.fuelKind;
      if (fuelKind === undefined) throw new Error(`tank definition ${definition.id} lacks fuelKind`);
      const capacity = definition.abilities.fuelCapacity ?? 0;
      return { ...base, kind: 'tank', fuelKind, fuel: normalizedFuel(state.fuel ?? null, capacity) };
    }
    case 'radiator': return { ...base, kind: 'radiator', deployed: normalizedFraction(state.deployed ?? null) };
    case 'solar_panel': return { ...base, kind: 'solar_panel', deployed: normalizedFraction(state.deployed ?? 1) };
    case 'booster': {
      const capacity = definition.abilities.fuelCapacity ?? 0;
      return { ...base, kind: 'booster', fuel: normalizedFuel(state.fuel ?? null, capacity), ignited: state.ignited === true };
    }
    case 'cockpit': return { ...base, kind: 'cockpit' };
    case 'thruster': return { ...base, kind: 'thruster' };
    case 'rcs': return { ...base, kind: 'rcs' };
    // 弾薬の記録が無ければ開始時の積載で載る。
    case 'weapon': return {
      ...base, kind: 'weapon',
      rounds: normalizedCount(state.rounds ?? null, MAG_ROUNDS, MAG_ROUNDS),
      mags: normalizedCount(state.mags ?? null, Number.MAX_SAFE_INTEGER, START_SPARE_MAGS),
    };
    case 'armor': return { ...base, kind: 'armor' };
    case 'docking_port': return { ...base, kind: 'docking_port' };
    case 'dock': return { ...base, kind: 'dock' };
    case 'decoupler': return { ...base, kind: 'decoupler' };
  }
}

// split/clone 用に、可変 state が独立した instance を返す。
export function cloneShipModuleInstance(instance: ShipModuleInstance): ShipModuleInstance {
  return { ...instance };
}
