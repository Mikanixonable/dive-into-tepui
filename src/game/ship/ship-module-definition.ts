// 船体モジュールの不変な寸法・質量・能力・衝突プリミティブを定義する。
import { v3, type Vec3 } from '../../math/vec3';

// 建造可能な部品の種別。表示・物理・保存はこのタグを共有するが、振る舞いは instance の状態を読む。
export const SHIP_MODULE_KINDS = [
  'cockpit', 'tank', 'thruster', 'rcs', 'weapon', 'armor', 'radiator', 'solar_panel',
  'booster', 'docking_port', 'dock', 'decoupler',
] as const;
export type ShipModuleKind = typeof SHIP_MODULE_KINDS[number];
export type FuelKind = 'main' | 'rcs';
export type ShipModuleCategory = 'command' | 'fuel' | 'propulsion' | 'combat' | 'utility';

// 円柱は機体座標系で定義する。axis は単位ベクトル、半長 halfLength と半径 radius は m。
export interface LocalCappedCylinder {
  readonly center: Vec3;
  readonly axis: Vec3;
  readonly halfLength: number;
  readonly radius: number;
}

// 数値の能力は「健全な instance だけを集計する」静的値である。
// 燃料の表示量と運動に加える質量は単位が異なるため、換算率を definition に固定する。
export interface ShipModuleAbilities {
  readonly fuelKind?: FuelKind;
  readonly fuelCapacity?: number;
  readonly fuelMassPerUnit?: number; // kg / fuel unit
  readonly thrust?: number; // N
  readonly torque?: number; // N m
  readonly fuelConsumptionRate?: number; // fuel unit/s
  readonly powerGeneration?: number; // W
  readonly radiationArea?: number; // m²
  readonly weaponDamage?: number;
  readonly fireRate?: number; // rounds/s
  readonly muzzleVelocity?: number; // m/s
  readonly armorReduction?: number; // 0..1
}

export interface ShipModuleDefinition {
  readonly id: string;
  readonly kind: ShipModuleKind;
  readonly name: string;
  readonly category?: ShipModuleCategory;
  readonly length: number; // m, +Z 軸方向
  readonly diameter: number; // m
  readonly dryMass: number; // kg
  readonly maxHp: number;
  readonly modelId: string;
  readonly solidPrimitives: readonly LocalCappedCylinder[];
  // 砲身先端の位置。モジュール局所 [m] で、発射はこの順に交互に巡る。
  readonly muzzles: readonly Vec3[];
  // 給弾ベルトの取り込み口。モジュール局所 [m] で、ベルトはここから +X 方向へ伸びる。
  readonly feedPort: Vec3;
  // 空薬莢の排出口。モジュール局所 [m] で、薬莢はここから -X 方向へ出る。
  readonly ejectionPort: Vec3;
  // 空になったベルトリンクとマガジン外枠の排出口。モジュール局所 [m] で、外枠はここから -X 方向へ出る。
  readonly linkExitPort: Vec3;
  // 砲身交換で外れる砲身束の位置。モジュール局所 [m] で、砲身束はここから -Y 方向へ取り外される。
  readonly barrelPort: Vec3;
  readonly abilities: ShipModuleAbilities;
}

function frozenVector(value: Vec3): Vec3 {
  return Object.freeze(v3(value.x, value.y, value.z));
}

function finitePositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`ship module ${label} must be positive`);
  return value;
}

function freezeDefinition(definition: ShipModuleDefinition): ShipModuleDefinition {
  const primitives = definition.solidPrimitives.map((primitive) => Object.freeze({
    center: frozenVector(primitive.center),
    axis: frozenVector({
      x: primitive.axis.x / Math.hypot(primitive.axis.x, primitive.axis.y, primitive.axis.z),
      y: primitive.axis.y / Math.hypot(primitive.axis.x, primitive.axis.y, primitive.axis.z),
      z: primitive.axis.z / Math.hypot(primitive.axis.x, primitive.axis.y, primitive.axis.z),
    } as Vec3),
    halfLength: primitive.halfLength,
    radius: primitive.radius,
  }));
  return Object.freeze({
    ...definition,
    solidPrimitives: Object.freeze(primitives),
    muzzles: Object.freeze(definition.muzzles.map(frozenVector)),
    feedPort: frozenVector(definition.feedPort),
    ejectionPort: frozenVector(definition.ejectionPort),
    linkExitPort: frozenVector(definition.linkExitPort),
    barrelPort: frozenVector(definition.barrelPort),
    abilities: Object.freeze({ ...definition.abilities }),
  });
}

// definition を検証し、入れ子の配列・値まで凍結して返す。
export function defineShipModule(
  definition: Omit<ShipModuleDefinition, 'solidPrimitives'> & {
    readonly solidPrimitives: readonly LocalCappedCylinder[];
  },
): ShipModuleDefinition {
  finitePositive(definition.length, 'length');
  finitePositive(definition.diameter, 'diameter');
  finitePositive(definition.dryMass, 'dryMass');
  finitePositive(definition.maxHp, 'maxHp');
  if (definition.id.length === 0 || definition.modelId.length === 0) {
    throw new Error('ship module id and modelId must not be empty');
  }
  if (definition.solidPrimitives.length === 0) throw new Error('ship module needs a solid primitive');
  for (const primitive of definition.solidPrimitives) {
    finitePositive(primitive.halfLength, 'primitive halfLength');
    finitePositive(primitive.radius, 'primitive radius');
    if (!Number.isFinite(primitive.center.x) || !Number.isFinite(primitive.center.y)
      || !Number.isFinite(primitive.center.z)) throw new Error('primitive center must be finite');
    const axisLength = Math.hypot(primitive.axis.x, primitive.axis.y, primitive.axis.z);
    if (!(axisLength > 1e-12) || !Number.isFinite(axisLength)) throw new Error('primitive axis must be nonzero');
  }
  for (const muzzle of definition.muzzles) {
    if (!Number.isFinite(muzzle.x) || !Number.isFinite(muzzle.y) || !Number.isFinite(muzzle.z)) {
      throw new Error('muzzle position must be finite');
    }
  }
  for (const [label, port] of [
    ['feed port', definition.feedPort],
    ['ejection port', definition.ejectionPort],
    ['link exit port', definition.linkExitPort],
    ['barrel port', definition.barrelPort],
  ] as const) {
    if (!Number.isFinite(port.x) || !Number.isFinite(port.y) || !Number.isFinite(port.z)) {
      throw new Error(`${label} must be finite`);
    }
  }
  for (const value of Object.values(definition.abilities)) {
    if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`ship module abilities must be finite and nonnegative: ${definition.id}`);
    }
  }
  return freezeDefinition(definition);
}

// +Z 軸を長手方向とする原点中心の円柱 primitive を作る。
export function bodyPrimitive(length: number, radius = 3): LocalCappedCylinder {
  return { center: v3(), axis: v3(0, 0, 1), halfLength: length / 2, radius };
}
