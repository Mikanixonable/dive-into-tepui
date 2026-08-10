import * as assert from 'node:assert/strict';
import { adaptExposure, CELESTIAL_EXPOSURE, clampExposure, NEUTRAL_CELESTIAL_EXPOSURE } from '../../src/render/exposure';
import { test } from './harness';

export function register(): void {
  test('露出は許容範囲へクランプされる', () => {
    assert.equal(clampExposure(-3), CELESTIAL_EXPOSURE.min);
    assert.equal(clampExposure(9), CELESTIAL_EXPOSURE.max);
  });

  test('露出適応は目標へ単調に近づき、過走しない', () => {
    const next = adaptExposure(0.7, 1.3, 0.5);
    assert.ok(next > 0.7 && next < 1.3);
    assert.equal(adaptExposure(1.1, 0.7, 0), 1.1);
  });

  test('不正な露出入力は中立値へ安全に戻る', () => {
    assert.equal(adaptExposure(Number.NaN, Number.POSITIVE_INFINITY, 0.1), NEUTRAL_CELESTIAL_EXPOSURE);
  });
}
