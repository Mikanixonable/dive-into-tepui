// atmosphere.ts の回帰テスト: 密度テーブルの境界での連続性・非負性・単調減少性と、
// 高度が基準楕円体から測られること・大気を持たない天体では抗力が恒等的にゼロであること。
// テーブル値そのものはコード内の定数(理論値ではなく参照テーブル)なので、
// ここでは「実装の性質」(連続、非負、単調減少)を検証する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { Atmosphere, airspeed, atmosphericDensity, dragAccel, ellipsoidAltitude } from '../../src/physics/atmosphere';
import { EARTH_ATMOSPHERE } from '../../src/game/celestial/solar-system/earth-system';
import { len, v3 } from '../../src/math/vec3';

// ECI の極軸を自転軸とする地球の大気(CelestialMotion.at が組むのと同じ形)。
const EARTH: Atmosphere = { ...EARTH_ATMOSPHERE, pole: v3(0, 1, 0) };

const TABLE_ALTS_KM = [
  0, 25, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 180, 200,
  250, 300, 350, 400, 450, 500, 600, 700, 800, 900, 1000,
];

export function register(): void {
  test('atmosphere: density at sea level equals table row 0 (1.225 kg/m^3)', () => {
    assert.ok(Math.abs(atmosphericDensity(0, EARTH) - 1.225) < 1e-9);
  });

  test('atmosphere: negative altitude clamps to sea-level density (h=max(0,alt))', () => {
    assert.equal(atmosphericDensity(-1000, EARTH), atmosphericDensity(0, EARTH));
  });

  test('atmosphere: density is approximately continuous across every table boundary', () => {
    // 各行は独立した (h0, rho0, H) の指数フィットであり、行の切り替わり点で
    // 前行の外挿値と厳密には一致しない(テーブル自体が真に連続な関数ではない)。
    // 実測した最大の食い違いは 25km 境界で ~0.14%。それを上回るリグレッションを
    // 検知できるよう、緩めのマージン(0.5%)で固定する。
    for (const hKm of TABLE_ALTS_KM) {
      if (hKm === 0) continue;
      const eps = 1e-6; // km
      const below = atmosphericDensity((hKm - eps) * 1000, EARTH);
      const at = atmosphericDensity(hKm * 1000, EARTH);
      const above = atmosphericDensity((hKm + eps) * 1000, EARTH);
      const relDiffBelow = Math.abs(below - at) / at;
      const relDiffAbove = Math.abs(above - at) / at;
      assert.ok(
        relDiffBelow < 5e-3,
        `discontinuity approaching ${hKm}km from below: ${relDiffBelow}`,
      );
      assert.ok(
        relDiffAbove < 5e-3,
        `discontinuity approaching ${hKm}km from above: ${relDiffAbove}`,
      );
    }
  });

  test('atmosphere: density is non-negative and strictly decreasing from 0 to 2000km', () => {
    let prev = atmosphericDensity(0, EARTH);
    assert.ok(prev > 0);
    for (let hKm = 1; hKm <= 2000; hKm += 1) {
      const d = atmosphericDensity(hKm * 1000, EARTH);
      assert.ok(d >= 0, `density negative at ${hKm}km: ${d}`);
      assert.ok(d < prev, `density not strictly decreasing at ${hKm}km: ${d} >= ${prev}`);
      prev = d;
    }
  });

  test('atmosphere: extrapolation beyond 1000km uses the last row exponential (measured)', () => {
    // 1000km 超は最終区間(基準1000km, 3.019e-15, スケールハイト268km)の指数外挿。
    const d1500 = atmosphericDensity(1500e3, EARTH);
    const expected = 3.019e-15 * Math.exp(-(1500 - 1000) / 268.0);
    assert.ok(Math.abs(d1500 - expected) / expected < 1e-9, `d(1500km): ${d1500} vs ${expected}`);
  });

  test('atmosphere: altitude is measured from the reference ellipsoid, so the same true height gives the same density at any latitude', () => {
    // 真の高度 100km を、赤道・中緯度・極の3方向に置く。基準面が球(平均半径)なら
    // 高度が緯度で ±7〜−14km ずれ、密度が桁で変わってしまう。
    const alt = 100e3;
    const a = EARTH_ATMOSPHERE.equatorRadius;
    const b = EARTH_ATMOSPHERE.polarRadius;
    const points = [
      v3(a + alt, 0, 0), // 赤道
      v3(0, b + alt, 0), // 極
      v3(0, 0, a + alt), // 赤道(別経度)
    ];
    for (const r of points) {
      assert.ok(Math.abs(ellipsoidAltitude(r, EARTH) - alt) < 1e-6, `altitude at ${JSON.stringify(r)}`);
    }
    // 地心緯度 45° 方向も、楕円体の地心半径を足した位置なら同じ高度を返す。
    const s = Math.SQRT1_2;
    const rEll = (a * b) / Math.sqrt(a * a * s * s + b * b * s * s);
    const mid = v3((rEll + alt) * s, (rEll + alt) * s, 0);
    assert.ok(Math.abs(ellipsoidAltitude(mid, EARTH) - alt) < 1e-6);

    const rho = atmosphericDensity(alt, EARTH);
    for (const r of [...points, mid]) {
      assert.ok(Math.abs(atmosphericDensity(ellipsoidAltitude(r, EARTH), EARTH) - rho) / rho < 1e-9);
    }
  });

  test('atmosphere: a body without an atmosphere produces no drag at all', () => {
    // 大気を持たない天体は atmosphereAt が null になり、dragAccel まで到達しない。
    // ここではその手前の性質 — 大気があっても bcInv が 0 なら抗力はゼロ — と、
    // 大気があり bcInv が正なら実際に抗力が立つことの両方を固定する。
    const rLow = v3(EARTH_ATMOSPHERE.equatorRadius + 100e3, 0, 0);
    const v = v3(0, 0, 7800);
    assert.equal(len(dragAccel(rLow, v, 0, EARTH, 1)), 0);
    assert.ok(len(dragAccel(rLow, v, 3.3e-3, EARTH, 1)) > 0);
    // 大気の届かない高高度では、bcInv が正でも密度の下限で切られてゼロになる。
    assert.equal(len(dragAccel(v3(EARTH_ATMOSPHERE.equatorRadius + 3000e3, 0, 0), v, 3.3e-3, EARTH, 1)), 0);
  });

  test('atmosphere: 抗力が1ステップで奪う対気速度は、対気速度そのものを超えない', () => {
    // 抗力は対気速度を減らすだけで、反転させることはできない。刻みが抗力に対して広すぎるとき、
    // この上限を外すと陽的な積分が段どうしで増幅し合って1ステップで発散する。
    const rSurface = v3(EARTH_ATMOSPHERE.equatorRadius, 0, 0);
    const v = v3(0, 0, 7800);
    const speed = len(airspeed(rSurface, v, EARTH));
    for (const dt of [1e-3, 0.1, 1, 20, 204.8]) {
      const lost = len(dragAccel(rSurface, v, 3.3e-3, EARTH, dt)) * dt;
      assert.ok(lost <= speed * (1 + 1e-9), `dt=${dt}: 奪った量 ${lost} が対気速さ ${speed} を超えた`);
    }
  });

  test('atmosphere: 上限に触れない刻みでは、抗力は頭打ちの影響を受けない', () => {
    // 上限は刻みが既に広すぎるときだけ効く。効く前は dt を変えても加速度は変わらない。
    const rHigh = v3(EARTH_ATMOSPHERE.equatorRadius + 120e3, 0, 0);
    const v = v3(0, 0, 7800);
    const base = len(dragAccel(rHigh, v, 3.3e-3, EARTH, 1));
    assert.ok(base > 0);
    for (const dt of [1e-3, 0.1, 20, 204.8]) {
      assert.ok(Math.abs(len(dragAccel(rHigh, v, 3.3e-3, EARTH, dt)) - base) < base * 1e-12);
    }
  });
}
