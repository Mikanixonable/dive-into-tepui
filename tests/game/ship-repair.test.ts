import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { v3 } from '../../src/math/vec3';
import { ShipAssembly } from '../../src/game/ship/ship-assembly';
import { SHIP_MODULE_CATALOG } from '../../src/game/ship/ship-module-catalog';
import { createShipModuleInstance } from '../../src/game/ship/ship-module-instance';
import { repairDockedAssembly } from '../../src/game/ship/ship-repair';

function module(definitionId: string, id: string) {
  return createShipModuleInstance(SHIP_MODULE_CATALOG.require(definitionId), id);
}

function docked(): ShipAssembly {
  const host = new ShipAssembly(SHIP_MODULE_CATALOG, true);
  host.addRoot(module('cockpit-standard', 'cockpit'));
  host.append(module('dock-standard', 'dock'));
  const guest = new ShipAssembly(SHIP_MODULE_CATALOG, true);
  guest.addRoot(module('docking-port-standard', 'port'));
  guest.append(module('tank-3-main', 'tank'));
  return host.mergedAtDock(guest, 'dock', 'port', 'guest').assembly;
}

export function register(): void {
  test('ship repair: 健全な接続済み dock だけが全 module HP を即時回復する', () => {
    const assembly = docked();
    assembly.setHp('cockpit', 12);
    assembly.setHp('tank', 15);
    const fuelBefore = assembly.module('tank');
    assert.ok(fuelBefore?.kind === 'tank');
    const repaired = repairDockedAssembly(assembly, 'dock');
    assert.ok(repaired > 0);
    for (const module of assembly.modules) {
      assert.equal(module.hp, assembly.definition(module.id)!.maxHp);
    }
    const fuelAfter = assembly.module('tank');
    assert.ok(fuelAfter?.kind === 'tank');
    assert.equal(fuelAfter.fuel, fuelBefore.fuel);
  });

  test('ship repair: 空または全損した dock からは修理しない', () => {
    const empty = new ShipAssembly(SHIP_MODULE_CATALOG, true);
    empty.addRoot(module('cockpit-standard', 'cockpit'));
    empty.addModule(module('dock-standard', 'dock'), 'cockpit', { position: v3(0, 0, 2), rotation: { x: 0, y: 0, z: 0, w: 1 } });
    assert.throws(() => repairDockedAssembly(empty, 'dock'), /not connected/);
    const connected = docked();
    connected.setHp('dock', 0);
    assert.throws(() => repairDockedAssembly(connected, 'dock'), /destroyed/);
  });
}
