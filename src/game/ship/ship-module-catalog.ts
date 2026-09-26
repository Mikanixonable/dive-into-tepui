// 建造・preset・保存復元が共有する船体モジュール定義を検索可能な一覧として提供する。
import { v3, type Vec3 } from '../../math/vec3';
import {
  bodyPrimitive, defineShipModule, type FuelKind, type LocalCappedCylinder, type ShipModuleCategory,
  type ShipModuleDefinition, type ShipModuleKind,
} from './ship-module-definition';

const MODULE_NAMES: Readonly<Record<string, string>> = {
  'cockpit-standard': 'コックピット',
  'tank-3-main': '主燃料タンク 3m', 'tank-6-main': '主燃料タンク 6m',
  'tank-12-main': '主燃料タンク 12m', 'tank-3-rcs': 'RCSタンク 3m',
  'tank-6-rcs': 'RCSタンク 6m', 'tank-12-rcs': 'RCSタンク 12m',
  'tank-combat-main': '戦闘用主燃料タンク', 'tank-combat-rcs': '戦闘用RCSタンク',
  'thruster-standard': '主推進器', 'rcs-standard': 'RCSスラスター', 'rcs-combat': '戦闘用RCS',
  'weapon-gatling': '機関砲', 'armor-standard': '装甲', 'armor-combat': '戦闘用装甲',
  'radiator-standard': 'ラジエーター', 'solar-panel-standard': '太陽電池',
  'booster-standard': 'ブースター', 'docking-port-standard': 'ドッキングポート',
  'dock-standard': '建造ドック', 'decoupler-standard': 'デカプラー',
};

const CATEGORY_BY_KIND: Readonly<Record<ShipModuleKind, ShipModuleCategory>> = {
  cockpit: 'command', dock: 'command', docking_port: 'utility',
  tank: 'fuel', booster: 'propulsion', thruster: 'propulsion', rcs: 'propulsion',
  weapon: 'combat', armor: 'combat', radiator: 'utility', solar_panel: 'utility', decoupler: 'utility',
};

function moduleDefinition(
  id: string, kind: ShipModuleKind, length: number, maxHp: number, dryMass: number,
  abilities: ShipModuleDefinition['abilities'] = {}, radius = 3, modelId = id, muzzles: readonly Vec3[] = [],
  feedPort: Vec3 = v3(), solids?: readonly LocalCappedCylinder[],
  ports: { ejection: Vec3; linkExit: Vec3 } = { ejection: v3(), linkExit: v3() },
  diameter = 6,
): ShipModuleDefinition {
  return defineShipModule({
    id, kind, name: MODULE_NAMES[id] ?? id, category: CATEGORY_BY_KIND[kind], length, diameter, dryMass, maxHp, modelId,
    solidPrimitives: solids ?? [bodyPrimitive(length, radius)], muzzles, feedPort,
    ejectionPort: ports.ejection, linkExitPort: ports.linkExit, abilities,
  });
}

function tank(
  id: string, length: number, fuelKind: FuelKind, capacity: number, dryMass = 250,
  fuelMassPerUnit = 1, modelId = id,
): ShipModuleDefinition {
  return moduleDefinition(
    id, 'tank', length, 80, dryMass, { fuelKind, fuelCapacity: capacity, fuelMassPerUnit }, 3, modelId,
  );
}

// 既定船の実慣性に対して基準角加速度約 1.4 rad/s² を得る RCS 実トルク [N m]。
const RCS_MODULE_TORQUE = 24_000;

// 回転砲の砲口 [m]。モジュール長 9 m の前端面に置く。
const GATLING_MUZZLES = [v3(0, 0, 4.5)];
// 後方から中心軸へ入る給弾口 [m]。
const GATLING_FEED_PORT = v3(0, 0, -4.15);
// 空薬莢の排出口 [m]。機関部付近の左舷側。
const GATLING_EJECTION_PORT = v3(-1.72, -0.30, 0.5);
// 空リンク・マガジン外枠の排出口 [m]。後方寄りの左舷外箱。
const GATLING_LINK_EXIT_PORT = v3(-1.32, 0, -2.6);

// 9 m の砲身・給弾路を長手方向に分け、端部の接触範囲を結合面内に収める。
const GATLING_SOLID_PRIMITIVES: readonly LocalCappedCylinder[] = [
  { center: v3(0, 0, -3.375), axis: v3(0, 0, 1), halfLength: 1.125, radius: 1.48 },
  { center: v3(0, 0, -1.125), axis: v3(0, 0, 1), halfLength: 1.125, radius: 1.48 },
  { center: v3(0, 0, 1.125), axis: v3(0, 0, 1), halfLength: 1.125, radius: 1.48 },
  { center: v3(0, 0, 3.375), axis: v3(0, 0, 1), halfLength: 1.125, radius: 1.48 },
];

// 展開部品の実体は、座板・脚・台座・駆動部でできた取付構造まで。翼列は展開で実体から外れるので
// 接触形状に含めず、取付構造の束(座板の張り出しを含む半径)を包む円柱で近似する。
const DEPLOYABLE_MOUNT_PRIMITIVE: LocalCappedCylinder = {
  center: v3(), axis: v3(0, 0, 1), halfLength: 0.55, radius: 1.35,
};

// 結合機構モジュールの実体は、直径 3.0 m の機構頭部と細い幹、船体曲面へ伏せる座板・脚・
// 襟環の取付構造まで。取付構造は後端面の外へ張り出すので、両者を束ねて包む円柱で近似する。
const DOCK_MODULE_PRIMITIVE: LocalCappedCylinder = {
  center: v3(0, 0, -0.05), axis: v3(0, 0, 1), halfLength: 0.55, radius: 1.65,
};

