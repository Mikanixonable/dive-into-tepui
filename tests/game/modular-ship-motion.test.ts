import * as assert from 'node:assert/strict';
import { Q_IDENTITY, qRotate } from '../../src/math/quat';
import { sub, v3 } from '../../src/math/vec3';
import type { Attitude } from '../../src/physics/attitude';
import { kinematicState } from '../../src/physics/kinematic-state';
import { ShipAssembly } from '../../src/game/ship/ship-assembly';
import { SHIP_MODULE_CATALOG } from '../../src/game/ship/ship-module-catalog';
import { createShipModuleInstance } from '../../src/game/ship/ship-module-instance';
import { ModularShipMotion } from '../../src/game/ship/modular-ship-motion';
import { createDefaultCombatPreset } from '../../src/game/ship/ship-presets';
import { test } from '../harness';

function module(definitionId: string, id: string) {
  return createShipModuleInstance(SHIP_MODULE_CATALOG.require(definitionId), id);
}

function assembly(): ShipAssembly {
  const result = new ShipAssembly(SHIP_MODULE_CATALOG, true);
  result.addRoot(module('cockpit-standard', 'cockpit'));
  result.append(module('tank-3-main', 'tank'));
  return result;
}

function attitude(w = v3()): Attitude {
  return { q: Q_IDENTITY, w, inertia: v3(1, 1, 1) };
}

export function register(): void {
  test('modular ship motion: assembly から質量・慣性・半径・compound を同じ世代で初期化する', () => {
    const ship = assembly();
    const motion = new ModularShipMotion(
      ship, kinematicState<'eci'>(0, v3(10, 20, 30), v3()), attitude(),
    );
    assert.equal(motion.mass, ship.totalMass);
    assert.equal(motion.radius, motion.physicsShape.mass.boundingRadius);
    assert.deepEqual(motion.att.inertia, motion.physicsShape.mass.inertia);
    assert.ok(motion.compoundShape !== null);
    const expectedPrimitiveCount = ship.modules.reduce(
      (count, item) => count + ship.definition(item.id)!.solidPrimitives.length, 0,
    );
    assert.equal(motion.compoundShape.primitives.length, expectedPrimitiveCount);
    assert.equal(motion.shapeRevision, 1);
  });

  test('modular ship motion: 燃料で COM が動いても assembly 原点の world 位置を保つ', () => {
    const ship = assembly();
    const motion = new ModularShipMotion(
      ship, kinematicState<'eci'>(0, v3(100, 200, 300), v3()), attitude(),
    );
    const originBefore = sub(motion.state.r, qRotate(motion.att.q, motion.centerOffset));
    ship.consumeFuel('main', 80);
    motion.synchronizeAssembly();
    const originAfter = sub(motion.state.r, qRotate(motion.att.q, motion.centerOffset));
    assert.ok(Math.abs(originAfter.x - originBefore.x) < 1e-9);
    assert.ok(Math.abs(originAfter.y - originBefore.y) < 1e-9);
    assert.ok(Math.abs(originAfter.z - originBefore.z) < 1e-9);
    assert.equal(motion.mass, ship.totalMass);
    assert.equal(motion.shapeRevision, 2);
  });

  test('modular ship motion: 物性再計算で COM 点の速度と対角角運動量を連続にする', () => {
    const ship = assembly();
    const motion = new ModularShipMotion(
      ship, kinematicState<'eci'>(0, v3(), v3(7, 8, 9)), attitude(v3(0.2, -0.3, 0.4)),
    );
    const oldInertia = motion.att.inertia;
    const oldW = motion.att.w;
    const oldVelocity = motion.state.v;
    const oldCenter = motion.centerOffset;
    ship.consumeFuel('main', 80);
    motion.synchronizeAssembly();
    const newInertia = motion.att.inertia;
    assert.ok(Math.abs(oldInertia.x * oldW.x - newInertia.x * motion.att.w.x) < 1e-9);
    assert.ok(Math.abs(oldInertia.y * oldW.y - newInertia.y * motion.att.w.y) < 1e-9);
    assert.ok(Math.abs(oldInertia.z * oldW.z - newInertia.z * motion.att.w.z) < 1e-9);
    const delta = sub(motion.centerOffset, oldCenter);
    const expectedVelocityDelta = qRotate(motion.att.q, v3(
      oldW.y * delta.z - oldW.z * delta.y,
      oldW.z * delta.x - oldW.x * delta.z,
      oldW.x * delta.y - oldW.y * delta.x,
    ));
    assert.ok(Math.abs(motion.state.v.x - oldVelocity.x - expectedVelocityDelta.x) < 1e-9);
    assert.ok(Math.abs(motion.state.v.y - oldVelocity.y - expectedVelocityDelta.y) < 1e-9);
    assert.ok(Math.abs(motion.state.v.z - oldVelocity.z - expectedVelocityDelta.z) < 1e-9);
  });

  test('modular ship motion: 給弾ベルトは weapon module の semantic anchor から始まる', () => {
    const ship = createDefaultCombatPreset();
    const motion = new ModularShipMotion(ship, kinematicState<'eci'>(0, v3(), v3()), attitude());
    const transform = ship.worldTransformOf('weapon');
    const definition = ship.definition('weapon');
    assert.ok(transform !== null && definition !== null);
    const localAnchor = definition.feedPort;
    const assemblyAnchor = qRotate(transform.rotation, localAnchor);
    const expected = v3(
      transform.position.x + assemblyAnchor.x - motion.centerOffset.x,
      transform.position.y + assemblyAnchor.y - motion.centerOffset.y,
      transform.position.z + assemblyAnchor.z - motion.centerOffset.z,
    );
    assert.ok(Math.abs(motion.belt.anchor.x - expected.x) < 1e-9);
    assert.ok(Math.abs(motion.belt.anchor.y - expected.y) < 1e-9);
    assert.ok(Math.abs(motion.belt.anchor.z - expected.z) < 1e-9);
  });
}
