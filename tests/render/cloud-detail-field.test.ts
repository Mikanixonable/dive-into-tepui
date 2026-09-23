import * as assert from 'node:assert/strict';
import {
  CLOUD_DETAIL_FADE_FOOTPRINT_M,
  CLOUD_DETAIL_FULL_FOOTPRINT_M,
  CLOUD_DETAIL_SCALE_M,
  cloudDetailAmplitudeForFootprintM,
} from '../../src/render/cloud/cloud-detail-field';
import { test } from '../harness';

export function register(): void {
  test('cloud detail field: standard detail is 2 km and fades only when the footprint cannot resolve it', () => {
    assert.equal(CLOUD_DETAIL_SCALE_M, 2_000);
    assert.equal(cloudDetailAmplitudeForFootprintM(0), 1);
    assert.equal(cloudDetailAmplitudeForFootprintM(CLOUD_DETAIL_FULL_FOOTPRINT_M), 1);
    assert.equal(cloudDetailAmplitudeForFootprintM(CLOUD_DETAIL_FADE_FOOTPRINT_M), 0);
    const middle = cloudDetailAmplitudeForFootprintM(
      (CLOUD_DETAIL_FULL_FOOTPRINT_M + CLOUD_DETAIL_FADE_FOOTPRINT_M) / 2,
    );
    assert.ok(middle > 0 && middle < 1);
  });

  test('cloud detail field: invalid footprints are rejected', () => {
    assert.throws(() => cloudDetailAmplitudeForFootprintM(-1), RangeError);
    assert.throws(() => cloudDetailAmplitudeForFootprintM(Number.NaN), RangeError);
  });
}
