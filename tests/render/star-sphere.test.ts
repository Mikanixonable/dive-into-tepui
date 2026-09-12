// 恒星円盤の周縁減光が、中心から縁へ単調に暗くなりながら総光量を保つことを固定する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { stellarLimbIntensity } from '../../src/render/celestial/star-sphere';

const EPSILON = 1e-12;

export function register(): void {
  test('star sphere: 周縁減光は円盤中心から縁へ単調に暗くなる', () => {
    let previous = stellarLimbIntensity(1);
    for (let step = 1; step <= 100; step++) {
      const intensity = stellarLimbIntensity(1 - step / 100);
      assert.ok(intensity <= previous, `μ=${1 - step / 100} で ${intensity} > ${previous}`);
      previous = intensity;
    }
    assert.ok(stellarLimbIntensity(1) > stellarLimbIntensity(0));
  });

  test('star sphere: 周縁減光後も投影円盤の平均輝度が1', () => {
    const rings = 100_000;
    let sum = 0;
    for (let ring = 0; ring < rings; ring++) {
      const radiusSqr = (ring + 0.5) / rings;
      sum += stellarLimbIntensity(Math.sqrt(1 - radiusSqr));
    }
    assert.ok(Math.abs(sum / rings - 1) < 1e-8, `円盤平均 ${sum / rings}`);
  });

  test('star sphere: 法線余弦を円盤内へ制限する', () => {
    assert.ok(Math.abs(stellarLimbIntensity(-1) - stellarLimbIntensity(0)) < EPSILON);
    assert.ok(Math.abs(stellarLimbIntensity(2) - stellarLimbIntensity(1)) < EPSILON);
  });
}
