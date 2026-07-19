// ephemeris.ts の回帰テスト: 太陽・月位置の距離・周期の基本性質(円軌道近似の理論値)。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import {
  MOON_DIST,
  SUN_DIST,
  moonPosition,
  sunPosition,
} from '../../src/physics/ephemeris';
import { len } from '../../src/physics/vec3';

const YEAR = 365.25636 * 86400;
const MOON_PERIOD = 27.321661 * 86400;

export function register(): void {
  test('ephemeris: sunPosition distance is always ~1 AU (circular ecliptic orbit)', () => {
    for (let i = 0; i < 8; i++) {
      const t = (i / 8) * YEAR;
      const p = sunPosition(t, 0);
      const d = len(p);
      assert.ok(Math.abs(d - SUN_DIST) / SUN_DIST < 1e-9, `sun distance at t=${t}: ${d}`);
    }
  });

  test('ephemeris: sunPosition is periodic with period = 1 year', () => {
    const p0 = sunPosition(12345, 0.4);
    const p1 = sunPosition(12345 + YEAR, 0.4);
    assert.ok(Math.abs(p0.x - p1.x) < 1, `x mismatch: ${p0.x} vs ${p1.x}`);
    assert.ok(Math.abs(p0.y - p1.y) < 1, `y mismatch: ${p0.y} vs ${p1.y}`);
    assert.ok(Math.abs(p0.z - p1.z) < 1, `z mismatch: ${p0.z} vs ${p1.z}`);
  });

  test('ephemeris: moonPosition distance stays close to mean distance (small eccentricity 0.0549)', () => {
    for (let i = 0; i < 12; i++) {
      const t = (i / 12) * MOON_PERIOD;
      const p = moonPosition(t, 0);
      const d = len(p);
      const relDev = Math.abs(d - MOON_DIST) / MOON_DIST;
      // e=0.0549 -> r ranges roughly within +-6% of mean distance
      assert.ok(relDev < 0.07, `moon distance deviation at t=${t}: ${relDev}`);
    }
  });

  test('ephemeris: moonPosition is approximately periodic over one sidereal month (node/perigee drift is slow)', () => {
    const p0 = moonPosition(50000, 0.2);
    const p1 = moonPosition(50000 + MOON_PERIOD, 0.2);
    const d0 = len(p0);
    const d1 = len(p1);
    // 昇交点(18.61年周期)・近地点(8.85年周期)の歳差により1恒星月では厳密には戻らないが、
    // 変化はごく小さい(距離で1%未満)。
    assert.ok(Math.abs(d0 - d1) / d0 < 0.01, `distance drift over 1 month: ${d0} vs ${d1}`);
  });
}
