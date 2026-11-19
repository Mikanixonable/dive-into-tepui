import type { Quat } from '../../math/quat';
import type { Vec3 } from '../../math/vec3';
import type { ShipModuleInstance } from './ship-module-instance';
import type { ShipAssembly } from './ship-assembly';

export type ShipRole = 'ship' | 'base' | 'material';
export type ConnectionKind = 'axial' | 'side' | 'docking' | 'construction';
export type SideSlot = 'side:+x' | 'side:-x' | 'side:+y' | 'side:-y';

export const SIDE_SLOTS: readonly SideSlot[] = ['side:+x', 'side:-x', 'side:+y', 'side:-y'];

export interface ModuleTransform {
  readonly position: Vec3;
  readonly rotation: Quat;
}

export interface ShipConnection {
  readonly id: string;
  readonly parentId: string;
  readonly childId: string;
  readonly kind: ConnectionKind;
  readonly childTransform: ModuleTransform;
  readonly sideSlot?: SideSlot;
  readonly sideReversed?: boolean;
}

export interface ShipAssemblyValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export interface DockingMergeResult {
  readonly assembly: ShipAssembly;
  readonly connectionId: string;
  readonly moduleIds: ReadonlyMap<string, string>;
  readonly connectionIds: ReadonlyMap<string, string>;
}

export interface ShipAssemblyTotals {
  readonly hp: number;
  readonly maxHp: number;
  readonly thrust: number;
  readonly torque: number;
  // 主推進(thruster)の燃料消費率の合計 [unit/s]。
  readonly mainFuelConsumptionRate: number;
  readonly mainFuel: number;
  readonly rcsFuel: number;
  readonly boosterFuel: number;
  readonly maxMainFuel: number;
  readonly maxRcsFuel: number;
  readonly maxBoosterFuel: number;
  // 主燃料タンク満載時の推進剤質量 [kg] と、容量で加重平均した 1 unit あたり質量 [kg/unit]。
  readonly maxMainFuelMass: number;
  readonly mainFuelMassPerUnit: number;
  readonly power: number;
  readonly radiation: number;
  readonly weaponDamage: number;
  readonly fireRate: number;
  readonly muzzleVelocity: number;
  readonly dryMass: number;
  readonly mass: number;
  // 全タンク・ブースター満載時の質量 [kg]。
  readonly fullMass: number;
}

export interface ShipAssemblyNode {
  instance: ShipModuleInstance;
  transform: ModuleTransform;
}

// 接舷接続の端点になれる module(dock または docking_port)か。
export function isDockingModule(
  module: ShipModuleInstance | null,
): module is ShipModuleInstance & { readonly kind: 'dock' | 'docking_port' } {
  return module?.kind === 'dock' || module?.kind === 'docking_port';
}


