// 新規配置に使う既定戦闘船と基地の assembly preset を組み立てる。
import { SHIP_MODULE_CATALOG, type ShipModuleCatalog } from './ship-module-catalog';
import { ShipAssembly } from './ship-assembly';
import { createShipModuleInstance, type ShipModuleState } from './ship-module-instance';

function instance(catalog: ShipModuleCatalog, definitionId: string, id: string, state?: ShipModuleState) {
  return createShipModuleInstance(catalog.require(definitionId), id, state);
}

function addSideEquipment(assembly: ShipAssembly, catalog: ShipModuleCatalog): void {
  assembly.connectSide(instance(catalog, 'solar-panel-standard', 'solar-left'), 'main-tank', 'side:-x');
  assembly.connectSide(instance(catalog, 'solar-panel-standard', 'solar-right'), 'main-tank', 'side:+x');
  assembly.connectSide(instance(catalog, 'radiator-standard', 'radiator'), 'main-tank', 'side:-y');
  assembly.connectSide(instance(catalog, 'docking-port-standard', 'docking-port'), 'main-tank', 'side:+y');
}

// 標準戦闘艦プリセットを構築する（諸元: HP 1,000、満載質量 1,030 kg、推力 400 kN、発電 1,650 W、放熱面積 4.8 m²、弾速 1,000 m/s）。
export function createDefaultCombatPreset(catalog: ShipModuleCatalog = SHIP_MODULE_CATALOG): ShipAssembly {
  const assembly = new ShipAssembly(catalog, true);
  assembly.addRoot(instance(catalog, 'cockpit-standard', 'cockpit'));
  assembly.prepend(instance(catalog, 'weapon-gatling', 'weapon'), 'cockpit');
  assembly.append(instance(catalog, 'armor-combat', 'armor'), 'cockpit');
  assembly.append(instance(catalog, 'tank-combat-main', 'main-tank'), 'armor');
  assembly.append(instance(catalog, 'tank-combat-rcs', 'rcs-tank'), 'main-tank');
  assembly.append(instance(catalog, 'rcs-combat', 'rcs'), 'rcs-tank');
  assembly.append(instance(catalog, 'thruster-standard', 'main-thruster'), 'rcs');
  addSideEquipment(assembly, catalog);
  assembly.assertValid();
  return assembly;
}

// 仕様上の基地 preset。軸上の2種の tank と側面の dock / solar / radiator を2個ずつ持つ。
export function createBasePreset(catalog: ShipModuleCatalog = SHIP_MODULE_CATALOG): ShipAssembly {
  const assembly = new ShipAssembly(catalog, true);
  assembly.addRoot(instance(catalog, 'cockpit-standard', 'cockpit'));
  assembly.append(instance(catalog, 'tank-6-main', 'main-tank'));
  assembly.append(instance(catalog, 'tank-6-rcs', 'rcs-tank'));
  assembly.connectSide(instance(catalog, 'solar-panel-standard', 'solar-left'), 'cockpit', 'side:+y');
  assembly.connectSide(instance(catalog, 'solar-panel-standard', 'solar-right'), 'cockpit', 'side:-y');
  assembly.connectSide(instance(catalog, 'dock-standard', 'dock-left'), 'main-tank', 'side:-x', 'dock-left-edge');
  assembly.connectSide(instance(catalog, 'dock-standard', 'dock-right'), 'main-tank', 'side:+x', 'dock-right-edge');
  assembly.connectSide(instance(catalog, 'radiator-standard', 'radiator-left'), 'rcs-tank', 'side:-x');
  assembly.connectSide(instance(catalog, 'radiator-standard', 'radiator-right'), 'rcs-tank', 'side:+x');
  assembly.assertValid();
  return assembly;
}
