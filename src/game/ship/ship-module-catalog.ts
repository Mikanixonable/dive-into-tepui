// 建造・preset・保存復元が共有する船体モジュール定義を検索可能な一覧として提供する。
import {
  bodyPrimitive, defineShipModule, type FuelKind, type ShipModuleDefinition, type ShipModuleKind,
} from './ship-module-definition';

function moduleDefinition(
  id: string, kind: ShipModuleKind, length: number, maxHp: number, dryMass: number,
  abilities: ShipModuleDefinition['abilities'] = {}, radius = 3, modelId = id,
): ShipModuleDefinition {
  return defineShipModule({
    id, kind, name: id, length, diameter: 6, dryMass, maxHp, modelId,
    solidPrimitives: [bodyPrimitive(length, radius)], abilities,
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

const definitions: readonly ShipModuleDefinition[] = [
  moduleDefinition('cockpit-standard', 'cockpit', 3, 100, 100),
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
  moduleDefinition('weapon-gatling', 'weapon', 1, 80, 20, {
    weaponDamage: 1, fireRate: 1 / 0.06, muzzleVelocity: 1_000,
  }),
  moduleDefinition('armor-standard', 'armor', 1, 100, 100, { armorReduction: 0.2 }),
  moduleDefinition('armor-combat', 'armor', 1, 370, 50, { armorReduction: 0.2 }),
  moduleDefinition('radiator-standard', 'radiator', 1, 50, 10, { radiationArea: 42 }),
  moduleDefinition('solar-panel-standard', 'solar_panel', 1, 30, 5, { powerGeneration: 50 }),
  moduleDefinition('booster-standard', 'booster', 6, 100, 200, {
    fuelCapacity: 800, fuelMassPerUnit: 1, thrust: 600_000, fuelConsumptionRate: 80,
  }),
  moduleDefinition('docking-port-standard', 'docking_port', 1, 50, 40),
  moduleDefinition('dock-standard', 'dock', 1, 50, 40),
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
