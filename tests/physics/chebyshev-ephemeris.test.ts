import * as assert from 'node:assert/strict';
import { test } from './harness';
import {
  ChebyshevBodyNotFoundError,
  ChebyshevEphemeris,
  ChebyshevTimeOutOfRangeError,
  evaluateChebyshevWithDerivative,
  findChebyshevSegmentIndex,
} from '../../src/physics/ephemeris-pack/evaluator';
import { ChebyshevEphemerisPack } from '../../src/physics/ephemeris-pack/types';
import { len, Vec3, v3 } from '../../src/math/vec3';

function assertVec3Close(actual: Vec3, expected: Vec3, tolerance = 1e-12): void {
  assert.ok(Math.abs(actual.x - expected.x) <= tolerance, `x: ${actual.x} vs ${expected.x}`);
  assert.ok(Math.abs(actual.y - expected.y) <= tolerance, `y: ${actual.y} vs ${expected.y}`);
  assert.ok(Math.abs(actual.z - expected.z) <= tolerance, `z: ${actual.z} vs ${expected.z}`);
}

const pack: ChebyshevEphemerisPack = {
  manifest: {
    version: 1,
    timeUnit: 's',
    positionUnit: 'm',
    coordinateFrame: 'ICRF-J2000',
    timeScale: 'TDB',
    bodies: [{
      id: 'probe',
      segments: [
        { start: 0, end: 10, degree: 2 },
        { start: 10, end: 20, degree: 0 },
      ],
    }],
  },
  bodies: [{
    id: 'probe',
    segments: [
      {
        start: 0,
        end: 10,
        // x=(t-5)/5: 10, 2+3x, and 4x² = 2T0 + 2T2.
        coefficients: [[10, 0, 0], [2, 3, 0], [2, 0, 2]],
      },
      { start: 10, end: 20, coefficients: [[30], [40], [50]] },
    ],
  }],
};

export function register(): void {
  test('chebyshev: exact value and analytic derivative for constant, linear, and quadratic series', () => {
    assert.deepEqual(evaluateChebyshevWithDerivative([7], -1), { value: 7, derivative: 0 });
    assert.deepEqual(evaluateChebyshevWithDerivative([7], 0.25), { value: 7, derivative: 0 });
    assert.deepEqual(evaluateChebyshevWithDerivative([2, 3], -0.5), { value: 0.5, derivative: 3 });
    assert.deepEqual(evaluateChebyshevWithDerivative([2, 3], 0.75), { value: 4.25, derivative: 3 });
    assert.deepEqual(evaluateChebyshevWithDerivative([2, 0, 2], -0.5), { value: 1, derivative: -4 });
    assert.deepEqual(evaluateChebyshevWithDerivative([2, 0, 2], 0.75), { value: 2.25, derivative: 6 });
  });

  test('chebyshev: evaluates SI position and interval-scaled velocity as KinematicState', () => {
    const eph = new ChebyshevEphemeris(pack);
    const state = eph.stateOf('probe', 2.5);
    assertVec3Close(state.r, v3(10, 0.5, 1));
    assertVec3Close(state.v, v3(0, 0.6, -0.8));
    assert.equal(state.t, 2.5);
    assert.ok(len(eph.positionOf('probe', 2.5)) > 0);
  });

  test('chebyshev: indexed segment lookup handles both boundaries deterministically', () => {
    assert.equal(findChebyshevSegmentIndex(pack.bodies[0]!.segments, 0), 0);
    assert.equal(findChebyshevSegmentIndex(pack.bodies[0]!.segments, 10), 1);
    assert.equal(findChebyshevSegmentIndex(pack.bodies[0]!.segments, 20), 1);
    assert.equal(new ChebyshevEphemeris(pack).evaluate('probe', 10).segmentIndex, 1);
  });

  test('chebyshev: missing bodies and times outside validity are explicit errors', () => {
    const eph = new ChebyshevEphemeris(pack);
    assert.throws(() => eph.stateOf('missing', 1), ChebyshevBodyNotFoundError);
    assert.throws(() => eph.stateOf('probe', -1), ChebyshevTimeOutOfRangeError);
    assert.throws(() => eph.stateOf('probe', 21), ChebyshevTimeOutOfRangeError);
  });

  test('chebyshev: repeated calls are deterministic and input coefficients are snapshotted', () => {
    const coefficients = [3, 4];
    const input: ChebyshevEphemerisPack = {
      manifest: {
        version: 1,
        timeUnit: 's',
        positionUnit: 'm',
        bodies: [{ id: 'fixed', segments: [{ start: 0, end: 2, degree: 1 }] }],
      },
      bodies: [{ id: 'fixed', segments: [{ start: 0, end: 2, coefficients: [coefficients, [0, 0], [0, 0]] }] }],
    };
    const eph = new ChebyshevEphemeris(input);
    const first = eph.stateOf('fixed', 1);
    coefficients[0] = 999;
    const second = eph.stateOf('fixed', 1);
    assert.deepEqual(second, first);
    assert.deepEqual(eph.stateOf('fixed', 1), second);
  });
}
