// ephemeris.ts の回帰テスト: 太陽・月位置の距離・周期の基本性質(円軌道近似の理論値)。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import {
  MOON_DIST,
  SUN_DIST,
  moonOrbitNormal,
  moonOrbitRotation,
  moonPosition,
  sunAzimuth,
  sunAzimuthRate,
  sunPosition,
} from '../../src/physics/ephemeris';
import { qRotate } from '../../src/physics/attitude';
import { cross, dot, len, norm, scale, sub, v3 } from '../../src/physics/vec3';

const YEAR = 365.25636 * 86400;
const MOON_PERIOD = 27.321661 * 86400;
const NODE_PERIOD = 18.612958 * 365.25 * 86400;

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

  test('ephemeris: sunAzimuthRate matches central finite difference of sunAzimuth', () => {
    const phase0 = 0.3;
    const dt = 60;
    // branch cut(±π)を避けた時刻で比較
    for (const t of [0, YEAR / 8, YEAR / 4, (3 * YEAR) / 8]) {
      const fd = (sunAzimuth(t + dt, phase0) - sunAzimuth(t - dt, phase0)) / (2 * dt);
      const analytic = sunAzimuthRate(t, phase0);
      assert.ok(
        Math.abs(fd - analytic) <= 1e-5 * Math.abs(analytic),
        `rate at t=${t}: analytic ${analytic} vs fd ${fd}`,
      );
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

  test('ephemeris: moonPosition の黄経は恒星月の平均運動で進む(歳差ぶんの遅速がない)', () => {
    // 平均黄経は 2π t / MOON_PERIOD で進み、実際の黄経との差は中心差(最大 ~2e = 6.3°)の
    // 振動だけになるはず。昇交点・近地点の歳差を平均黄経に混ぜると、この差が年オーダーで
    // 単調に開いていく(1年で -19° 級)ため、長期の時間加速で月とラグランジュ点が実位置から外れる。
    const maxCenterDeg = (2 * 0.0549 * 180) / Math.PI + 0.5; // 中心差の振幅 + 余裕
    for (const days of [27.321661, 365.25, 3652.5]) {
      const t = days * 86400;
      const mean = (2 * Math.PI * t) / MOON_PERIOD;
      let lon = eclipticLongitude(moonPosition(t, 0));
      lon += 2 * Math.PI * Math.round((mean - lon) / (2 * Math.PI)); // mean に最も近い分枝へ
      const errDeg = ((lon - mean) * 180) / Math.PI;
      assert.ok(Math.abs(errDeg) < maxCenterDeg, `黄経の平均運動からのずれ (t=${days}日): ${errDeg}°`);
    }
  });

  test('ephemeris: moonOrbitNormal は月の位置ベクトルと直交する', () => {
    for (let i = 0; i < 12; i++) {
      const t = (i / 12) * MOON_PERIOD * 7.3; // 昇交点歳差も混ざるよう非整数倍で刻む
      const c = dot(moonOrbitNormal(t, 0.7), norm(moonPosition(t, 0.7)));
      assert.ok(Math.abs(c) < 1e-12, `法線と月方向の内積 (t=${t}): ${c}`);
    }
  });

  test('ephemeris: 白道の赤道傾斜は昇交点歳差で 18.3°〜28.6° を掃く(黄道 23.44° ± 白道 5.145°)', () => {
    let minDeg = 180;
    let maxDeg = 0;
    for (let i = 0; i < 64; i++) {
      const n = moonOrbitNormal((i / 64) * NODE_PERIOD, 0);
      const deg = (Math.acos(Math.max(-1, Math.min(1, dot(n, v3(0, 1, 0))))) * 180) / Math.PI;
      minDeg = Math.min(minDeg, deg);
      maxDeg = Math.max(maxDeg, deg);
    }
    assert.ok(Math.abs(minDeg - 18.294) < 0.1, `最小傾斜: ${minDeg}°`);
    assert.ok(Math.abs(maxDeg - 28.584) < 0.1, `最大傾斜: ${maxDeg}°`);
  });

  test('ephemeris: moonOrbitRotation の姿勢は x̂ を月方向・ẑ を白道法線へ移す', () => {
    for (const t of [0, 1e5, 1e7, 1e9]) {
      const { q } = moonOrbitRotation(t, 0.4);
      const x = qRotate(q, v3(1, 0, 0));
      const z = qRotate(q, v3(0, 0, 1));
      assert.ok(len(sub(x, norm(moonPosition(t, 0.4)))) < 1e-12, `x̂ の像 (t=${t}): ${JSON.stringify(x)}`);
      assert.ok(len(sub(z, moonOrbitNormal(t, 0.4))) < 1e-12, `ẑ の像 (t=${t}): ${JSON.stringify(z)}`);
    }
  });

  test('ephemeris: moonOrbitRotation の角速度は基底の時間微分に一致する(有限差分)', () => {
    const dt = 20;
    for (const t of [0, 1e6, 1e8]) {
      const { omega } = moonOrbitRotation(t, 0.4);
      // 基底の各軸について ḃ = ω×b が成り立つか(昇交点歳差ぶんも含めた検証になる)
      for (const axis of [v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1)]) {
        const at = (s: number) => qRotate(moonOrbitRotation(s, 0.4).q, axis);
        const fd = scale(sub(at(t + dt), at(t - dt)), 1 / (2 * dt));
        const analytic = cross(omega, at(t));
        assert.ok(
          len(sub(fd, analytic)) < 1e-4 * len(omega),
          `角速度の不一致 (t=${t}, axis=${JSON.stringify(axis)}): ${JSON.stringify(fd)} vs ${JSON.stringify(analytic)}`,
        );
      }
    }
  });
}

// ゲーム ECI(Y=北極)の位置から黄経を取り出す。stdToGame の逆変換で標準赤道座標へ戻し、
// 黄道傾斜ぶん回してから黄道面内の偏角を測る。
function eclipticLongitude(p: { x: number; y: number; z: number }): number {
  const EPS = (23.439291 * Math.PI) / 180;
  const xs = p.x;
  const ys = -p.z;
  const zs = p.y;
  return Math.atan2(ys * Math.cos(EPS) + zs * Math.sin(EPS), xs);
}