// コックピットは後端半径 3 m から前端半径 1.5 m へ細くなるため、軸方向に分割して接触形状を近似する。
// 各円柱は区間の後端半径で覆い、単一の半径 3 m 円柱が前部まで広がる過大判定を避ける。
const COCKPIT_SOLID_PRIMITIVES: readonly LocalCappedCylinder[] = [
  { center: v3(0, 0, -1.25), axis: v3(0, 0, 1), halfLength: 0.25, radius: 3.00 },
  { center: v3(0, 0, -0.75), axis: v3(0, 0, 1), halfLength: 0.25, radius: 2.75 },
  { center: v3(0, 0, -0.25), axis: v3(0, 0, 1), halfLength: 0.25, radius: 2.50 },
  { center: v3(0, 0, 0.25), axis: v3(0, 0, 1), halfLength: 0.25, radius: 2.25 },
  { center: v3(0, 0, 0.75), axis: v3(0, 0, 1), halfLength: 0.25, radius: 2.00 },
  { center: v3(0, 0, 1.25), axis: v3(0, 0, 1), halfLength: 0.25, radius: 1.75 },
];

const definitions: readonly ShipModuleDefinition[] = [
  moduleDefinition('cockpit-standard', 'cockpit', 3, 100, 100, {}, 3, 'cockpit-standard', [], v3(),
    COCKPIT_SOLID_PRIMITIVES),
  tank('tank-3-main', 3, 'main', 80),
  tank('tank-6-main', 6, 'main', 160),
  tank('tank-12-main', 12, 'main', 320),
  tank('tank-3-rcs', 3, 'rcs', 80),
  tank('tank-6-rcs', 6, 'rcs', 160),
  tank('tank-12-rcs', 12, 'rcs', 320),
  // 既定戦闘船の能力・質量特性を固定する専用タンク。
  tank('tank-combat-main', 6, 'main', 1_000, 100, 0.6),
  // RCS の容量は持つが、推進剤質量は主タンク側の集計値に含まれる。
  tank('tank-combat-rcs', 3, 'rcs', 80, 25, 0, 'tank-3-rcs'),
  moduleDefinition('thruster-standard', 'thruster', 1, 80, 50, {
    thrust: 400_000, fuelConsumptionRate: 1,
  }),
  moduleDefinition('rcs-standard', 'rcs', 1, 50, 50, { torque: RCS_MODULE_TORQUE, fuelConsumptionRate: 1 }),
  moduleDefinition(
    'rcs-combat', 'rcs', 1, 50, 25, { torque: RCS_MODULE_TORQUE, fuelConsumptionRate: 1 }, 3, 'rcs-standard',
  ),
  moduleDefinition('weapon-gatling', 'weapon', 9, 80, 20, {
    weaponDamage: 1, fireRate: 1 / 0.06, muzzleVelocity: 1_000,
  }, 1.5, 'weapon-gatling', GATLING_MUZZLES, GATLING_FEED_PORT, GATLING_SOLID_PRIMITIVES, {
    ejection: GATLING_EJECTION_PORT, linkExit: GATLING_LINK_EXIT_PORT,
  }, 3),
  moduleDefinition('armor-standard', 'armor', 1, 100, 100, { armorReduction: 0.2 }),
  moduleDefinition('armor-combat', 'armor', 1, 370, 50, { armorReduction: 0.2 }),
  moduleDefinition('radiator-standard', 'radiator', 1, 50, 10, { radiationArea: 4.8 },
    3, 'radiator-standard', [], v3(), [DEPLOYABLE_MOUNT_PRIMITIVE]),
  moduleDefinition('solar-panel-standard', 'solar_panel', 1, 30, 5, { powerGeneration: 825 },
    3, 'solar-panel-standard', [], v3(), [DEPLOYABLE_MOUNT_PRIMITIVE]),
  moduleDefinition('booster-standard', 'booster', 6, 100, 200, {
    fuelCapacity: 800, fuelMassPerUnit: 1, thrust: 600_000, fuelConsumptionRate: 80,
  }),
  moduleDefinition('docking-port-standard', 'docking_port', 1, 50, 40, {}, 1.5,
    'docking-port-standard', [], v3(), [DOCK_MODULE_PRIMITIVE], undefined, 3),
  moduleDefinition('dock-standard', 'dock', 1, 50, 40, {}, 1.5,
    'dock-standard', [], v3(), [DOCK_MODULE_PRIMITIVE], undefined, 3),
  moduleDefinition('decoupler-standard', 'decoupler', 1, 50, 60),
];

export class ShipModuleCatalog {
  private readonly byId: ReadonlyMap<string, ShipModuleDefinition>;

  public constructor(items: readonly ShipModuleDefinition[] = definitions) {
    const map = new Map<string, ShipModuleDefinition>();
    for (const item of items) {
      if (map.has(item.id)) throw new Error(`duplicate ship module definition: ${item.id}`);
      map.set(item.id, item);
    }
    this.byId = map;
  }

  public has(id: string): boolean {
    return this.byId.has(id);
  }

  public get(id: string): ShipModuleDefinition | null {
    return this.byId.get(id) ?? null;
  }

  public require(id: string): ShipModuleDefinition {
    const definition = this.get(id);
    if (definition === null) throw new Error(`unknown ship module definition: ${id}`);
    return definition;
  }

  public all(): readonly ShipModuleDefinition[] {
    return [...this.byId.values()];
  }
}

export const SHIP_MODULE_CATALOG = new ShipModuleCatalog();
