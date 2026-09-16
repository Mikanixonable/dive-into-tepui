import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { shipMassProperties, type ShipMassElement } from '../../src/physics/ship-mass-properties';
import { v3 } from '../../src/math/vec3';

function element(id: string, overrides: Partial<ShipMassElement> = {}): ShipMassElement {
  return {
    moduleId: id,
    center: v3(),
    axis: v3(0, 1, 0),
    halfLength: 2,
    radius: 1,
    dryMass: 3,
    resourceMass: 2,
    ...overrides,
  };
}

export function register(): void {
  test('ship-mass-properties: 単一円柱の質量、重心、対角慣性、半径を解析値と一致させる', () => {
    const result = shipMassProperties([element('single')]);
    assert.equal(result.totalMass, 5);
    assert.deepEqual(result.centerOfMass, v3());
    // I_parallel = 1/2 mr² = 2.5, I_transverse = m(r²/4+h²/3) = 95/12。
    assert.ok(Math.abs(result.inertia.x - 95 / 12) < 1e-12);
    assert.ok(Math.abs(result.inertia.y - 2.5) < 1e-12);
    assert.ok(Math.abs(result.inertia.z - 95 / 12) < 1e-12);
    assert.ok(Math.abs(result.boundingRadius - Math.sqrt(5)) < 1e-12);
  });

  test('ship-mass-properties: 任意方向の軸を対角慣性へ射影する', () => {
    const result = shipMassProperties([element('diagonal', {
      axis: v3(1, 1, 0), halfLength: 1, radius: 1, dryMass: 2, resourceMass: 0,
    })]);
    const transverse = 2 * (1 / 4 + 1 / 3);
    const axial = 1;
    const projected = transverse + (axial - transverse) / 2;
    assert.ok(Math.abs(result.inertia.x - projected) < 1e-12);
    assert.ok(Math.abs(result.inertia.y - projected) < 1e-12);
    assert.ok(Math.abs(result.inertia.z - transverse) < 1e-12);
  });

  test('ship-mass-properties: 平行移動で重心も移り、平行軸の定理を加える', () => {
    const origin = element('origin', { halfLength: 1, radius: 0.5, dryMass: 2, resourceMass: 0 });
    const offset = element('offset', {
      center: v3(0, 3, 0), halfLength: 1, radius: 0.5, dryMass: 2, resourceMass: 0,
    });
    const result = shipMassProperties([origin, offset]);
    assert.deepEqual(result.centerOfMass, v3(0, 1.5, 0));
    const transverse = 2 * (0.5 * 0.5 / 4 + 1 / 3);
    assert.ok(Math.abs(result.inertia.x - (2 * transverse + 9)) < 1e-12);
    assert.ok(Math.abs(result.inertia.y - 2 * 2 * 0.5 * 0.5 / 2) < 1e-12);
    assert.ok(Math.abs(result.inertia.z - (2 * transverse + 9)) < 1e-12);
    assert.ok(Math.abs(result.boundingRadius - Math.sqrt(6.5)) < 1e-12);
  });

  test('ship-mass-properties: module 順序によらず質量特性が決定的', () => {
    const a = element('a', { center: v3(-3, 0, 0), dryMass: 4, resourceMass: 1 });
    const b = element('b', { center: v3(4, 1, 0), dryMass: 2, resourceMass: 3, axis: v3(1, 2, 3) });
    const c = element('c', { center: v3(0, -2, 1), dryMass: 1, resourceMass: 0 });
    assert.deepEqual(shipMassProperties([a, b, c]), shipMassProperties([c, a, b]));
  });

  test('ship-mass-properties: 燃料変化と分割で質量保存し、出力は有限', () => {
    const left = element('left', { center: v3(-2, 0, 0), dryMass: 4, resourceMass: 6 });
    const right = element('right', { center: v3(2, 0, 0), dryMass: 3, resourceMass: 5 });
    const assembly = shipMassProperties([left, right]);
    const splitMass = shipMassProperties([left]).totalMass + shipMassProperties([right]).totalMass;
    assert.equal(assembly.totalMass, splitMass);
    const fuelSpent = shipMassProperties([
      { ...left, resourceMass: 1 }, { ...right, resourceMass: 0 },
    ]);
    assert.equal(fuelSpent.totalMass, assembly.totalMass - 10);
    assert.ok(Object.values(fuelSpent.inertia).every(Number.isFinite));
    assert.ok(Number.isFinite(fuelSpent.boundingRadius));
  });

  test('ship-mass-properties: 空、零、負、非有限、重複 id は明示的に拒否する', () => {
    assert.throws(() => shipMassProperties([]), /must not be empty/);
    assert.throws(() => shipMassProperties([element('zero', { radius: 0 })]), /radius must be positive/);
    assert.throws(() => shipMassProperties([element('negative', { resourceMass: -1 })]), /must be finite and positive/);
    assert.throws(() => shipMassProperties([element('nan', { center: v3(Number.NaN, 0, 0) })]), /center must be finite/);
    assert.throws(() => shipMassProperties([element('duplicate'), element('duplicate')]), /unique and non-empty/);
  });
}
