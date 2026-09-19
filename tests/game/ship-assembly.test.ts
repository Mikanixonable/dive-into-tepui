import * as assert from 'node:assert/strict';
import { qFromUnitVectors, qRotate, LOCAL_FORWARD } from '../../src/math/quat';
import { add, scale, v3 } from '../../src/math/vec3';
import { SHIP_MODULE_CATALOG } from '../../src/game/ship/ship-module-catalog';
import { ShipAssembly } from '../../src/game/ship/ship-assembly';
import { createShipModuleInstance } from '../../src/game/ship/ship-module-instance';
import { createBasePreset, createDefaultCombatPreset } from '../../src/game/ship/ship-presets';
import { test } from '../harness';

function module(definitionId: string, id: string, state = {}) {
  return createShipModuleInstance(SHIP_MODULE_CATALOG.require(definitionId), id, state);
}

export function register(): void {
  test('ship assembly: 既定戦闘船は既存の HP と性能、質量を保つ', () => {
    const assembly = createDefaultCombatPreset();
    const totals = assembly.totals();
    assert.equal(assembly.role, 'ship');
    assert.equal(totals.hp, 1_000);
    assert.equal(totals.maxHp, 1_000);
    assert.equal(totals.thrust, 400_000);
    assert.equal(totals.torque, 2.24);
    assert.equal(totals.power, 100);
    assert.equal(totals.radiation, 84);
    assert.equal(totals.weaponDamage, 1);
    assert.equal(totals.fireRate, 1 / 0.06);
    assert.equal(totals.muzzleVelocity, 1_000);
    assert.equal(totals.mainFuel, 1_000);
    assert.equal(totals.mass, 1_000);
    assert.equal(totals.dryMass, 400);
    assert.equal(assembly.validate().valid, true);
  });

  test('ship assembly: +Z append は端面を隙間なく接続する', () => {
    const assembly = new ShipAssembly();
    assembly.addRoot(module('cockpit-standard', 'root'));
    assembly.append(module('tank-12-main', 'tank'));
    const edge = assembly.graph[0];
    assert.ok(edge !== undefined);
    assert.equal(edge.kind, 'axial');
    assert.equal(edge.childTransform.position.x, 0);
    assert.equal(edge.childTransform.position.y, 0);
    assert.equal(edge.childTransform.position.z, 7.5);
    const tankTransform = assembly.worldTransformOf('tank');
    assert.ok(tankTransform !== null);
    assert.equal(tankTransform.position.z, 7.5);
    assert.equal(assembly.validate().valid, true);
  });

  test('ship assembly: 側面接続は明示 transform を保持する', () => {
    const assembly = new ShipAssembly();
    assembly.addRoot(module('cockpit-standard', 'root'));
    const transform = { position: v3(0, 3.5, 0), rotation: qFromUnitVectors(LOCAL_FORWARD, v3(0, 1, 0)) };
    assembly.connectSide(module('dock-standard', 'dock'), 'root', transform, 'side-edge');
    assert.deepEqual(assembly.transformOf('dock'), transform);
    const sideEdge = assembly.graph[0];
    assert.ok(sideEdge !== undefined);
    assert.equal(sideEdge.id, 'side-edge');
  });

  test('ship assembly: docking edge は接舷面を一致させ、重複IDを安定名へ写す', () => {
    const host = new ShipAssembly(SHIP_MODULE_CATALOG, true);
    host.addRoot(module('cockpit-standard', 'cockpit'));
    host.append(module('dock-standard', 'dock'));
    const guest = new ShipAssembly(SHIP_MODULE_CATALOG, true);
    guest.addRoot(module('docking-port-standard', 'port'));
    guest.append(module('cockpit-standard', 'cockpit'));
    const merged = host.mergedAtDock(guest, 'dock', 'port', 'guest');
    assert.equal(merged.moduleIds.get('cockpit'), 'guest:cockpit');
    assert.equal(merged.assembly.validate().valid, true);
    assert.equal(merged.assembly.graph.find(edge => edge.id === merged.connectionId)?.kind, 'docking');
    const hostTransform = merged.assembly.worldTransformOf('dock');
    const guestTransform = merged.assembly.worldTransformOf('port');
    assert.ok(hostTransform !== null && guestTransform !== null);
    const hostPoint = add(hostTransform.position, scale(qRotate(hostTransform.rotation, LOCAL_FORWARD), 0.5));
    const guestPoint = add(guestTransform.position, scale(qRotate(guestTransform.rotation, LOCAL_FORWARD), 0.5));
    assert.ok(Math.hypot(
      hostPoint.x - guestPoint.x, hostPoint.y - guestPoint.y, hostPoint.z - guestPoint.z,
    ) < 1e-9);
    const [retained, detached] = merged.assembly.splitAt(merged.connectionId);
    assert.ok(retained.module('dock'));
    assert.ok(detached.module('port'));
    assert.equal(retained.isDockingPortOccupied('dock'), false);
    assert.equal(detached.isDockingPortOccupied('port'), false);
  });

  test('ship assembly: role は健全 cockpit と dock だけから導出し booster では変わらない', () => {
    const assembly = new ShipAssembly();
    assembly.addRoot(module('booster-standard', 'booster'));
    assert.equal(assembly.role, 'material');
    assembly.append(module('cockpit-standard', 'cockpit'));
    assert.equal(assembly.role, 'ship');
    assembly.connectSide(module('dock-standard', 'dock'), 'cockpit', { position: v3(3.5, 0, 0), rotation: qFromUnitVectors(LOCAL_FORWARD, v3(1, 0, 0)) });
    assert.equal(assembly.role, 'base');
    assembly.damage(200, 1, 'cockpit');
    assert.equal(assembly.role, 'material');
  });

  test('ship assembly: clone は module state を共有せず split は元を消費する', () => {
    const assembly = new ShipAssembly();
    assembly.addRoot(module('cockpit-standard', 'a'));
    assembly.append(module('tank-3-main', 'b', { fuel: 10 }));
    assembly.append(module('thruster-standard', 'c'));
    const clone = assembly.clone();
    clone.damage(10, 1, 'a');
    const moduleA = assembly.module('a');
    const splitEdge = assembly.graph[1];
    assert.ok(moduleA !== null && splitEdge !== undefined);
    assert.equal(moduleA.hp, 100);
    const [left, right] = assembly.splitAt(splitEdge.id);
    assert.deepEqual(left.moduleIds, ['a', 'b']);
    assert.deepEqual(right.moduleIds, ['c']);
    assert.equal(assembly.size, 0);
    const leftTank = left.module('b');
    assert.ok(leftTank !== null);
    assert.equal(leftTank.kind, 'tank');
    assert.equal(right.validate().valid, true);
  });

  test('ship assembly: base preset は必要な側面 dock 2個を持つ', () => {
    const assembly = createBasePreset();
    assert.equal(assembly.role, 'base');
    assert.equal(assembly.modules.filter(module => module.kind === 'dock').length, 2);
    assert.equal(assembly.modules.filter(module => module.kind === 'tank').length, 2);
    assert.equal(assembly.modules.filter(module => module.kind === 'solar_panel').length, 2);
    assert.equal(assembly.modules.filter(module => module.kind === 'radiator').length, 2);
    assert.equal(assembly.validate().valid, true);
  });

  test('ship assembly: 取り出した modules は内部 state を変更しない', () => {
    const assembly = new ShipAssembly();
    assembly.addRoot(module('cockpit-standard', 'cockpit'));
    const listed = assembly.modules;
    const listedCockpit = listed[0];
    const cockpit = assembly.module('cockpit');
    assert.ok(listedCockpit !== undefined && cockpit !== null);
    listedCockpit.hp = 0;
    assert.equal(cockpit.hp, 100);
  });

  test('ship assembly: 可変 state は狭い所有 API から更新する', () => {
    const assembly = new ShipAssembly();
    assembly.addRoot(module('tank-3-main', 'tank', { fuel: 10 }));
    assembly.append(module('booster-standard', 'booster', { fuel: 2 }));
    assembly.append(module('radiator-standard', 'radiator'));
    assembly.setIgnited('booster', true);
    assert.equal(assembly.consumeFuel('main', 3), 3);
    const boosterBefore = assembly.module('booster');
    assert.ok(boosterBefore !== null);
    assert.equal(boosterBefore.kind === 'booster' && boosterBefore.fuel, 2);
    assert.equal(assembly.consumeBoosterFuel('booster', 1), 1);
    const booster = assembly.module('booster');
    assert.ok(booster !== null);
    assert.equal(booster.kind, 'booster');
    assembly.setDeployment('radiator', 0.4);
    assembly.setTemperature('radiator', 500);
    const radiator = assembly.module('radiator');
    assert.ok(radiator !== null);
    assert.equal(radiator.temperature, 500);
    assert.equal(radiator.kind, 'radiator');
  });
}
