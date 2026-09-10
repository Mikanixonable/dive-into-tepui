import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  CLOUD_CELL_SCALE_MAX,
  CLOUD_CELL_SCALE_MIN,
  CLOUD_CELL_VARIANCE_PROFILES,
  cloudCellScaleFromNoise,
  cloudCellVarianceProfileAt,
} from '../../src/render/cloud/cloud-cell-variance';

const DEG = Math.PI / 180;

export function register(): void {
  test('cloud cell variance: high latitude has wider variance than low latitude', () => {
    const lowOcean = cloudCellVarianceProfileAt(0, 0);
    const highOcean = cloudCellVarianceProfileAt(90 * DEG, 0);
    const lowLand = cloudCellVarianceProfileAt(0, 1);
    const highLand = cloudCellVarianceProfileAt(90 * DEG, 1);

    assert.ok(highOcean.logSigma > lowOcean.logSigma);
    assert.ok(highLand.logSigma > lowLand.logSigma);
    assert.ok(highLand.meanScale > lowLand.meanScale);
    assert.ok(highOcean.scaleMin <= lowOcean.scaleMin);
    assert.ok(highOcean.scaleMax > lowOcean.scaleMax);
  });

  test('cloud cell variance: land has wider variance than ocean at both latitude extremes', () => {
    const lowOcean = cloudCellVarianceProfileAt(0, 0);
    const lowLand = cloudCellVarianceProfileAt(0, 1);
    const highOcean = cloudCellVarianceProfileAt(90 * DEG, 0);
    const highLand = cloudCellVarianceProfileAt(90 * DEG, 1);

    assert.ok(lowLand.logSigma > lowOcean.logSigma);
    assert.ok(highLand.logSigma > highOcean.logSigma);
    assert.ok(lowLand.meanScale > lowOcean.meanScale);
    assert.ok(highLand.meanScale > highOcean.meanScale);
    assert.ok(lowLand.scaleMax > lowOcean.scaleMax);
    assert.ok(highLand.scaleMax > highOcean.scaleMax);
    assert.ok(lowLand.scaleMin * 4000 >= 8000);
    assert.ok(highLand.scaleMin * 4000 >= 8000);
  });

  test('cloud cell variance: regional weights are monotonic between the anchors', () => {
    let previousLatitude = cloudCellVarianceProfileAt(0, 0.5).logSigma;
    for (let latitude = 1; latitude <= 90; latitude++) {
      const current = cloudCellVarianceProfileAt(latitude * DEG, 0.5).logSigma;
      assert.ok(current >= previousLatitude);
      previousLatitude = current;
    }

    let previousLand = cloudCellVarianceProfileAt(40 * DEG, 0).logSigma;
    for (let land = 0.01; land <= 1; land += 0.01) {
      const current = cloudCellVarianceProfileAt(40 * DEG, land).logSigma;
      assert.ok(current >= previousLand);
      previousLand = current;
    }
  });

  test('cloud cell variance: regional interpolation preserves all four anchor profiles', () => {
    const anchors = [
      ['lowLatitudeOcean', cloudCellVarianceProfileAt(0, 0)],
      ['lowLatitudeLand', cloudCellVarianceProfileAt(0, 1)],
      ['highLatitudeOcean', cloudCellVarianceProfileAt(90 * DEG, 0)],
      ['highLatitudeLand', cloudCellVarianceProfileAt(90 * DEG, 1)],
    ] as const;
    for (const [name, actual] of anchors) {
      const expected = CLOUD_CELL_VARIANCE_PROFILES[name];
      assert.deepEqual(actual, expected);
      assert.equal(cloudCellScaleFromNoise(0, actual), expected.meanScale);
    }
  });

  test('cloud cell variance: latitude and land transitions are continuous', () => {
    const latitudes = [15 * DEG, 37.5 * DEG, 60 * DEG];
    for (const latitude of latitudes) {
      const below = cloudCellVarianceProfileAt(latitude - 1e-7, 0.4);
      const above = cloudCellVarianceProfileAt(latitude + 1e-7, 0.4);
      assert.ok(Math.abs(above.logSigma - below.logSigma) < 1e-6);
      assert.ok(Math.abs(above.scaleMin - below.scaleMin) < 1e-6);
      assert.ok(Math.abs(above.scaleMax - below.scaleMax) < 1e-6);
    }

    const landFractions = [0, 0.5, 1];
    for (const landFraction of landFractions) {
      const below = cloudCellVarianceProfileAt(40 * DEG, landFraction - 1e-7);
      const above = cloudCellVarianceProfileAt(40 * DEG, landFraction + 1e-7);
      assert.ok(Math.abs(above.logSigma - below.logSigma) < 1e-6);
      assert.ok(Math.abs(above.scaleMin - below.scaleMin) < 1e-6);
      assert.ok(Math.abs(above.scaleMax - below.scaleMax) < 1e-6);
    }

    const coast = cloudCellVarianceProfileAt(40 * DEG, 0.5);
    assert.ok(coast.logSigma > cloudCellVarianceProfileAt(40 * DEG, 0).logSigma);
    assert.ok(coast.logSigma < cloudCellVarianceProfileAt(40 * DEG, 1).logSigma);
  });

  test('cloud cell variance: scale stays in the implementation range', () => {
    for (let latitude = 0; latitude <= 90; latitude += 5) {
      for (let land = 0; land <= 1; land += 0.1) {
        const profile = cloudCellVarianceProfileAt(latitude * DEG, land);
        for (let noise = -1; noise <= 1; noise += 0.1) {
          const scale = cloudCellScaleFromNoise(noise, profile);
          assert.ok(Number.isFinite(scale));
          assert.ok(scale >= CLOUD_CELL_SCALE_MIN && scale <= CLOUD_CELL_SCALE_MAX);
        }
      }
    }
  });

  test('cloud cell variance: noise near both ends is finite and deterministic', () => {
    const profile = cloudCellVarianceProfileAt(55 * DEG, 0.75);
    const negative = cloudCellScaleFromNoise(-1 + Number.EPSILON, profile);
    const positive = cloudCellScaleFromNoise(1 - Number.EPSILON, profile);

    assert.ok(Number.isFinite(negative));
    assert.ok(Number.isFinite(positive));
    assert.ok(negative < positive);
    assert.equal(negative, cloudCellScaleFromNoise(-1 + Number.EPSILON, profile));
    assert.equal(positive, cloudCellScaleFromNoise(1 - Number.EPSILON, profile));
    assert.equal(
      cloudCellScaleFromNoise(Number.NaN, profile),
      cloudCellScaleFromNoise(0, profile),
    );
  });

  test('cloud cell variance: exported profiles remain valid reference anchors', () => {
    for (const profile of Object.values(CLOUD_CELL_VARIANCE_PROFILES)) {
      assert.ok(profile.logSigma > 0);
      assert.ok(profile.scaleMin >= CLOUD_CELL_SCALE_MIN);
      assert.ok(profile.scaleMax <= CLOUD_CELL_SCALE_MAX);
      assert.ok(profile.scaleMin <= profile.meanScale);
      assert.ok(profile.meanScale <= profile.scaleMax);
    }
  });
}
