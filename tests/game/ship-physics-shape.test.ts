import * as assert from 'node:assert/strict';
import { qFromAxisAngle, Q_IDENTITY } from '../../src/math/quat';
import { v3, dot, len, type Vec3 } from '../../src/math/vec3';
import { ShipAssembly } from '../../src/game/ship/ship-assembly';
import { ShipModuleCatalog } from '../../src/game/ship/ship-module-catalog';
import { defineShipModule } from '../../src/game/ship/ship-module-definition';
import { createShipModuleInstance } from '../../src/game/ship/ship-module-instance';
import { shipPhysicsShape } from '../../src/game/ship/ship-physics-shape';
import { test } from '../harness';

const MULTI_TANK = defineShipModule({
  id: 'test-multi-tank',
  kind: 'tank',
  name: 'test multi tank',
  length: 4,
  diameter: 2,
  dryMass: 10,
  maxHp: 100,
  modelId: 'test-multi-tank',
  solidPrimitives: [
    { center: v3(0, 0, -1), axis: v3(0, 0, 1), halfLength: 0.5, radius: 1 },
    { center: v3(0, 0, 1), axis: v3(0, 0, 1), halfLength: 0.5, radius: 1 },
  ],
  abilities: { fuelKind: 'main', fuelCapacity: 10, fuelMassPerUnit: 2 },
});

function multiCatalog(): ShipModuleCatalog {
  return new ShipModuleCatalog([MULTI_TANK]);
}

function multi(id: string, fuel = 0) {
  return createShipModuleInstance(MULTI_TANK, id, { fuel });
}

function close(actual: number, expected: number, message: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} !== ${expected}`);
}

function primitiveExtentFromCom(
  center: Vec3,
  axis: Vec3,
  halfLength: number,
  radius: number,
): number {
  const axial = dot(center, axis);
  const perpendicular = Math.sqrt(Math.max(0, len(center) ** 2 - axial ** 2));
  return Math.hypot(Math.abs(axial) + halfLength, perpendicular + radius);
}

export function register(): void {
  test('ship physics shape: empty assembly は null で、単一 module を COM 原点へ移す', () => {
    assert.equal(shipPhysicsShape(new ShipAssembly()), null);
    const assembly = new ShipAssembly(multiCatalog());
    assembly.addRoot(multi('tank', 5));
    const result = shipPhysicsShape(assembly)!;
    assert.equal(result.shape.primitives.length, 2);
    close(result.mass.totalMass, 20, 'total mass');
    close(result.centerOffset.x, 0, 'center offset x');
    close(result.centerOffset.y, 0, 'center offset y');
    close(result.centerOffset.z, 0, 'center offset z');
    for (const primitive of result.shape.primitives) {
      assert.ok(Number.isFinite(primitive.center.x)
        && Number.isFinite(primitive.center.y) && Number.isFinite(primitive.center.z));
    }
    assert.notStrictEqual(result.shape.primitives, MULTI_TANK.solidPrimitives);
    assert.equal(result.shape.primitives[0]!.moduleId, 'tank');
    assert.equal(result.shape.primitives[1]!.moduleId, 'tank');
  });

  test('ship physics shape: module transform と primitive transform を合成し、複数 primitive を保持する', () => {
    const assembly = new ShipAssembly(multiCatalog());
    assembly.addRoot(multi('root', 0));
    assembly.connectSide(multi('side', 0), 'root', {
      position: v3(10, 0, 0),
      rotation: qFromAxisAngle(v3(0, 1, 0), Math.PI / 2),
    });
    const result = shipPhysicsShape(assembly)!;
    close(result.mass.totalMass, 20, 'total mass');
    close(result.centerOffset.x, 5, 'center offset');
    assert.equal(result.shape.primitives.length, 4);
    const root = result.shape.primitives.filter(primitive => primitive.moduleId === 'root');
    const side = result.shape.primitives.filter(primitive => primitive.moduleId === 'side');
    assert.equal(root.length, 2);
    assert.equal(side.length, 2);
    close(root[0]!.center.x, -5, 'root first center');
    close(root[1]!.center.x, -5, 'root second center');
    close(side[0]!.center.x + side[1]!.center.x, 10, 'side center sum');
    assert.deepEqual(side.map(primitive => primitive.center.x).sort((a, b) => a - b), [4, 6]);
    for (const primitive of root) {
      close(primitive.axis.x, 0, 'root axis x');
      close(primitive.axis.z, 1, 'root axis z');
    }
    for (const primitive of side) {
      close(primitive.axis.x, 1, 'side axis x');
      close(primitive.axis.z, 0, 'side axis z');
    }
    for (const primitive of result.shape.primitives) {
      assert.ok(primitiveExtentFromCom(primitive.center, primitive.axis, primitive.halfLength, primitive.radius)
        <= result.mass.boundingRadius + 1e-9);
    }
  });

  test('ship physics shape: mass は燃料、追加撤去、split で同じ変換から再計算される', () => {
    const assembly = new ShipAssembly(multiCatalog());
    assembly.addRoot(multi('root', 5));
    const full = shipPhysicsShape(assembly)!;
    close(full.mass.totalMass, 20, 'full fuel mass');
    assert.equal(assembly.consumeFuel('main', 2), 2);
    const consumed = shipPhysicsShape(assembly)!;
    close(consumed.mass.totalMass, 16, 'consumed fuel mass');
    assert.equal(assembly.refuel('main', 1), 1);
    const refueled = shipPhysicsShape(assembly)!;
    close(refueled.mass.totalMass, 18, 'refueled mass');

    assembly.addModule(multi('tail', 0), 'root', { position: v3(0, 0, 4), rotation: Q_IDENTITY });
    const withTail = shipPhysicsShape(assembly)!;
    close(withTail.mass.totalMass, 28, 'added module mass');
    assert.ok(assembly.removeModule('tail') !== null);
    close(shipPhysicsShape(assembly)!.mass.totalMass, 18, 'removed module mass');

    const splitAssembly = new ShipAssembly(multiCatalog());
    splitAssembly.addRoot(multi('left', 1));
    splitAssembly.append(multi('right', 2));
    const before = shipPhysicsShape(splitAssembly)!.mass.totalMass;
    const [left, right] = splitAssembly.splitAt(splitAssembly.graph[0]!.id);
    close(shipPhysicsShape(left)!.mass.totalMass + shipPhysicsShape(right)!.mass.totalMass, before, 'split mass');
  });

  test('ship physics shape: module の追加順によらず同じ shape と質量を返す', () => {
    const first = new ShipAssembly(multiCatalog());
    first.addRoot(multi('root'));
    first.connectSide(multi('b'), 'root', { position: v3(0, 10, 0), rotation: Q_IDENTITY });
    first.connectSide(multi('a'), 'root', { position: v3(10, 0, 0), rotation: Q_IDENTITY });
    const second = new ShipAssembly(multiCatalog());
    second.addRoot(multi('root'));
    second.connectSide(multi('a'), 'root', { position: v3(10, 0, 0), rotation: Q_IDENTITY });
    second.connectSide(multi('b'), 'root', { position: v3(0, 10, 0), rotation: Q_IDENTITY });
    const firstShape = shipPhysicsShape(first)!;
    const secondShape = shipPhysicsShape(second)!;
    assert.deepEqual(firstShape.shape, secondShape.shape);
    assert.deepEqual(firstShape.mass, secondShape.mass);
    assert.deepEqual(firstShape.centerOffset, secondShape.centerOffset);
  });
}
