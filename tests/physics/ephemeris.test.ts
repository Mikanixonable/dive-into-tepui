// ephemeris.ts の回帰テスト: 太陽・月位置の距離・周期の基本性質(円軌道近似の理論値)。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import {
  FrameRotation,
  MOON_DIST,
  MU_SUN,
  SUN_DIST,
  emLagrangePoints,
  moonOrbitNormal,
  moonOrbitRotation,
  moonPosition,
  seLagrangePoints,
  sunOrbitRotation,
  sunPosition,
} from '../../src/physics/ephemeris';
import { qRotate } from '../../src/physics/attitude';
import { MU_EARTH } from '../../src/physics/orbital';
import { Vec3, cross, dot, len, norm, scale, sub, v3 } from '../../src/physics/vec3';

const YEAR = 365.25636 * 86400;
const MOON_PERIOD = 27.321661 * 86400;
const NODE_PERIOD = 18.612958 * 365.25 * 86400;
const EPS = (23.439291 * Math.PI) / 180; // 黄道傾斜角
// 黄道極を ECI で表したもの = 春分点 × 夏至点方向 = (1,0,0) × (0, sinEPS, −cosEPS)。
// 赤道の極軸(+Y)から黄道傾斜ぶん傾く。
const ECL_POLE_ECI = v3(0, Math.cos(EPS), Math.sin(EPS));

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

  test('ephemeris: sunOrbitRotation の姿勢は x̂ を太陽方向・ẑ を黄道法線へ移す', () => {
    // 黄道法線は赤道の極軸(+Y)から黄道傾斜ぶん傾く。極軸まわりの回転として組んでいたら
    // ẑ の像が +Y のままになり、この検査で落ちる。
    for (const t of [0, 1e6, 1e7, 3e8]) {
      const { q } = sunOrbitRotation(t, 0.3);
      assert.ok(len(sub(qRotate(q, v3(1, 0, 0)), norm(sunPosition(t, 0.3)))) < 1e-12, `x̂ の像 (t=${t})`);
      assert.ok(len(sub(qRotate(q, v3(0, 0, 1)), ECL_POLE_ECI)) < 1e-12, `ẑ の像 (t=${t})`);
    }
  });

  test('ephemeris: sunOrbitRotation の角速度は基底の時間微分に一致する(有限差分)', () => {
    for (const t of [0, YEAR / 8, YEAR / 3]) {
      assertOmegaMatchesBasis((s) => sunOrbitRotation(s, 0.3), t, 600);
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

  test('ephemeris: 地球-月ラグランジュ点は白道面内で月に対し所定の配置になる', () => {
    for (const t of [0, 1e6, 1e8, 3e9]) {
      const { L1, L2, L3, L4, L5 } = emLagrangePoints(t, 0.4);
      const mPos = moonPosition(t, 0.4);
      const R = len(mPos);
      const mHat = norm(mPos);
      const n = moonOrbitNormal(t, 0.4);
      for (const [name, p] of [['L1', L1], ['L2', L2], ['L3', L3], ['L4', L4], ['L5', L5]] as const) {
        assert.ok(Math.abs(dot(p, n)) < 1e-6 * R, `${name} が白道面から外れる (t=${t}): ${dot(p, n)}`);
      }
      // L1/L2 は月の内側/外側で月から等距離、L3 は反対側
      assert.ok(len(L1) < R && len(L2) > R, `L1/L2 の内外 (t=${t})`);
      assert.ok(Math.abs(len(sub(L1, mPos)) - len(sub(L2, mPos))) < 1e-6 * R, `L1/L2 が月から等距離でない (t=${t})`);
      assert.ok(dot(norm(L3), mHat) < -0.999999, `L3 が反月方向でない (t=${t})`);
      // L4/L5 は月と正三角形をなし、公転前方/後方に 60°
      const lead = cross(n, mHat); // 公転前方
      for (const [name, p, sign] of [['L4', L4, 1], ['L5', L5, -1]] as const) {
        assert.ok(Math.abs(len(p) - R) < 1e-6 * R, `${name} の軌道半径 (t=${t}): ${len(p)}`);
        assert.ok(Math.abs(len(sub(p, mPos)) - R) < 1e-6 * R, `${name} と月の距離 (t=${t}): ${len(sub(p, mPos))}`);
        assert.ok(sign * dot(norm(p), lead) > 0, `${name} の前後 (t=${t})`);
      }
    }
  });

  test('ephemeris: 太陽-地球ラグランジュ点は黄道面内で地球・太陽に対し所定の配置になる', () => {
    // 地球はこの系では副天体なので、地心を原点とする ECI での配置は地球-月系と別物になる:
    // L1/L2 は地球のすぐ両隣(ヒル半径 ≈ 150万 km)、L3 は太陽の向こう側(地心から約 2 au)、
    // L4/L5 は太陽・地球と正三角形をなすので地心から 1 au。
    const mu = MU_EARTH / (MU_SUN + MU_EARTH);
    const hill = SUN_DIST * Math.cbrt(mu / 3);
    for (const t of [0, 1e7, 1e9]) {
      const sPos = sunPosition(t, 0.3);
      const sHat = norm(sPos);
      const { L1, L2, L3, L4, L5 } = seLagrangePoints(t, 0.3);
      for (const [name, p] of [['L1', L1], ['L2', L2], ['L3', L3], ['L4', L4], ['L5', L5]] as const) {
        assert.ok(Math.abs(dot(p, ECL_POLE_ECI)) < 1e-6 * SUN_DIST, `${name} が黄道面から外れる (t=${t})`);
      }
      assert.ok(len(sub(L1, scale(sHat, hill))) < 1e-6 * hill, `L1 (t=${t}): ${JSON.stringify(L1)}`);
      assert.ok(len(sub(L2, scale(sHat, -hill))) < 1e-6 * hill, `L2 (t=${t}): ${JSON.stringify(L2)}`);
      const l3Expect = scale(sHat, SUN_DIST * (2 + (5 / 12) * mu));
      assert.ok(len(sub(L3, l3Expect)) < 1e-6 * SUN_DIST, `L3 (t=${t}): ${JSON.stringify(L3)}`);
      // 地球の公転前方 = 太陽の見かけの運動と逆向き。L4 が前方、L5 が後方。
      const lead = cross(sHat, ECL_POLE_ECI);
      for (const [name, p, sign] of [['L4', L4, 1], ['L5', L5, -1]] as const) {
        assert.ok(Math.abs(len(p) - SUN_DIST) < 1e-6 * SUN_DIST, `${name} の地心距離 (t=${t}): ${len(p)}`);
        assert.ok(Math.abs(len(sub(p, sPos)) - SUN_DIST) < 1e-6 * SUN_DIST, `${name} の日心距離 (t=${t})`);
        assert.ok(sign * dot(norm(p), lead) > 0, `${name} の前後 (t=${t})`);
      }
    }
  });

  test('ephemeris: moonOrbitRotation の角速度は基底の時間微分に一致する(有限差分)', () => {
    // 昇交点歳差ぶん(黄道極まわり)を落とすとここで落ちる。
    for (const t of [0, 1e6, 1e8]) {
      assertOmegaMatchesBasis((s) => moonOrbitRotation(s, 0.4), t, 20);
    }
  });
}

// 回転基準系の角速度が姿勢の時間微分と整合するか(基底の各軸で ḃ = ω×b)を中心差分で確かめる。
function assertOmegaMatchesBasis(rot: (t: number) => FrameRotation, t: number, dt: number): void {
  const { omega } = rot(t);
  for (const axis of [v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1)]) {
    const at = (s: number): Vec3 => qRotate(rot(s).q, axis);
    const fd = scale(sub(at(t + dt), at(t - dt)), 1 / (2 * dt));
    const analytic = cross(omega, at(t));
    assert.ok(
      len(sub(fd, analytic)) < 1e-4 * len(omega),
      `角速度の不一致 (t=${t}, axis=${JSON.stringify(axis)}): ${JSON.stringify(fd)} vs ${JSON.stringify(analytic)}`,
    );
  }
}

// ECI(Y=北極)の位置から黄経を取り出す。標準赤道座標へ戻し、黄道傾斜ぶん回してから
// 黄道面内の偏角を測る。
function eclipticLongitude(p: { x: number; y: number; z: number }): number {
  const xs = p.x;
  const ys = -p.z;
  const zs = p.y;
  return Math.atan2(ys * Math.cos(EPS) + zs * Math.sin(EPS), xs);
}
