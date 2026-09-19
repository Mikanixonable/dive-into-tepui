import * as assert from 'node:assert/strict';
import {
  compoundCylinderCompoundContact, compoundCylinderCylinderContact, compoundCylinderRaycast,
  compoundCylinderSphereContact,
  sweptCompoundCylinderCompoundContact, sweptCompoundCylinderSphereContact,
  type CompoundCylinderShape, type RigidPose,
} from '../../src/physics/compound-cylinder-contact';
import type { CappedCylinder } from '../../src/physics/capped-cylinder-contact';
import { qFromAxisAngle, Q_IDENTITY } from '../../src/math/quat';
import { len, v3 } from '../../src/math/vec3';
import { test } from '../harness';

const IDENTITY: RigidPose = { position: v3(), rotation: Q_IDENTITY };
const SINGLE: CompoundCylinderShape = {
  primitives: [{ moduleId: 'body', center: v3(), axis: v3(0, 1, 0), halfLength: 1, radius: 0.5 }],
};

function close(actual: number, expected: number, epsilon = 1e-8): void {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
}

export function register(): void {
  test('compound-cylinder: sphere hit chooses deepest primitive and preserves module id', () => {
    const shape: CompoundCylinderShape = {
      primitives: [
        { moduleId: 'shallow', center: v3(0, 0, 0), axis: v3(0, 1, 0), halfLength: 1, radius: 0.5 },
        { moduleId: 'deep', center: v3(0.7, 0, 0), axis: v3(0, 1, 0), halfLength: 1, radius: 0.5 },
      ],
    };
    const hit = compoundCylinderSphereContact(shape, IDENTITY, v3(0.65, 0, 0), 0.2);
    assert.ok(hit);
    assert.equal(hit.moduleIdA, 'deep');
    assert.equal(hit.moduleIdB, null);
    close(hit.depth, 0.65);
  });

  test('compound-cylinder: compound hit checks all pairs and uses deterministic tie ids', () => {
    const a: CompoundCylinderShape = {
      primitives: [
        { moduleId: 'z', center: v3(0, 0, 0), axis: v3(0, 1, 0), halfLength: 1, radius: 0.5 },
        { moduleId: 'a', center: v3(0, 0, 0), axis: v3(0, 1, 0), halfLength: 1, radius: 0.5 },
      ],
    };
    const b: CompoundCylinderShape = {
      primitives: [{ moduleId: 'b', center: v3(0.9, 0, 0), axis: v3(0, 1, 0), halfLength: 1, radius: 0.5 }],
    };
    const first = compoundCylinderCompoundContact(a, IDENTITY, b, IDENTITY);
    const second = compoundCylinderCompoundContact({ primitives: [...a.primitives].reverse() }, IDENTITY, b, IDENTITY);
    assert.ok(first && second);
    assert.equal(first.moduleIdA, 'a');
    assert.deepEqual(first, second);
  });

  test('compound-cylinder: one module may own multiple solid primitives', () => {
    const shape: CompoundCylinderShape = {
      primitives: [
        { moduleId: 'module', center: v3(-2, 0, 0), axis: v3(0, 1, 0), halfLength: 1, radius: 0.5 },
        { moduleId: 'module', center: v3(2, 0, 0), axis: v3(0, 1, 0), halfLength: 1, radius: 0.5 },
      ],
    };
    const hit = compoundCylinderSphereContact(shape, IDENTITY, v3(2.6, 0, 0), 0.2);
    assert.ok(hit);
    assert.equal(hit.moduleIdA, 'module');
  });

  test('compound-cylinder: single capped-cylinder target returns both module ids', () => {
    const target: CappedCylinder = {
      center: v3(0.9, 0, 0), axis: v3(0, 1, 0), halfLength: 1, radius: 0.5,
    };
    const hit = compoundCylinderCylinderContact(SINGLE, IDENTITY, target, IDENTITY, 'target');
    assert.ok(hit);
    assert.equal(hit.moduleIdA, 'body');
    assert.equal(hit.moduleIdB, 'target');
    close(hit.depth, 0.1);
  });

  test('compound-cylinder: local-to-world transform and ray nearest module are consistent', () => {
    const pose: RigidPose = {
      position: v3(3, 0, 0), rotation: qFromAxisAngle(v3(0, 1, 0), Math.PI / 2),
    };
    const hit = compoundCylinderRaycast(SINGLE, pose, v3(0, 0, 0), v3(1, 0, 0));
    assert.ok(hit);
    assert.equal(hit.moduleId, 'body');
    close(hit.distance, 2.5);
    assert.ok(Number.isFinite(hit.point.x) && Number.isFinite(hit.normal.x));
    close(len(hit.normal), 1);
  });

  test('compound-cylinder: moving sphere through a long shape returns first TOI', () => {
    const shape: CompoundCylinderShape = {
      primitives: [{ moduleId: 'long', center: v3(), axis: v3(0, 1, 0), halfLength: 5, radius: 0.25 }],
    };
    const hit = sweptCompoundCylinderSphereContact(shape, IDENTITY, IDENTITY, v3(-3, 0, 0), v3(3, 0, 0), 0.25);
    assert.ok(hit);
    assert.equal(hit.moduleIdA, 'long');
    close(hit.toi, 2.5 / 6, 1e-6);
  });

  test('compound-cylinder: rotating pose is interpolated and can hit during the interval', () => {
    const shape: CompoundCylinderShape = {
      primitives: [{ moduleId: 'arm', center: v3(0, 4, 0), axis: v3(0, 1, 0), halfLength: 4, radius: 0.1 }],
    };
    const end: RigidPose = { position: v3(), rotation: qFromAxisAngle(v3(0, 0, 1), Math.PI) };
    const target: CompoundCylinderShape = {
      primitives: [{ moduleId: 'target', center: v3(-4, 0, 0), axis: v3(1, 0, 0), halfLength: 0.25, radius: 0.15 }],
    };
    const hit = sweptCompoundCylinderCompoundContact(shape, IDENTITY, end, target, IDENTITY, IDENTITY);
    assert.ok(hit);
    assert.ok(hit.toi > 0 && hit.toi < 1);
    assert.equal(hit.moduleIdA, 'arm');
    assert.equal(hit.moduleIdB, 'target');
  });

  test('compound-cylinder: empty, invalid and non-finite shapes are safe', () => {
    assert.equal(compoundCylinderSphereContact({ primitives: [] }, IDENTITY, v3(), 1), null);
    const primitive = SINGLE.primitives[0];
    assert.ok(primitive !== undefined);
    assert.equal(compoundCylinderSphereContact({ primitives: [{ ...primitive, radius: Number.NaN }] }, IDENTITY, v3(), 1), null);
    assert.equal(compoundCylinderRaycast(SINGLE, IDENTITY, v3(), v3()), null);
    assert.equal(sweptCompoundCylinderSphereContact(SINGLE, IDENTITY, IDENTITY, v3(Number.NaN, 0, 0), v3(), 1), null);
  });
}
