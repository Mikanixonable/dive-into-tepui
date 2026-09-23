import * as assert from 'node:assert/strict';
import {
  analyticC2ReleasedIceDirection,
  evaluateC2ContinuousReleaseOracle,
  type C2ContinuousReleaseOracleInput,
} from '../../tools/cloud-lab/c2-continuous-release-oracle';
import { len, v3 } from '../../src/math/vec3';
import { test } from '../harness';

function input(overrides: Partial<C2ContinuousReleaseOracleInput> = {}): C2ContinuousReleaseOracleInput {
  const sphereRadiusM = 6_371_000;
  const cohortCount = 1;
  const cohortDirection = analyticC2ReleasedIceDirection(
    2.5, 10, sphereRadiusM, 1_000, 10_000, 10, 10,
  );
  return {
    releaseStartTimeSeconds: 0,
    releaseEndTimeSeconds: 5,
    sampleTimeSeconds: 10,
    sphereRadiusM,
    lowerHeightM: 1_000,
    upperHeightM: 10_000,
    lowerEastWindMps: 10,
    upperNorthWindMps: 10,
    releaseRateKgM2S: 1e-5,
    sublimationRatePerSecond: 1e-4,
    cohortsByCount: [{
      count: cohortCount,
      cohorts: [{ directionUnitVector: cohortDirection, massKgM2: 1e-5 }],
    }],
    ...overrides,
  };
}

export function register(): void {
  test('C2 continuous oracle: centroid quadrature bound remains finite with opposing signed winds', () => {
    const stillAir = evaluateC2ContinuousReleaseOracle(input({
      lowerEastWindMps: 0,
      upperNorthWindMps: 0,
    }));
    const opposingWinds = evaluateC2ContinuousReleaseOracle(input({
      lowerEastWindMps: -10,
      upperNorthWindMps: 10,
    }));
    assert.ok(Number.isFinite(opposingWinds.centroidQuadratureErrorBoundM));
    assert.ok(opposingWinds.centroidQuadratureErrorBoundM > stillAir.centroidQuadratureErrorBoundM);
    assert.ok(opposingWinds.centroidQuadratureErrorBoundM >= 0);
  });

  test('C2 continuous oracle: rejects invalid release, radius, rate, and cohort mass contracts', () => {
    assert.throws(() => evaluateC2ContinuousReleaseOracle(input({ sphereRadiusM: 0 })), /sphereRadiusM must be positive/);
    assert.throws(() => evaluateC2ContinuousReleaseOracle(input({ releaseEndTimeSeconds: 0 })), /release interval/);
    assert.throws(() => evaluateC2ContinuousReleaseOracle(input({ sampleTimeSeconds: 4 })), /must not precede/);
    assert.throws(() => evaluateC2ContinuousReleaseOracle(input({ releaseRateKgM2S: 0 })), /releaseRateKgM2S must be positive/);
    assert.throws(() => evaluateC2ContinuousReleaseOracle(input({ sublimationRatePerSecond: -1 })), /must be non-negative/);
    assert.throws(() => evaluateC2ContinuousReleaseOracle(input({
      cohortsByCount: [{ count: 2, cohorts: [{ directionUnitVector: v3(0, 0, 1), massKgM2: 1 }] }],
    })), /expected 2 cohorts/);
    assert.throws(() => evaluateC2ContinuousReleaseOracle(input({
      cohortsByCount: [{ count: 1, cohorts: [{ directionUnitVector: v3(0, 0, 1), massKgM2: -1 }] }],
    })), /massKgM2 must be non-negative/);
    assert.throws(() => evaluateC2ContinuousReleaseOracle(input({
      cohortsByCount: [{ count: 1, cohorts: [{ directionUnitVector: v3(0, 0, 1), massKgM2: Infinity }] }],
    })), /massKgM2 must be finite/);
    assert.throws(() => evaluateC2ContinuousReleaseOracle(input({
      cohortsByCount: [{ count: 1, cohorts: [{ directionUnitVector: v3(0, 0, 0), massKgM2: 1 }] }],
    })), /unit vector/);
  });

  test('C2 continuous oracle: accepts negative layer winds and keeps analytic directions normalized', () => {
    const direction = analyticC2ReleasedIceDirection(4, 10, 6_371_000, 1_000, 10_000, -10, 10);
    assert.ok(Math.abs(len(direction) - 1) < 1e-14);
    const result = evaluateC2ContinuousReleaseOracle(input({
      lowerEastWindMps: -10,
      upperNorthWindMps: 10,
    }));
    assert.ok(Number.isFinite(result.centroidQuadratureErrorBoundM));
    assert.ok(result.convergenceErrorsM.every(Number.isFinite));
  });

  test('C2 continuous oracle: rejects a midpoint bound that cannot constrain the centroid angle', () => {
    assert.throws(() => evaluateC2ContinuousReleaseOracle(input({
      sphereRadiusM: 1,
      lowerHeightM: 0,
      upperHeightM: 0,
      lowerEastWindMps: 2 * Math.PI * 32_768,
      upperNorthWindMps: 0,
      sublimationRatePerSecond: 0,
      releaseStartTimeSeconds: 0,
      releaseEndTimeSeconds: 1,
      sampleTimeSeconds: 1,
    })), /midpoint error bound/);
  });
}
