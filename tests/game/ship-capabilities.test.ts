import * as assert from 'node:assert/strict';
import { SHIP_MODULE_CATALOG } from '../../src/game/ship/ship-module-catalog';
import { createShipModuleInstance } from '../../src/game/ship/ship-module-instance';
import { createBasePreset, createDefaultCombatPreset } from '../../src/game/ship/ship-presets';
import { ShipCapabilities } from '../../src/game/ship/ship-capabilities';
import { test } from '../harness';

export function register(): void {
  test('ship capabilities: 最初の健全 cockpit を既定操作基準にし、手動選択を維持する', () => {
    const assembly = createDefaultCombatPreset();
    assembly.append(createShipModuleInstance(
      SHIP_MODULE_CATALOG.require('cockpit-standard'), 'cockpit-secondary',
    ));
    const capability = new ShipCapabilities(assembly);
    assert.equal(capability.operatingCockpitId, 'cockpit');
    assert.equal(capability.selectOperatingCockpit('cockpit-secondary'), true);
    assert.equal(capability.operatingCockpitId, 'cockpit-secondary');
    assembly.setHp('cockpit-secondary', 0);
    assert.equal(capability.operatingCockpitId, 'cockpit');
  });

  test('ship capabilities: cockpit 全損で操縦不能な物資へ変わる', () => {
    const assembly = createDefaultCombatPreset();
    const capability = new ShipCapabilities(assembly);
    assert.equal(capability.operatingCockpitId, 'cockpit');
    assert.equal(capability.controllable, true);
    assembly.setHp('cockpit', 0);
    assert.equal(capability.operatingCockpitId, null);
    assert.equal(capability.controllable, false);
    assert.equal(capability.role, 'material');
  });

  test('ship capabilities: 装備性能・燃料・展開操作を assembly から導出する', () => {
    const assembly = createBasePreset();
    const capability = new ShipCapabilities(assembly);
    assert.equal(capability.role, 'base');
    assert.equal(capability.fuel('main'), 160);
    assert.equal(capability.maxFuel('rcs'), 160);
    assert.equal(capability.totalPowerGeneration, 1_650);
    assert.equal(capability.totalCoolingRate, 9.6);
    assert.equal(capability.consumeFuel('main', 12), 12);
    assert.equal(capability.fuel('main'), 148);
    assert.equal(capability.toggleDeployable('radiator', 0), true);
    const radiator = capability.modules('radiator')[0];
    assert.ok(radiator !== undefined);
    assert.equal(radiator.deployed, 1);
  });
}
