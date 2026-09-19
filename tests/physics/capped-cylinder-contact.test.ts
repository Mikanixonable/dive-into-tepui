import * as assert from 'node:assert/strict';
import {
  cappedCylinderCylinderContact,
  cappedCylinderRaycast,
  cappedCylinderSphereContact,
  type CappedCylinder,
} from '../../src/physics/capped-cylinder-contact';
import { dot, len, v3, type Vec3 } from '../../src/math/vec3';
import { test } from '../harness';

const CYLINDER: CappedCylinder = {
  center: v3(), axis: v3(0, 2, 0), halfLength: 1, radius: 0.5,
};

function close(actual: number, expected: number, epsilon = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
}

function finiteHit(hit: { point: Vec3; normal: Vec3 }): void {
  assert.ok(Number.isFinite(hit.point.x) && Number.isFinite(hit.point.y) && Number.isFinite(hit.point.z));
  assert.ok(Number.isFinite(hit.normal.x) && Number.isFinite(hit.normal.y) && Number.isFinite(hit.normal.z));
  close(len(hit.normal), 1, 1e-8);
}

export function register(): void {
  test('capped cylinder: side sphere contact has radial normal and depth', () => {
    const hit = cappedCylinderSphereContact(CYLINDER, v3(0.65, 0, 0), 0.2);
    assert.ok(hit);
    close(hit.depth, 0.05);
    close(hit.point.x, 0.5);
    close(hit.normal.x, 1);
    close(hit.normal.y, 0);
    finiteHit(hit);
  });

  test('capped cylinder: flat cap sphere contact has axial normal', () => {
    const hit = cappedCylinderSphereContact(CYLINDER, v3(0, 1.15, 0), 0.2);
    assert.ok(hit);
    close(hit.depth, 0.05);
    close(hit.point.y, 1);
    close(hit.normal.y, 1);
    finiteHit(hit);
  });

  test('capped cylinder: a capsule-only cap gap is not a contact', () => {
    const hit = cappedCylinderSphereContact(CYLINDER, v3(0.65, 1.15, 0), 0.1);
    assert.equal(hit, null);
  });

  test('capped cylinder: a sphere started inside exits through its nearest surface', () => {
    const hit = cappedCylinderSphereContact(CYLINDER, v3(0, 0, 0), 0.1);
    assert.ok(hit);
    close(hit.depth, 0.6);
    close(dot(hit.normal, v3(0, 1, 0)), 0);
    finiteHit(hit);
  });

  test('capped cylinder: parallel cylinders use the exact cap or side overlap', () => {
    const side = cappedCylinderCylinderContact(CYLINDER, {
      ...CYLINDER, center: v3(0.8, 0, 0), axis: v3(0, -1, 0),
    });
    assert.ok(side);
    close(side.depth, 0.2);
    close(side.normal.x, 1);
    finiteHit(side);

    const cap = cappedCylinderCylinderContact(CYLINDER, { ...CYLINDER, center: v3(0, 1.8, 0) });
    assert.ok(cap);
    close(cap.depth, 0.2);
    close(cap.normal.y, 1);
    finiteHit(cap);

    const sideTouch = cappedCylinderCylinderContact(CYLINDER, { ...CYLINDER, center: v3(1, 0, 0) });
    assert.ok(sideTouch);
    close(sideTouch.depth, 0);
    const capTouch = cappedCylinderCylinderContact(CYLINDER, { ...CYLINDER, center: v3(0, 2, 0) });
    assert.ok(capTouch);
    close(capTouch.depth, 0);
  });

  test('capped cylinder: crossed cylinders contact without a capsule gap false positive', () => {
    const hit = cappedCylinderCylinderContact(CYLINDER, {
      center: v3(0.65, 0.8, 0), axis: v3(1, 0, 0), halfLength: 0.5, radius: 0.2,
    });
    assert.ok(hit);
    assert.ok(hit.depth > 0);
    finiteHit(hit);

    const gap = cappedCylinderCylinderContact(CYLINDER, {
      center: v3(0.8, 1.8, 0), axis: v3(1, 0, 0), halfLength: 0.5, radius: 0.1,
    });
    assert.equal(gap, null);
  });

  test('capped cylinder: ray returns nearest side, cap, and interior exit', () => {
    const side = cappedCylinderRaycast(CYLINDER, v3(-2, 0, 0), v3(2, 0, 0));
    assert.ok(side);
    close(side.distance, 1.5);
    close(side.point.x, -0.5);
    close(side.normal.x, -1);
    finiteHit(side);

    const negativeHalf = cappedCylinderRaycast(CYLINDER, v3(-2, -0.75, 0), v3(1, 0, 0));
    assert.ok(negativeHalf);
    close(negativeHalf.distance, 1.5);
    close(negativeHalf.point.y, -0.75);
    close(negativeHalf.normal.x, -1);
    finiteHit(negativeHalf);

    const cap = cappedCylinderRaycast(CYLINDER, v3(0, 3, 0), v3(0, -1, 0));
    assert.ok(cap);
    close(cap.distance, 2);
    close(cap.point.y, 1);
    close(cap.normal.y, 1);
    finiteHit(cap);

    const inside = cappedCylinderRaycast(CYLINDER, v3(0, 0, 0), v3(0, 1, 0));
    assert.ok(inside);
    close(inside.distance, 1);
    close(inside.point.y, 1);
    close(inside.normal.y, 1);
    finiteHit(inside);
  });

  test('capped cylinder: GJK/EPA results are deterministic for concentric, crossed, and nearly parallel cases', () => {
    const cases: readonly [CappedCylinder, CappedCylinder][] = [
      [CYLINDER, { ...CYLINDER, axis: v3(1, 0, 0), halfLength: 0.5, radius: 0.2 }],
      [CYLINDER, { center: v3(0.65, 0.8, 0), axis: v3(1, 0, 0), halfLength: 0.5, radius: 0.2 }],
      [CYLINDER, { center: v3(0.01, 0, 0), axis: v3(0, 1, 0.1), halfLength: 1, radius: 0.5 }],
    ];
    for (const [a, b] of cases) {
      const first = cappedCylinderCylinderContact(a, b);
      const second = cappedCylinderCylinderContact(a, b);
      assert.ok(first);
      assert.deepEqual(second, first);
      finiteHit(first);
    }
  });

  test('capped cylinder: degenerate and non-finite inputs return no non-finite hit', () => {
    assert.equal(cappedCylinderSphereContact({ ...CYLINDER, axis: v3() }, v3(), 1), null);
    assert.equal(cappedCylinderCylinderContact({ ...CYLINDER, radius: Number.NaN }, CYLINDER), null);
    assert.equal(cappedCylinderRaycast(CYLINDER, v3(), v3()), null);
    assert.equal(cappedCylinderRaycast(CYLINDER, v3(Number.POSITIVE_INFINITY, 0, 0), v3(1, 0, 0)), null);
  });
}
