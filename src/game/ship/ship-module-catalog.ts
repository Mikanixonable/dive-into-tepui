import {
  bodyPrimitive, defineShipModule, type FuelKind, type ShipModuleDefinition, type ShipModuleKind,
} from './ship-module-definition';

function moduleDefinition(
  id: string, kind: ShipModuleKind, length: number, maxHp: number, dryMass: number,
  abilities: ShipModuleDefinition['abilities'] = {}, radius = 3,
): ShipModuleDefinition {
  return defineShipModule({
    id, kind, name: id, length, diameter: 6, dryMass, maxHp, modelId: id,
    solidPrimitives: [bodyPrimitive(length, radius)], abilities,
  });
}

function tank(
  id: string, length: number, fuelKind: FuelKind, capacity: number, dryMass = 250,
  fuelMassPerUnit = 1,
): ShipModuleDefinition {
  return moduleDefinition(id, 'tank', length, 80, dryMass, { fuelKind, fuelCapacity: capacity, fuelMassPerUnit });
}

const definitions: readonly ShipModuleDefinition[] = [
  moduleDefinition('cockpit-standard', 'cockpit', 3, 100, 100),
  tank('tank-3-main', 3, 'main', 80),
  tank('tank-6-main', 6, 'main', 160),
  tank('tank-12-main', 12, 'main', 320),
  tank('tank-3-rcs', 3, 'rcs', 80),
  tank('tank-6-rcs', 6, 'rcs', 160),
  tank('tank-12-rcs', 12, 'rcs', 320),
  // 旧戦闘船は容量 1,000 のタンクを1個持っていた。標準建造サイズとは別の移行用定義として残す。
  tank('tank-combat-main', 6, 'main', 1_000, 100, 0.6),
  moduleDefinition('thruster-standard', 'thruster', 1, 80, 50, { thrust: 400_000, torque: 2.24 }),
  moduleDefinition('rcs-standard', 'rcs', 1, 50, 50, { torque: 2.24 }),
  moduleDefinition('weapon-gatling', 'weapon', 1, 80, 20, {
    weaponDamage: 1, fireRate: 1 / 0.06, muzzleVelocity: 1_000,
  }),
  moduleDefinition('armor-standard', 'armor', 1, 100, 100, { armorReduction: 0.2 }),
  moduleDefinition('armor-combat', 'armor', 1, 500, 100, { armorReduction: 0.2 }),
  moduleDefinition('radiator-standard', 'radiator', 1, 50, 10, { radiationArea: 42 }),
  moduleDefinition('solar-panel-standard', 'solar_panel', 1, 30, 5, { powerGeneration: 50 }),
  moduleDefinition('booster-standard', 'booster', 6, 100, 200, {
    fuelCapacity: 800, fuelMassPerUnit: 1, thrust: 600_000,
  }),
  moduleDefinition('docking-port-standard', 'docking_port', 1, 50, 40),
  moduleDefinition('dock-standard', 'dock', 1, 50, 40),
  moduleDefinition('decoupler-standard', 'decoupler', 1, 50, 60),
];

const aliases: Readonly<Record<string, string>> = Object.freeze({
  'cockpit': 'cockpit-standard',
  'thruster': 'thruster-standard',
  'rcs': 'rcs-standard',
  'weapon': 'weapon-gatling',
  'armor': 'armor-standard',
  'radiator': 'radiator-standard',
  'solar_panel': 'solar-panel-standard',
  'booster': 'booster-standard',
  'docking_port': 'docking-port-standard',
  'dock': 'dock-standard',
  'decoupler': 'decoupler-standard',
  'tank-main-3': 'tank-3-main', 'tank-main-6': 'tank-6-main', 'tank-main-12': 'tank-12-main',
  'tank-rcs-3': 'tank-3-rcs', 'tank-rcs-6': 'tank-6-rcs', 'tank-rcs-12': 'tank-12-rcs',
  'tank-3m-main': 'tank-3-main', 'tank-6m-main': 'tank-6-main', 'tank-12m-main': 'tank-12-main',
  'tank-3m-rcs': 'tank-3-rcs', 'tank-6m-rcs': 'tank-6-rcs', 'tank-12m-rcs': 'tank-12-rcs',
});

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
    return this.byId.has(this.canonicalId(id));
  }

  public get(id: string): ShipModuleDefinition | null {
    return this.byId.get(this.canonicalId(id)) ?? null;
  }

  public require(id: string): ShipModuleDefinition {
    const definition = this.get(id);
    if (definition === null) throw new Error(`unknown ship module definition: ${id}`);
    return definition;
  }

  public all(): readonly ShipModuleDefinition[] {
    return [...this.byId.values()];
  }

  private canonicalId(id: string): string {
    return aliases[id] ?? id;
  }
}

export const SHIP_MODULE_CATALOG = new ShipModuleCatalog();
export const shipModuleCatalog = SHIP_MODULE_CATALOG;
