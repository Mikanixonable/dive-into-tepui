import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  areaWeightedMassBudget,
  areaWeightedMassKg,
  evaluateC1NearRangeRasterDiagnostic,
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
    assert.ok(Math.abs(Number(result.controls.standardNearRangeCloudFieldCenterSpacingM) - 10_416) < 1,
      'derive field spacing from the standard near-range Earth shot and production cap projection');
    assert.equal(result.controls.twoKmFeatureMaximumFieldSpacingM, 500);
    assert.ok(Number(result.controls.twoKmFeatureSamplesPerFieldWavelength) < 1);
    assert.ok(Number(result.controls.twoKmFeatureScreenSamples) >= 4);
    assert.ok(Number(result.controls.twoKmFeatureInternalRasterSamples) < 4);
    assert.equal(result.controls.twoKmInternalRasterResponseStatus, 'blocked');
    assert.equal(result.controls.twoKmCloudFieldResponseStatus, 'blocked');
    assert.ok(measurement(result, 'rotation-angle').value! <= 1e-9);
    assert.ok(measurement(result, 'mass').value! <= METEOROLOGICAL_ERROR_FLOORS.relativeMass);
    assert.ok(Number(result.controls.rotationAngleRad) > 0);
    assert.equal(result.controls.materialPointCount, 5);
    assert.equal(result.controls.areaWeightedBlobMassKg, 0.009);
    assert.ok(Math.abs(Number(result.controls.transportedAreaWeightedMassKg) - 0.009) <= 1e-12);

    const repeated = evaluateMeteorologicalCase('C1');
    assert.deepEqual(repeated, result);
  });

  test('meteorological fixtures: 200 km medium raster probe remains diagnostic and does not unblock C1', () => {
    const diagnostic = evaluateC1NearRangeRasterDiagnostic();
    assert.equal(diagnostic.diagnosticOnly, true);
    assert.equal(diagnostic.shot, 'cloud-c1-raster-200km-medium-diagnostic');
    assert.ok(Math.abs(diagnostic.cameraDistanceM - 200e3) < 1e-6);
    assert.ok(diagnostic.internalRasterSamplesPerTwoKm >= diagnostic.requiredSamplesPerTwoKm);
    assert.equal(diagnostic.status, 'candidate-sufficient');

    const formal = evaluateMeteorologicalCase('C1');
    assert.equal(formal.controls.twoKmInternalRasterResponseStatus, 'blocked');
    assert.equal(measurement(formal, 'trajectory').status, 'blocked');
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

  test('meteorological fixtures: finite-area water budget integrates sources and losses across columns', () => {
    const samples = [
      { areaWeightM2: 2, initialKgM2: 0.4, sourceKgM2: 0.3, lossKgM2: 0.2, currentKgM2: 0.5 },
      { areaWeightM2: 3, initialKgM2: 0.1, sourceKgM2: 0.5, lossKgM2: 0.1, currentKgM2: 0.5 },
    ];
    const budget = areaWeightedMassBudget(samples);
    assert.equal(budget.initialKg, 1.1);
    assert.equal(budget.sourceKg, 2.1);
    assert.ok(Math.abs(budget.lossKg - 0.7) < 1e-12);
    assert.equal(budget.currentKg, 2.5);
    assert.ok(Math.abs(budget.residualKg) < 1e-12);
    assert.ok(budget.relativeResidual < 1e-12);

    const omittedSource = areaWeightedMassBudget(samples.map((sample, index) => index === 1
      ? { ...sample, sourceKgM2: 0.4 }
      : sample));
    assert.notEqual(omittedSource.residualKg, 0,
      'an omitted source in one finite-area column must appear in the integrated residual');
    assert.equal(areaWeightedMassBudget([]).relativeResidual, 0,
      'an empty field has no reference mass and no residual');
    assert.equal(areaWeightedMassBudget([
      { areaWeightM2: 1, initialKgM2: 0, sourceKgM2: 0, lossKgM2: 0, currentKgM2: 1 },
    ]).relativeResidual, Number.POSITIVE_INFINITY,
    'current mass without initial mass or supply cannot pass a relative budget');
    assert.throws(() => areaWeightedMassBudget([
      { areaWeightM2: 1, initialKgM2: 0, sourceKgM2: 1, lossKgM2: 0, currentKgM2: -1 },
    ]), RangeError);
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
    assert.equal(measurement(result, 'continuous-release-distribution').status, 'blocked');
    assert.ok(typeof result.controls.representativeReleaseTimeSeconds === 'number');
    assert.ok(result.controls.representativeReleaseTimeSeconds > 0);
    assert.ok(Number(result.controls.iceCohortCount) >= 16);
    assert.ok(Number(result.controls.actualIceCohortSpreadM) > 0);
    assert.ok(Math.abs(Number(result.controls.reconstructedIceCohortMassKgM2)
      - Number(result.controls.eventRemainingIceKgM2)) <= 1e-12);
    assert.equal(result.controls.continuousReleaseOracleIntervals, 32_768);
    assert.equal(result.controls.continuousReleasePlanMaximumSpatialSpacingM, 500);
    assert.ok(Number.isFinite(Number(result.controls.continuousReleaseQuadratureErrorM)));
    assert.ok(Number.isFinite(Number(result.controls.continuousReleaseCentroidQuadratureBoundM)));
    const convergenceErrors = String(result.controls.continuousReleaseConvergenceErrorsM)
      .split(',').map(Number);
    assert.equal(convergenceErrors.length, 4);
    assert.ok(convergenceErrors[1]! < convergenceErrors[0]!);
    assert.ok(convergenceErrors[2]! < convergenceErrors[1]!);
    assert.ok(convergenceErrors[3]! < convergenceErrors[2]!);

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
    // 方向別スペクトルの測定機構はある。波の伝播方位 π/2(北向き)へピークが立つことを確認し、
    // 量的許容域の未固定で判定は保留のままにする。
    assert.ok(Math.abs(Number(result.controls.waveSpectrumPeakComponentAzimuthRad) - Math.PI / 2) < 1e-6);
    assert.ok(Number(result.controls.waveSpectrumPeakBinPowerShare) > 0.9);
    assert.equal(String(result.controls.waveSpectrumAzimuthBinPowers).split(',').length, 18);
  });

  test('meteorological fixtures: C8 measures cell morphology on the fixture field but stays blocked', () => {
    const result = evaluateMeteorologicalCase('C8');
    assert.equal(result.generatedCloudImageFixtureApplied, false);
    for (const id of ['hole-fraction', 'cell-size', 'cell-lifetime'] as const) {
      assert.equal(measurement(result, id).status, 'blocked');
      assert.equal(measurement(result, id).value, null);
    }
    // 穴率・セル径・存続の計測値は controls へ出る。開いたセル網の fixture なので
    // 内部の穴と有限の存続が検出される。
    assert.ok(Number(result.controls.holeFraction) > 0);
    assert.ok(Number(result.controls.interiorHoleComponentCount) > 0);
    assert.ok(Number(result.controls.largestCloudyComponentEquivalentDiameterM) > 0);
    assert.ok(Number(result.controls.meanInteriorHoleEquivalentDiameterM) > 0);
    const clearDurations = String(result.controls.clearComponentPersistenceDurationsMin)
      .split(',').map(Number);
    assert.ok(clearDurations.length > 1);
    assert.ok(Math.min(...clearDurations) <= 20);
    assert.ok(Math.max(...clearDurations) === 60);
    // 供給場の層抽出へも同じ演算が当たる。
    assert.ok(Number(result.controls.supplyFieldLiquidCloudyComponentCount) > 0);
  });

  test('meteorological fixtures: C9 two-disc field passes the fixed geometry and optics gates', () => {
    const result = evaluateMeteorologicalCase('C9');
    assert.equal(result.generatedCloudImageFixtureApplied, false);
    for (const id of [
      'tau-vertical-liquid', 'tau-vertical-ice', 'tau-vertical', 'transmittance-vertical',
      'tau-slant-45', 'transmittance-slant-45',
      'phase-isolation-liquid-only', 'phase-isolation-ice-only',
      'layer-gap', 'parallax', 'parallax-centroid-liquid', 'parallax-centroid-ice',
      'wind-displacement-liquid', 'wind-displacement-ice', 'wind-cross-axis',
    ] as const) {
      assert.equal(measurement(result, id).status, 'pass', `${id} must pass`);
    }
    assert.ok(Math.abs(measurement(result, 'tau-vertical').value! - 0.6) < 0.005);
    assert.ok(Math.abs(measurement(result, 'tau-slant-45').value! - 0.8485281374) < 0.005);
    assert.ok(Math.abs(measurement(result, 'transmittance-vertical').value! - 0.5488116361) < 0.005);
    assert.ok(Math.abs(measurement(result, 'transmittance-slant-45').value! - 0.4280444912) < 0.005);
    assert.equal(measurement(result, 'phase-isolation-liquid-only').value, 0);
    assert.equal(measurement(result, 'layer-gap').value, 3_000);
    assert.ok(Math.abs(measurement(result, 'parallax').value! - 10) < 1e-9);
    assert.equal(Number(result.controls.maximumGapExtinctionPerM), 0);
    assert.ok(Number(result.controls.windDisplacementEastLiquidM) > 35_500);
    // 影の支持域は測定するが量的許容域が未固定なので blocked。
    assert.equal(measurement(result, 'shadow-support').status, 'blocked');
    assert.ok(Number(result.controls.shadowSupportAreaM2) > 0);
    assert.ok(Math.abs(
      Number(result.controls.shadowSupportAreaM2)
      - Number(result.controls.analyticShadowSupportAreaM2))
      / Number(result.controls.analyticShadowSupportAreaM2) < 0.05);

    const repeated = evaluateMeteorologicalCase('C9');
    assert.deepEqual(repeated, result);
  });
}
