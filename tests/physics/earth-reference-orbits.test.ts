// earth-reference-orbits.ts の回帰テスト。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { dawnDuskElements, sunSyncRepeatGroundTrackElements } from '../../src/physics/earth-reference-orbits';
import { CelestialBody } from '../../src/physics/celestial-body';
import { ECI_POLE } from '../../src/physics/ecliptic';
import { kinematicState } from '../../src/physics/kinematic-state';
import { OrbitalElements } from '../../src/physics/elements';
import { J2_EARTH, MU_EARTH, R_EARTH_EQ } from '../../src/physics/solar-system/constants';
import { v3 } from '../../src/math/vec3';

// 中心天体。昇交点の向きだけを見るので、原点に静止した地球で足りる。
const EARTH: CelestialBody = {
  id: 'earth', mu: MU_EARTH, radius: R_EARTH_EQ,
  state: kinematicState(0, v3(), v3()), accel: v3(),
  degree2: { j2: J2_EARTH, refRadius: R_EARTH_EQ, pole: ECI_POLE, tesseral: null },
  atmosphere: null, isStar: false,
};

// hHat = (sin(raan)sin(inc), cos(inc), cos(raan)sin(inc))(orbitPlaneBasis の逆)から
// 昇交点赤経を復元する。
function raanDegOf(el: OrbitalElements): number {
  return (Math.atan2(el.hHat.x, el.hHat.z) * 180) / Math.PI;
}

function wrapDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

export function register(): void {
  const repeatDays = 7;
  const revsPerRepeat = 98;
  const sunRaanDeg = 40;

  test('earth-reference-orbits: dawn の昇交点は太陽方向から-90度、dusk は+90度', () => {
    const dawn = dawnDuskElements(repeatDays, revsPerRepeat, 'dawn', sunRaanDeg, EARTH)!;
    const dusk = dawnDuskElements(repeatDays, revsPerRepeat, 'dusk', sunRaanDeg, EARTH)!;
    assert.ok(dawn !== null && dusk !== null);
    const dawnDiff = wrapDeg(raanDegOf(dawn) - (sunRaanDeg - 90));
    const duskDiff = wrapDeg(raanDegOf(dusk) - (sunRaanDeg + 90));
    assert.ok(Math.min(dawnDiff, 360 - dawnDiff) < 1e-6, `dawn raan diff: ${dawnDiff}`);
    assert.ok(Math.min(duskDiff, 360 - duskDiff) < 1e-6, `dusk raan diff: ${duskDiff}`);
  });

  test('earth-reference-orbits: sunSyncRepeatGroundTrackElements は昇交点を0度に固定する', () => {
    const base = sunSyncRepeatGroundTrackElements(repeatDays, revsPerRepeat, EARTH)!;
    assert.ok(base !== null);
    assert.ok(Math.abs(wrapDeg(raanDegOf(base))) < 1e-6 || Math.abs(wrapDeg(raanDegOf(base)) - 360) < 1e-6);
  });
}
