import * as assert from 'node:assert/strict';
import { cloudQualityPolicy, cloudTemporalSampleTimes } from '../../src/render/cloud/cloud-quality';
import { test } from '../harness';

export function register(): void {
  test('cloud quality: higher quality shortens temporal interval and preserves finer footprint', () => {
    const coarse = cloudQualityPolicy(1);
    const standard = cloudQualityPolicy(2);
    const fine = cloudQualityPolicy(3);
    assert.ok(coarse.temporalIntervalSeconds > standard.temporalIntervalSeconds);
    assert.ok(standard.temporalIntervalSeconds > fine.temporalIntervalSeconds);
    assert.ok(coarse.detailFootprintScale > standard.detailFootprintScale);
    assert.ok(standard.detailFootprintScale > fine.detailFootprintScale);
  });

  test('cloud quality: temporal samples bracket positive and negative time deterministically', () => {
    for (const time of [-1_234, 0, 1_234, 86_401]) {
      const sample = cloudTemporalSampleTimes(time, 2);
      assert.ok(sample.lowerTimeSeconds <= time);
      assert.ok(sample.upperTimeSeconds > time);
      assert.ok(sample.fraction >= 0 && sample.fraction < 1);
      assert.deepEqual(sample, cloudTemporalSampleTimes(time, 2));
    }
  });

  test('cloud quality: invalid levels are rejected', () => {
    assert.throws(() => cloudQualityPolicy(-1), RangeError);
    assert.throws(() => cloudQualityPolicy(4), RangeError);
  });
}
