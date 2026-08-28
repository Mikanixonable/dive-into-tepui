// earth-reference-orbits.ts の回帰テスト。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { dawnDuskElements, sunSyncRepeatGroundTrackElements } from '../../src/physics/earth-reference-orbits';
import { OrbitalElements } from '../../src/physics/elements';

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
    const dawn = dawnDuskElements(repeatDays, revsPerRepeat, 'dawn', sunRaanDeg)!;
    const dusk = dawnDuskElements(repeatDays, revsPerRepeat, 'dusk', sunRaanDeg)!;
    assert.ok(dawn !== null && dusk !== null);
    const dawnDiff = wrapDeg(raanDegOf(dawn) - (sunRaanDeg - 90));
    const duskDiff = wrapDeg(raanDegOf(dusk) - (sunRaanDeg + 90));
    assert.ok(Math.min(dawnDiff, 360 - dawnDiff) < 1e-6, `dawn raan diff: ${dawnDiff}`);
    assert.ok(Math.min(duskDiff, 360 - duskDiff) < 1e-6, `dusk raan diff: ${duskDiff}`);
  });

  test('earth-reference-orbits: sunSyncRepeatGroundTrackElements は昇交点を0度に固定する', () => {
    const base = sunSyncRepeatGroundTrackElements(repeatDays, revsPerRepeat)!;
    assert.ok(base !== null);
    assert.ok(Math.abs(wrapDeg(raanDegOf(base))) < 1e-6 || Math.abs(wrapDeg(raanDegOf(base)) - 360) < 1e-6);
  });
}
