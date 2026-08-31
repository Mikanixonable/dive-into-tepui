import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  ChebyshevBodyNotFoundError,
  ChebyshevEphemeris,
  ChebyshevTimeOutOfRangeError,
  evaluateChebyshevWithDerivative,
  findChebyshevSegmentIndex,
} from '../../src/physics/ephemeris-pack/evaluator';
import { ChebyshevPack } from '../../src/physics/ephemeris-pack/types';
import { len, Vec3, v3 } from '../../src/math/vec3';

function assertVec3Close(actual: Vec3, expected: Vec3, tolerance = 1e-12): void {
  assert.ok(Math.abs(actual.x - expected.x) <= tolerance, `x: ${actual.x} vs ${expected.x}`);
  assert.ok(Math.abs(actual.y - expected.y) <= tolerance, `y: ${actual.y} vs ${expected.y}`);
  assert.ok(Math.abs(actual.z - expected.z) <= tolerance, `z: ${actual.z} vs ${expected.z}`);
}

const pack: ChebyshevPack = {
  manifest: {
    version: 1,
    timeUnit: 's',
    positionUnit: 'm',
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
    const state = eph.icrfStateAt('probe', 2.5);
    assertVec3Close(state.r, v3(10, 0.5, 1));
    assertVec3Close(state.v, v3(0, 0.6, -0.8));
    assert.equal(state.t, 2.5);
    assert.ok(len(state.r) > 0);
  });

  test('chebyshev: indexed segment lookup handles both boundaries deterministically', () => {
    assert.equal(findChebyshevSegmentIndex(pack.bodies[0]!.segments, 0), 0);
    assert.equal(findChebyshevSegmentIndex(pack.bodies[0]!.segments, 10), 1);
    assert.equal(findChebyshevSegmentIndex(pack.bodies[0]!.segments, 20), 1);
    // t=10 は2つめのセグメント(定数係数 [[30],[40],[50]])が担う。値で選択を押さえる。
    assertVec3Close(new ChebyshevEphemeris(pack).icrfStateAt('probe', 10).r, v3(30, 40, 50));
  });

  test('chebyshev: missing bodies and times outside validity are explicit errors', () => {
    const eph = new ChebyshevEphemeris(pack);
    assert.throws(() => eph.icrfStateAt('missing', 1), ChebyshevBodyNotFoundError);
    assert.throws(() => eph.icrfStateAt('probe', -1), ChebyshevTimeOutOfRangeError);
    assert.throws(() => eph.icrfStateAt('probe', 21), ChebyshevTimeOutOfRangeError);
  });

  // 評価器は入力の係数配列をコピーせず参照する(4.3 MB の pack で複製が 13 MB を占めるため)。
  // 所有権は渡した側から移り、以後の書き換えは答えに出る — **この検査は複製が黙って
  // 戻されたことを検出するために置いてある。**
  test('chebyshev: 同じ時刻は何度でも同じ答えを返し、入力係数はコピーされない', () => {
    const coefficients = [5, 0];
    const input: ChebyshevPack = {
      manifest: {
        version: 1,
        timeUnit: 's',
        positionUnit: 'm',
        bodies: [{ id: 'fixed', segments: [{ start: 0, end: 2, degree: 1 }] }],
      },
      bodies: [{ id: 'fixed', segments: [{ start: 0, end: 2, coefficients: [coefficients, [0, 0], [0, 0]] }] }],
    };
    const eph = new ChebyshevEphemeris(input);
    const first = eph.icrfStateAt('fixed', 1);
    assert.deepEqual(eph.icrfStateAt('fixed', 1), first);
    assert.equal(first.r.x, 5);
    coefficients[0] = 999;
    assert.equal(eph.icrfStateAt('fixed', 1).r.x, 999, '係数配列は複製されず参照されている');
  });
}
