// lambert-sphere.ts の回帰テスト。期待値はランバート球の解析解。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { lambertPhase, lambertSphereIrradiance } from '../../src/physics/lambert-sphere';

export function register(): void {
  test('lambert-sphere: 位相関数は満相で 1、矩で 1/π、新相で 0', () => {
    assert.ok(Math.abs(lambertPhase(0) - 1) < 1e-12);
    assert.ok(Math.abs(lambertPhase(Math.PI / 2) - 1 / Math.PI) < 1e-12);
    assert.ok(Math.abs(lambertPhase(Math.PI)) < 1e-12);
  });

  test('lambert-sphere: 位相関数は 0..π で単調に減る', () => {
    let previous = lambertPhase(0);
    for (let i = 1; i <= 180; i++) {
      const current = lambertPhase((Math.PI * i) / 180);
      assert.ok(current < previous, `α=${i}°`);
      previous = current;
    }
  });

  test('lambert-sphere: 満相の放射照度は (2/3)·A·E·(R/d)² で、距離の逆二乗で減る', () => {
    const albedo = 0.3;
    const irradiance = Math.PI;
    const radius = 6.371e6;
    const near = lambertSphereIrradiance(albedo, irradiance, radius, 1e9, 0);
    const far = lambertSphereIrradiance(albedo, irradiance, radius, 2e9, 0);
    assert.ok(Math.abs(near - (2 / 3) * albedo * irradiance * (radius / 1e9) ** 2) < 1e-15);
    assert.ok(Math.abs(near / far - 4) < 1e-9);
  });
}
