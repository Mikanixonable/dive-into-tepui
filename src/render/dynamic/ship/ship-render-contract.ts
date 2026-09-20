// モジュール船の表示が読む不変な入力契約。ゲームの assembly はこの境界を越えない。
import type { Quat } from '../../../math/quat';
import type { Vec3 } from '../../../math/vec3';

export type ShipModuleRenderKind =
  | 'cockpit' | 'tank' | 'thruster' | 'rcs' | 'weapon' | 'armor' | 'radiator'
  | 'solar_panel' | 'booster' | 'docking_port' | 'dock' | 'decoupler';

export interface ShipModuleRenderTransform {
  readonly position: Vec3;
  readonly rotation: Quat;
}

export interface ShipModuleRenderInput {
  readonly id: string;
  readonly modelId: string;
  readonly kind: ShipModuleRenderKind;
  readonly hp: number;
  readonly maxHp: number;
  readonly deployed: number | null;
  readonly transform: ShipModuleRenderTransform;
}

export interface ShipRenderAssembly {
  readonly modules: readonly ShipModuleRenderInput[];
}
