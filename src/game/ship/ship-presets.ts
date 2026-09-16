import { qFromUnitVectors, LOCAL_FORWARD, type Quat } from '../../math/quat';
import { v3 } from '../../math/vec3';
import { SHIP_MODULE_CATALOG, type ShipModuleCatalog } from './ship-module-catalog';
import { ShipAssembly, type ModuleTransform } from './ship-assembly';
import { createShipModuleInstance, type ShipModuleState } from './ship-module-instance';

function sideTransform(outward: ReturnType<typeof v3>): ModuleTransform {
  const rotation: Quat = qFromUnitVectors(LOCAL_FORWARD, outward);
  return { position: v3(outward.x * 3.5, outward.y * 3.5, outward.z * 3.5), rotation };
}

function instance(catalog: ShipModuleCatalog, definitionId: string, id: string, state?: ShipModuleState) {
  return createShipModuleInstance(catalog.require(definitionId), id, state);
}

function addSideEquipment(assembly: ShipAssembly, catalog: ShipModuleCatalog): void {
  assembly.connectSide(instance(catalog, 'radiator-standard', 'radiator-left'), 'cockpit', sideTransform(v3(1, 0, 0)));
  assembly.connectSide(instance(catalog, 'radiator-standard', 'radiator-right'), 'cockpit', sideTransform(v3(-1, 0, 0)));
  assembly.connectSide(instance(catalog, 'solar-panel-standard', 'solar-left'), 'cockpit', {
    position: v3(0, 3.5, 0), rotation: sideTransform(v3(0, 1, 0)).rotation,
  });
  assembly.connectSide(instance(catalog, 'solar-panel-standard', 'solar-right'), 'cockpit', {
    position: v3(0, -3.5, 0), rotation: sideTransform(v3(0, -1, 0)).rotation,
  });
}

// 旧 Player の集計値(HP 1,000、燃料 1,000、推力 400,000 N、トルク 2.24、
// 発電 100 W、放熱 84 m²、武装 damage 1 / 1,000 m/s)を保つ移行用の既定戦闘船。
// 乾燥 400 kg + 移行用燃料の質量 600 kg = 1,000 kg とし、400 m/s² も保つ。
export function createDefaultCombatPreset(catalog: ShipModuleCatalog = SHIP_MODULE_CATALOG): ShipAssembly {
  const assembly = new ShipAssembly(catalog, true);
  assembly.addRoot(instance(catalog, 'cockpit-standard', 'cockpit'));
  assembly.append(instance(catalog, 'tank-combat-main', 'main-tank'));
  assembly.append(instance(catalog, 'thruster-standard', 'main-thruster'));
  assembly.append(instance(catalog, 'weapon-gatling', 'weapon'));
  assembly.append(instance(catalog, 'armor-combat', 'armor'));
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
  assembly.connectSide(instance(catalog, 'dock-standard', 'dock-left'), 'cockpit', sideTransform(v3(1, 0, 0)), 'dock-left-edge');
  assembly.connectSide(instance(catalog, 'dock-standard', 'dock-right'), 'cockpit', sideTransform(v3(-1, 0, 0)), 'dock-right-edge');
  assembly.connectSide(instance(catalog, 'solar-panel-standard', 'solar-left'), 'main-tank', sideTransform(v3(1, 0, 0)));
  assembly.connectSide(instance(catalog, 'solar-panel-standard', 'solar-right'), 'main-tank', sideTransform(v3(-1, 0, 0)));
  assembly.connectSide(instance(catalog, 'radiator-standard', 'radiator-left'), 'rcs-tank', sideTransform(v3(1, 0, 0)));
  assembly.connectSide(instance(catalog, 'radiator-standard', 'radiator-right'), 'rcs-tank', sideTransform(v3(-1, 0, 0)));
  assembly.assertValid();
  return assembly;
}

export const createCombatPreset = createDefaultCombatPreset;
export const createDefaultBasePreset = createBasePreset;
