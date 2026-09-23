import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { advectSphericalPositionUnitVector } from '../../src/physics/cloud-spherical-transport';
import { v3 } from '../../src/math/vec3';
import type { Vec3 } from '../../src/math/vec3';

function distance(left: Vec3, right: Vec3): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

export function register(): void {
  test('cloud spherical transport: constant tangent wind follows the analytic great circle', () => {
    const radiusM = 6_371_000;
    const eastwardTangentMPerS = v3(0, 250, 0);
    const elapsedTimeS = Math.PI * radiusM / (2 * 250);
    const destination = advectSphericalPositionUnitVector(
      v3(1, 0, 0),
      eastwardTangentMPerS,
      radiusM,
      elapsedTimeS,
    );
    assert.ok(distance(destination, v3(0, 1, 0)) < 2e-15);
    assert.ok(Math.abs(Math.hypot(destination.x, destination.y, destination.z) - 1) < 1e-15);
  });

  test('cloud spherical transport: reverse elapsed time returns to the same point', () => {
    const initial = v3(0.2, 0.3, Math.sqrt(0.87));
    const tangent = v3(4, -2, 0);
    const radial = initial.x * tangent.x + initial.y * tangent.y + initial.z * tangent.z;
    const projected = v3(
      tangent.x - radial * initial.x,
      tangent.y - radial * initial.y,
      tangent.z - radial * initial.z,
    );
    const speedMPerS = Math.hypot(projected.x, projected.y, projected.z);
    const tangentUnit = v3(projected.x / speedMPerS, projected.y / speedMPerS, projected.z / speedMPerS);
    const angleRad = speedMPerS * 7200 / 1000;
    const destination = advectSphericalPositionUnitVector(initial, projected, 1000, 7200);
    const reverseVelocity = v3(
      speedMPerS * (-initial.x * Math.sin(angleRad) + tangentUnit.x * Math.cos(angleRad)),
      speedMPerS * (-initial.y * Math.sin(angleRad) + tangentUnit.y * Math.cos(angleRad)),
      speedMPerS * (-initial.z * Math.sin(angleRad) + tangentUnit.z * Math.cos(angleRad)),
    );
    const returned = advectSphericalPositionUnitVector(destination, reverseVelocity, 1000, -7200);
    assert.ok(distance(returned, initial) < 1e-12);
  });

  test('cloud spherical transport: zero wind and zero duration preserve normalized position', () => {
    assert.deepEqual(
      advectSphericalPositionUnitVector(v3(2, 0, 0), v3(0, 0, 0), 1, 50),
      v3(1, 0, 0),
    );
    assert.deepEqual(
      advectSphericalPositionUnitVector(v3(0, 2, 0), v3(0, 0, 1), 1, 0),
      v3(0, 1, 0),
    );
  });

  test('cloud spherical transport: rejects radial velocity and invalid radius', () => {
    assert.throws(() => advectSphericalPositionUnitVector(v3(1, 0, 0), v3(1, 0, 0), 1, 1), RangeError);
    assert.throws(() => advectSphericalPositionUnitVector(v3(1, 0, 0), v3(0, 1, 0), 0, 1), RangeError);
    assert.throws(() => advectSphericalPositionUnitVector(v3(0, 0, 0), v3(0, 1, 0), 1, 1), RangeError);
  });
}
