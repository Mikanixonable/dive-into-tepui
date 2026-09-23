import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  areaWeightedMassKg,
  evaluateMeteorologicalCase,
  type MeteorologicalCaseEvaluation,
} from '../../tools/cloud-lab/meteorological-evaluator';
import { METEOROLOGICAL_ERROR_FLOORS } from '../../tools/cloud-lab/meteorological-cases';

function measurement(result: MeteorologicalCaseEvaluation, id: string) {
  const found = result.measurements.find((item) => item.measurementId === id);
  assert.ok(found, `${result.fixture} is missing measurement ${id}`);
  return found;
}

export function register(): void {
  test('meteorological fixtures: C1 transports an area-weighted finite blob by analytic rigid sphere rotation', () => {
    const result = evaluateMeteorologicalCase('C1');
    assert.equal(result.cpuDiagnosticsApplied, true);
    assert.equal(result.generatedCloudImageFixtureApplied, false);
    assert.equal(measurement(result, 'trajectory').status, 'blocked');
    assert.equal(measurement(result, 'rotation-angle').status, 'pass');
    assert.equal(measurement(result, 'mass').status, 'pass');
    assert.equal(measurement(result, 'trajectory').value, null);
    assert.ok(Number(result.controls.maximumAnalyticTrajectoryErrorM) < 0.01,
      'retain the measured analytic error for diagnostics without claiming the plan threshold passed');
    assert.ok(measurement(result, 'rotation-angle').value! <= 1e-9);
    assert.ok(measurement(result, 'mass').value! <= METEOROLOGICAL_ERROR_FLOORS.relativeMass);
    assert.ok(Number(result.controls.rotationAngleRad) > 0);
    assert.equal(result.controls.materialPointCount, 5);
    assert.equal(result.controls.areaWeightedBlobMassKg, 0.009);
    assert.ok(Math.abs(Number(result.controls.transportedAreaWeightedMassKg) - 0.009) <= 1e-12);

    const repeated = evaluateMeteorologicalCase('C1');
    assert.deepEqual(repeated, result);
  });

  test('meteorological fixtures: C1 area integration detects omitted weights and lost material columns', () => {
    const samples = [
      { areaWeightM2: 1, massKgM2: 0.0006 },
      { areaWeightM2: 2, massKgM2: 0.0008 },
      { areaWeightM2: 3, massKgM2: 0.001 },
      { areaWeightM2: 2, massKgM2: 0.0012 },
      { areaWeightM2: 1, massKgM2: 0.0014 },
    ];
    assert.equal(areaWeightedMassKg(samples), 0.009);
    assert.notEqual(samples.reduce((total, sample) => total + sample.massKgM2, 0), 0.009,
      'unweighted point sums must not accidentally satisfy the independent quadrature oracle');
    assert.notEqual(areaWeightedMassKg(samples.slice(0, -1)), 0.009,
      'dropping a finite-blob material column must change integrated mass');
    assert.notEqual(areaWeightedMassKg(samples.map((sample, index) => index === 2
      ? { ...sample, areaWeightM2: 1 }
      : sample)), 0.009,
    'a corrupted area weight must change the integrated mass');
    assert.throws(() => areaWeightedMassKg([
      { areaWeightM2: 1, massKgM2: 1 },
      { areaWeightM2: 1, massKgM2: -1 },
    ]), RangeError, 'negative mass cannot cancel into an apparently conserved total');
    assert.throws(() => areaWeightedMassKg([
      { areaWeightM2: Number.NaN, massKgM2: 1 },
    ]), RangeError, 'non-finite area weights cannot enter the integral');
    assert.throws(() => areaWeightedMassKg([
      { areaWeightM2: 1, massKgM2: Number.POSITIVE_INFINITY },
    ]), RangeError, 'non-finite mass cannot enter the integral');
    assert.throws(() => areaWeightedMassKg([
      { areaWeightM2: Number.MAX_VALUE, massKgM2: 2 },
    ]), RangeError, 'finite inputs whose product overflows cannot enter the integral');
    assert.throws(() => areaWeightedMassKg([
      { areaWeightM2: 1, massKgM2: Number.MAX_VALUE },
      { areaWeightM2: 1, massKgM2: Number.MAX_VALUE },
    ]), RangeError, 'finite products whose sum overflows cannot become a valid total');
  });

  test('meteorological fixtures: C2 validates every released-ice cohort against two-layer analytic transport', () => {
    const result = evaluateMeteorologicalCase('C2');
    assert.equal(result.controls.lowerEastWindMps, 10);
    assert.equal(result.controls.upperNorthWindMps, 10);
    assert.equal(measurement(result, 'layer-displacement').status, 'pass');
    assert.equal(measurement(result, 'released-ice-track').status, 'pass');
    assert.equal(measurement(result, 'released-ice-cohorts').status, 'pass');
    assert.equal(measurement(result, 'released-ice-mass').status, 'pass');
    assert.equal(measurement(result, 'released-ice-spread').status, 'pass');
    assert.ok(typeof result.controls.representativeReleaseTimeSeconds === 'number');
    assert.ok(result.controls.representativeReleaseTimeSeconds > 0);
    assert.ok(Number(result.controls.iceCohortCount) >= 16);
    assert.ok(Number(result.controls.actualIceCohortSpreadM) > 0);
    assert.ok(Math.abs(Number(result.controls.reconstructedIceCohortMassKgM2)
      - Number(result.controls.eventRemainingIceKgM2)) <= 1e-12);

    evaluateMeteorologicalCase('C1');
    assert.deepEqual(evaluateMeteorologicalCase('C2'), result);
  });

  test('meteorological fixtures: C3 stops supply while event ice remains', () => {
    const result = evaluateMeteorologicalCase('C3');
    assert.equal(result.controls.supplyDurationSeconds, 3_600);
    assert.equal(measurement(result, 'anvil-residual').status, 'pass');
    assert.ok(measurement(result, 'anvil-residual').value! > 0);
    assert.equal(measurement(result, 'anvil-lifetime').status, 'blocked');
  });

  test('meteorological fixtures: C4 changes only upper humidity for event loss and residual ice', () => {
    const result = evaluateMeteorologicalCase('C4');
    assert.notEqual(result.controls.moistIceHumidityFactor, result.controls.dryIceHumidityFactor);
    assert.equal(measurement(result, 'sublimation-loss').status, 'pass');
    assert.equal(measurement(result, 'residual-ice-difference').status, 'pass');
    assert.equal(measurement(result, 'residual-lifetime').status, 'blocked');
  });

  test('meteorological fixtures: C5 stronger inversion suppresses parcel positive buoyancy', () => {
    const result = evaluateMeteorologicalCase('C5');
    assert.equal(result.controls.surfaceFluxesHeldFixed, true);
    assert.equal(measurement(result, 'convective-top').status, 'pass');
    assert.ok(measurement(result, 'convective-top').value! < 0);
    assert.equal(measurement(result, 'deep-penetration').status, 'blocked');
  });

  test('meteorological fixtures: C6 closes event mass and independently checks radius-to-optics equation', () => {
    const result = evaluateMeteorologicalCase('C6');
    assert.equal(result.controls.supplyRateKgM2S, 1e-5);
    assert.equal(result.controls.doubledSupplyRateKgM2S, 2e-5);
    assert.equal(measurement(result, 'supply-response').status, 'pass');
    assert.equal(measurement(result, 'particle-size-response').status, 'pass');
    assert.equal(measurement(result, 'mass-balance').status, 'pass');
    assert.equal(measurement(result, 'non-negative').status, 'pass');
    assert.equal(measurement(result, 'optical-closure').status, 'pass');
  });

  test('meteorological fixtures: C7 separates stable wave phase, saturation control, and material wind track', () => {
    const result = evaluateMeteorologicalCase('C7');
    assert.ok(result.controls.moistIceHumidityFactor! > result.controls.dryIceHumidityFactor!);
    assert.equal(measurement(result, 'wave-track').status, 'pass');
    assert.equal(measurement(result, 'material-track').status, 'pass');
    assert.equal(measurement(result, 'wave-cloud-condensation').value, 1);
    assert.equal(measurement(result, 'dry-wave-cloud-control').value, 0);
    assert.equal(measurement(result, 'directional-spectrum').status, 'blocked');
  });

  test('meteorological fixtures: C8 and C9 stay explicitly blocked until their field models exist', () => {
    for (const id of ['C8', 'C9'] as const) {
      const result = evaluateMeteorologicalCase(id);
      assert.ok(result.measurements.length > 0);
      assert.ok(result.measurements.every((item) => item.status === 'blocked' && item.value === null));
      assert.equal(result.generatedCloudImageFixtureApplied, false);
    }
  });
}
