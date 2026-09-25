// モジュール船の描画処理が参照する不変な入力データ仕様。
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
  // 固体ブースターが燃焼中か。ブースター以外は null。
  readonly burning: boolean | null;
  readonly transform: ShipModuleRenderTransform;
}

export interface ShipRenderAssembly {
  readonly modules: readonly ShipModuleRenderInput[];
}
