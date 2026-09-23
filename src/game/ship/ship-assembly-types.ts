import type { Quat } from '../../math/quat';
import type { Vec3 } from '../../math/vec3';
import type { ShipModuleCatalog } from './ship-module-catalog';
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
  readonly mainFuel: number;
  readonly rcsFuel: number;
  readonly boosterFuel: number;
  readonly maxMainFuel: number;
  readonly maxRcsFuel: number;
  readonly maxBoosterFuel: number;
  readonly power: number;
  readonly radiation: number;
  readonly weaponDamage: number;
  readonly fireRate: number;
  readonly muzzleVelocity: number;
  readonly dryMass: number;
  readonly mass: number;
}

export interface ShipAssemblyNode {
  instance: ShipModuleInstance;
  transform: ModuleTransform;
}

export function isDockingModule(
  module: ShipModuleInstance | null,
): module is ShipModuleInstance & { readonly kind: 'dock' | 'docking_port' } {
  return module?.kind === 'dock' || module?.kind === 'docking_port';
}

export type ShipAssemblyCatalog = ShipModuleCatalog;
