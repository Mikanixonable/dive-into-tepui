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

// モジュールの表示上の強調の種別。色は描画側が種別ごとに決める。
export type ShipModuleEmphasisTone = 'selected' | 'piece' | 'conflict';

// モジュール1個へ要求される、表示上の強調と位置のずらし。intensity は強調の強さ (0..1)、
// offset は assembly 座標系での表示上のずらし [m]。
export interface ShipModuleEmphasis {
  readonly tone: ShipModuleEmphasisTone;
  readonly intensity: number;
  readonly offset: Vec3;
}

// 実体 id → モジュール id → そのモジュールへの宣言。宣言の無い実体・モジュールは通常どおり描く。
export type ShipModuleEmphasisMap = ReadonlyMap<string, ReadonlyMap<string, ShipModuleEmphasis>>;
