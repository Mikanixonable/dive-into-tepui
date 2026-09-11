// 大気の候補範囲が散乱と発光の両方を覆うことを検査する。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { cutoffAltitude, type AtmosphereOptics } from '../../src/render/atmosphere';

const BASE: AtmosphereOptics = {
  rayleigh: new THREE.Vector3(5.802e-6, 13.558e-6, 33.1e-6),
  rayleighScaleHeight: 8e3,
  mie: 3.996e-6,
  mieScaleHeight: 1.2e3,
  mieAnisotropy: 0.8,
};

export function register(): void {
  test('atmosphere: airglow is included in the cutoff sphere', () => {
    const scatteredOnly = cutoffAltitude(BASE, 6.378e6);
    const withAirglow = cutoffAltitude({
      ...BASE,
      airglow: { color: [0.1, 0.8, 0.4], strength: 1e-8, altitude: 95e3, scaleHeight: 8e3 },
    }, 6.378e6);
    assert.ok(withAirglow > scatteredOnly, `${withAirglow} should include the emission layer`);
    assert.ok(withAirglow >= 95e3 + 4 * 8e3);
  });

  test('atmosphere: no airglow keeps the existing cutoff', () => {
    const base = cutoffAltitude(BASE, 6.378e6);
    assert.equal(cutoffAltitude({ ...BASE, airglow: undefined }, 6.378e6), base);
  });
}
