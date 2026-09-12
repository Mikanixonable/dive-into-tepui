// 大気の候補範囲が散乱と発光の両方を覆うことを検査する。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { cutoffAltitude, withAirglowEnabled, type AtmosphereOptics } from '../../src/render/atmosphere';

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

  test('atmosphere: エアグローをオフにしても打ち切り高度は変わらず、発光の項だけが消える', () => {
    const on: AtmosphereOptics = {
      ...BASE,
      airglow: { color: [0.1, 0.8, 0.4], strength: 1e-8, altitude: 95e3, scaleHeight: 8e3 },
    };
    const off = withAirglowEnabled(on, false);
    // **積分の範囲が動かないことが切り分けの条件** — 動くと、オンオフの差が発光由来か
    // 積分の粗さ由来かを分けられなくなる。
    assert.equal(cutoffAltitude(off, 6.378e6), cutoffAltitude(on, 6.378e6));
    assert.equal(off.airglow?.strength, 0);
    assert.deepEqual(off.airglow?.color, on.airglow?.color);
    assert.equal(off.airglow?.altitude, on.airglow?.altitude);
    assert.equal(off.airglow?.scaleHeight, on.airglow?.scaleHeight);
    // オンのままなら光学はそのもの、発光層を持たない大気はオフでもそのまま。
    assert.equal(withAirglowEnabled(on, true), on);
    assert.equal(withAirglowEnabled(BASE, false), BASE);
  });
}
