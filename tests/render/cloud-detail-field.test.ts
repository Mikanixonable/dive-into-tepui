import * as assert from 'node:assert/strict';
import {
  CLOUD_DETAIL_FADE_FOOTPRINT_M,
  CLOUD_DETAIL_FULL_FOOTPRINT_M,
  CLOUD_DETAIL_SCALE_M,
  cloudDetailAmplitudeForFootprintM,
} from '../../src/render/cloud/cloud-detail-field';
import { test } from '../harness';

export function register(): void {
  test('cloud detail field: 2 km detail keeps four samples and vanishes by the Nyquist limit', () => {
    assert.equal(CLOUD_DETAIL_SCALE_M, 2_000);
    assert.equal(CLOUD_DETAIL_FULL_FOOTPRINT_M, CLOUD_DETAIL_SCALE_M / 4);
    assert.equal(CLOUD_DETAIL_FADE_FOOTPRINT_M, CLOUD_DETAIL_SCALE_M / 2);
    assert.equal(cloudDetailAmplitudeForFootprintM(0), 1);
    assert.equal(cloudDetailAmplitudeForFootprintM(CLOUD_DETAIL_FULL_FOOTPRINT_M), 1);
    assert.equal(cloudDetailAmplitudeForFootprintM(CLOUD_DETAIL_FADE_FOOTPRINT_M), 0);
    const sweep = [500, 600, 700, 800, 900, 1_000]
      .map((footprintM) => cloudDetailAmplitudeForFootprintM(footprintM));
    for (let index = 1; index < sweep.length; index += 1) {
      assert.ok(sweep[index]! <= sweep[index - 1]!);
    }
    assert.ok(sweep.slice(1, -1).some((value) => value > 0 && value < 1));
  });

  test('cloud detail field: invalid footprints are rejected', () => {
    assert.throws(() => cloudDetailAmplitudeForFootprintM(-1), RangeError);
    assert.throws(() => cloudDetailAmplitudeForFootprintM(Number.NaN), RangeError);
  });
}
