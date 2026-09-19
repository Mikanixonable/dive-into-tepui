import * as assert from 'node:assert/strict';
import { v3 } from '../../src/math/vec3';
import { SHIP_MODULE_CATALOG } from '../../src/game/ship/ship-module-catalog';
import { ShipAssembly } from '../../src/game/ship/ship-assembly';
import { createShipModuleInstance } from '../../src/game/ship/ship-module-instance';
import { test } from '../harness';

function instance(definitionId: string, id: string, state = {}) {
  return createShipModuleInstance(SHIP_MODULE_CATALOG.require(definitionId), id, state);
}

function damageTargets(seed: number): string | null {
  const assembly = new ShipAssembly();
  assembly.addRoot(instance('cockpit-standard', 'cockpit'));
  assembly.append(instance('armor-combat', 'armor'));
  assembly.append(instance('tank-3-main', 'tank'));
  return assembly.damage(1, seed);
}

export function register(): void {
  test('ship damage: 同じ seed は同じ健全 module を一様抽選する', () => {
    assert.equal(damageTargets(1234), damageTargets(1234));
    const seen = new Set<number>();
    for (let seed = 0; seed < 64; seed++) {
      const target = damageTargets(seed);
      if (target !== null) seen.add(['cockpit', 'armor', 'tank'].indexOf(target));
    }
    assert.ok(seen.size > 1);
  });

  test('ship damage: radiator 直撃は健全かつ展開中だけ固定軽減し、展開状態を変えない', () => {
    const assembly = new ShipAssembly();
    assembly.addRoot(instance('cockpit-standard', 'cockpit'));
    assembly.connectSide(instance('radiator-standard', 'radiator', { deployed: 0.8 }), 'cockpit', {
      position: v3(3.5, 0, 0),
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    });
    const before = assembly.module('radiator');
    assert.ok(before !== null);
    assert.equal(assembly.damage(20, 3, 'radiator'), 'radiator');
    const after = assembly.module('radiator');
    assert.ok(after !== null);
    assert.equal(after.kind, 'radiator');
    if (after.kind === 'radiator' && before.kind === 'radiator') {
      assert.equal(after.deployed, before.deployed);
      assert.equal(after.hp, 50 - 20 * 0.25);
    }
  });

  test('ship damage: 収納 radiator または全損 radiator の target は全体抽選へ戻る', () => {
    const assembly = new ShipAssembly();
    assembly.addRoot(instance('radiator-standard', 'radiator', { deployed: 0 }));
    assembly.append(instance('cockpit-standard', 'cockpit'));
    const target = assembly.damage(10, 1, 'radiator');
    assert.notEqual(target, 'radiator');
    const dead = new ShipAssembly();
    dead.addRoot(instance('radiator-standard', 'radiator', { deployed: 1, hp: 0 }));
    dead.append(instance('cockpit-standard', 'cockpit'));
    assert.equal(dead.damage(10, 1, 'radiator'), 'cockpit');
  });

  test('ship damage: damage は graph edge を壊さない', () => {
    const assembly = new ShipAssembly();
    assembly.addRoot(instance('cockpit-standard', 'cockpit'));
    assembly.append(instance('tank-3-main', 'tank'));
    const before = assembly.graph;
    assembly.damage(10_000, 42);
    assert.deepEqual(assembly.graph, before);
    assert.equal(assembly.size, 2);
  });
}
