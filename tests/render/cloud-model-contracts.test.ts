import * as assert from 'node:assert/strict';
import { cloudLifecycleAt, bandLimitLifecycle } from '../../src/render/cloud/cloud-lifecycle';
import { cloudPhaseWeights, cloudTemperatureKAtAltitude } from '../../src/render/cloud/cloud-temperature-profile';
import { cloudVerticalProfileAt, verticalProfileSupport } from '../../src/render/cloud/cloud-vertical-profile';
import { observedCloudBasisFromRgba } from '../../src/render/cloud/observed-cloud-adapter';
import { orographicPattern, orographicPatternForcing } from '../../src/render/cloud/orographic-pattern';
import { backAdvectedCoordinate, subGridAmplitude } from '../../src/render/cloud/cloud-subgrid';
import { test } from '../harness';

export function register(): void {
  test('cloud contracts: lifecycle is deterministic and high-frequency detail is band-limited', () => {
    assert.deepEqual(cloudLifecycleAt(3_600, 17, 0.8), cloudLifecycleAt(3_600, 17, 0.8));
    const current = cloudLifecycleAt(3_600, 17, 0.8);
    const averaged = bandLimitLifecycle(current, 6 * 3_600);
    assert.ok(averaged.cell < current.cell);
    assert.ok(averaged.meso === current.meso);
  });

  test('cloud contracts: temperature and profile are continuous and bounded', () => {
    assert.ok(cloudTemperatureKAtAltitude(288, 10_000) < 288);
    const cold = cloudPhaseWeights(248);
    const mixed = cloudPhaseWeights(263);
    const warm = cloudPhaseWeights(278);
    assert.ok(cold.ice > warm.ice);
    assert.ok(mixed.mixed > 0);
    const profile = cloudVerticalProfileAt(8_000, { low: 0.4, middle: 0.5, convective: 0.8, inSitu: 0.2 });
    assert.ok(verticalProfileSupport(profile));
    for (const value of Object.values(profile)) assert.ok(value >= 0 && value <= 1);
    assert.ok(cloudVerticalProfileAt(0, { low: 1, middle: 0, convective: 0, inSitu: 0 }).low > 0.9);
    assert.equal(
      cloudVerticalProfileAt(20_000, { low: 0, middle: 0, convective: 1, inSitu: 1 }).convective,
      0,
    );
  });

  test('cloud contracts: observed adapter does not infer convective phase', () => {
    assert.deepEqual(observedCloudBasisFromRgba(2, -1, 0.5, 0.8), {
      low: 1, middle: 0, convective: 0, inSitu: 0.4,
    });
  });

  test('cloud contracts: orographic pattern is downstream and continuous', () => {
    assert.equal(orographicPattern(-1, 0, 100), 0);
    assert.equal(orographicPattern(10, 0, 0), 0);
    assert.ok(Math.abs(orographicPattern(1_000, 0, 10_000)) <= 1);
    assert.equal(orographicPatternForcing(0.2, 0, 0, 10_000), 0.2);
  });

  test('cloud contracts: world-space sub-grid back-advection is camera independent', () => {
    assert.deepEqual(backAdvectedCoordinate([10, 20], [2, -1], 5), [0, 25]);
    assert.equal(subGridAmplitude(1_000, 100, 0), 1);
    assert.ok(subGridAmplitude(1_000, 100, 3_600) < 1);
  });
}
