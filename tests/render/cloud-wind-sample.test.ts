import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { WIND_SPAN, windFromEncodedTexel } from '../../src/render/cloud/cloud-wind-sample';

// 風 [m/s] を焼き込み用の 0..1 へ符号化し、半精度へ量子化してから復号する。
// 往復の誤差は半精度の量子化ぶんだけになる。
function roundTripEast(wind: number): number {
  const encoded = wind / (2 * WIND_SPAN) + 0.5;
  const quantized = THREE.DataUtils.fromHalfFloat(THREE.DataUtils.toHalfFloat(encoded));
  return windFromEncodedTexel(quantized, 0.5).east;
}

export function register(): void {
  test('cloud wind sample: encoded wind round-trips within half-float error', () => {
    for (const wind of [-30, -10, -1, 0, 1, 10, 30]) {
      assert.ok(Math.abs(roundTripEast(wind) - wind) < 0.1, `wind ${wind} m/s`);
    }
  });

  test('cloud wind sample: decode is exact at 0 and ±WIND_SPAN', () => {
    assert.equal(windFromEncodedTexel(0.5, 0.5).east, 0);
    assert.equal(windFromEncodedTexel(0.5, 0.5).north, 0);
    assert.equal(windFromEncodedTexel(1, 0.5).east, WIND_SPAN);
    assert.equal(windFromEncodedTexel(0, 0.5).east, -WIND_SPAN);
    assert.equal(windFromEncodedTexel(0.5, 1).north, WIND_SPAN);
    assert.equal(windFromEncodedTexel(0.5, 0).north, -WIND_SPAN);
  });
}
