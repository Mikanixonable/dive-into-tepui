import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { evaluateMeteorologicalCase, type MeteorologicalCaseEvaluation } from '../../tools/cloud-lab/meteorological-evaluator';

function measurement(result: MeteorologicalCaseEvaluation, id: string) {
  const found = result.measurements.find((item) => item.measurementId === id);
  assert.ok(found, `${result.fixture} is missing measurement ${id}`);
  return found;
}

export function register(): void {
  test('meteorological fixtures: C1 compares spherical transport with analytic motion and blocks unsupported mass', () => {
    const result = evaluateMeteorologicalCase('C1');
    assert.equal(result.cpuDiagnosticsApplied, true);
    assert.equal(result.generatedCloudImageFixtureApplied, false);
    assert.equal(measurement(result, 'trajectory').status, 'pass');
    assert.equal(measurement(result, 'mass').status, 'blocked');
  });

  test('meteorological fixtures: C2 changes wind direction with height in one control profile', () => {
    const result = evaluateMeteorologicalCase('C2');
    assert.equal(result.controls.lowerEastWindMps, 10);
    assert.equal(result.controls.upperNorthWindMps, 10);
    assert.equal(measurement(result, 'layer-displacement').status, 'pass');
    assert.equal(measurement(result, 'released-ice-track').status, 'blocked');
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
