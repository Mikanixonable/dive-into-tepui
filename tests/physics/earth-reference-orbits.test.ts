// earth-reference-orbits.ts の回帰テスト。
import { fixedMotion } from './test-helpers';
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  dawnDuskElements, molniyaElements, sunSyncRepeatGroundTrackElements, sunSyncRevsPerDayRange, tundraElements,
} from '../../src/physics/earth-reference-orbits';
import { CelestialMotion } from '../../src/physics/celestial-motion';
import { ECI_POLE } from '../../src/physics/ecliptic';
import { kinematicState } from '../../src/physics/kinematic-state';
import { OrbitalElements } from '../../src/physics/elements';
import { J2_EARTH, MU_EARTH, R_EARTH_EQ, SIDEREAL_DAY } from '../../src/game/celestial/solar-system/constants';
import { v3 } from '../../src/math/vec3';

// 中心天体。昇交点の向きだけを見るので、原点に静止した地球で足りる。
const EARTH: CelestialMotion = fixedMotion({
  id: 'earth', mu: MU_EARTH, radius: R_EARTH_EQ,
  state: kinematicState<'eci'>(0, v3(), v3()), accel: v3(),
  degree2: { j2: J2_EARTH, refRadius: R_EARTH_EQ, pole: ECI_POLE, tesseral: null },
  atmosphere: null,
});

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
    const dawn = dawnDuskElements(repeatDays, revsPerRepeat, 'dawn', sunRaanDeg, EARTH, 0)!;
    const dusk = dawnDuskElements(repeatDays, revsPerRepeat, 'dusk', sunRaanDeg, EARTH, 0)!;
    assert.ok(dawn !== null && dusk !== null);
    const dawnDiff = wrapDeg(raanDegOf(dawn) - (sunRaanDeg - 90));
    const duskDiff = wrapDeg(raanDegOf(dusk) - (sunRaanDeg + 90));
    assert.ok(Math.min(dawnDiff, 360 - dawnDiff) < 1e-6, `dawn raan diff: ${dawnDiff}`);
    assert.ok(Math.min(duskDiff, 360 - duskDiff) < 1e-6, `dusk raan diff: ${duskDiff}`);
  });

  test('earth-reference-orbits: sunSyncRepeatGroundTrackElements は昇交点を0度に固定する', () => {
    const base = sunSyncRepeatGroundTrackElements(repeatDays, revsPerRepeat, EARTH, 0)!;
    assert.ok(base !== null);
    assert.ok(Math.abs(wrapDeg(raanDegOf(base))) < 1e-6 || Math.abs(wrapDeg(raanDegOf(base)) - 360) < 1e-6);
  });

  test('earth-reference-orbits: 太陽同期の回帰運動へ J2 の平均運動補正を含める', () => {
    const elements = sunSyncRepeatGroundTrackElements(repeatDays, revsPerRepeat, EARTH, 0)!;
    assert.ok(elements !== null);
    const requestedN = (revsPerRepeat * 2 * Math.PI) / (repeatDays * 86400);
    const keplerA = Math.cbrt(MU_EARTH / (requestedN * requestedN));
    assert.ok(elements.a < keplerA, `J2 correction should adjust a: ${elements.a} vs ${keplerA}`);

    const nKepler = Math.sqrt(MU_EARTH / elements.a ** 3);
    const cosInc = Math.cos((elements.incDeg * Math.PI) / 180);
    const correctedN = nKepler * (1 + 0.75 * J2_EARTH * (R_EARTH_EQ / elements.a) ** 2 * (3 * cosInc ** 2 - 1));
    assert.ok(Math.abs(correctedN - requestedN) / requestedN < 1e-12, 'the corrected mean motion should match the requested repeat rate');
  });

  test('earth-reference-orbits: molniya と tundra は周期・臨界傾斜角・近地点高度を保つ', () => {
    const perigeeAltitude = 600e3;
    const expectedIncDeg = (Math.acos(1 / Math.sqrt(5)) * 180) / Math.PI;
    for (const [name, elements, expectedPeriod] of [
      ['molniya', molniyaElements(perigeeAltitude, 30, EARTH, 0, SIDEREAL_DAY), SIDEREAL_DAY / 2],
      ['tundra', tundraElements(perigeeAltitude, 30, EARTH, 0, SIDEREAL_DAY), SIDEREAL_DAY],
    ] as const) {
      const expectedA = Math.cbrt((MU_EARTH * expectedPeriod ** 2) / (4 * Math.PI ** 2));
      const expectedE = 1 - (R_EARTH_EQ + perigeeAltitude) / expectedA;
      assert.ok(Math.abs(elements.period - expectedPeriod) / expectedPeriod < 1e-12, `${name} period`);
      assert.ok(Math.abs(elements.incDeg - expectedIncDeg) < 1e-12, `${name} critical inclination`);
      assert.ok(Math.abs(elements.e - expectedE) < 1e-12, `${name} eccentricity`);
    }
  });

  test('earth-reference-orbits: 太陽同期軌道の成立境界は公開APIの範囲と一致する', () => {
    const range = sunSyncRevsPerDayRange(MU_EARTH, R_EARTH_EQ, J2_EARTH);
    const lowerOutside = Math.floor(range.min);
    const lowerInside = lowerOutside + 1;
    const upperInside = Math.floor(range.max);
    const upperOutside = upperInside + 1;
    assert.equal(
      sunSyncRepeatGroundTrackElements(1, lowerOutside, EARTH, 0), null, 'below the inclination boundary');
    assert.notEqual(sunSyncRepeatGroundTrackElements(1, lowerInside, EARTH, 0), null, 'inside the valid range');
    assert.notEqual(sunSyncRepeatGroundTrackElements(1, upperInside, EARTH, 0), null, 'below the surface boundary');
    assert.equal(
      sunSyncRepeatGroundTrackElements(1, upperOutside, EARTH, 0), null, 'at or below the surface');
    assert.ok(range.min > lowerOutside && range.min < lowerInside, 'minimum should lie between adjacent integer rates');
    assert.ok(range.max > upperInside && range.max < upperOutside, 'maximum should lie between adjacent integer rates');
  });

  test(
    'earth-reference-orbits: 太陽同期軌道は J2なし・地表以下・実数解なしで成立しない', () => {
    const noJ2 = fixedMotion({
      id: 'earth-no-j2', mu: MU_EARTH, radius: R_EARTH_EQ, state: kinematicState<'eci'>(0, v3(), v3()),
      accel: v3(), degree2: null, atmosphere: null,
    });
    assert.equal(sunSyncRepeatGroundTrackElements(7, 98, noJ2, 0), null, 'J2 is required');
    assert.equal(sunSyncRepeatGroundTrackElements(1, 18, EARTH, 0), null, 'the orbit must clear the surface');
    assert.equal(
      sunSyncRepeatGroundTrackElements(1, 6, EARTH, 0), null, 'the inclination equation must have a real solution');
  });
}
