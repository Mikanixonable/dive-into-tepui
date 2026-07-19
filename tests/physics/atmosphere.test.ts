// atmosphere.ts の回帰テスト: 密度テーブルの境界での連続性・非負性・単調減少性。
// テーブル値そのものはコード内の定数(理論値ではなく参照テーブル)なので、
// ここでは「実装の性質」(連続、非負、単調減少)を検証する。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { atmosphericDensity } from '../../src/physics/atmosphere';

const TABLE_ALTS_KM = [
  0, 25, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 180, 200,
  250, 300, 350, 400, 450, 500, 600, 700, 800, 900, 1000,
];

export function register(): void {
  test('atmosphere: density at sea level equals table row 0 (1.225 kg/m^3)', () => {
    assert.ok(Math.abs(atmosphericDensity(0) - 1.225) < 1e-9);
  });

  test('atmosphere: negative altitude clamps to sea-level density (h=max(0,alt))', () => {
    assert.equal(atmosphericDensity(-1000), atmosphericDensity(0));
  });

  test('atmosphere: density is approximately continuous across every table boundary', () => {
    // 各行は独立した (h0, rho0, H) の指数フィットであり、行の切り替わり点で
    // 前行の外挿値と厳密には一致しない(テーブル自体が真に連続な関数ではない)。
    // 実測した最大の食い違いは 25km 境界で ~0.14%。それを上回るリグレッションを
    // 検知できるよう、緩めのマージン(0.5%)で固定する。
    for (const hKm of TABLE_ALTS_KM) {
      if (hKm === 0) continue;
      const eps = 1e-6; // km
      const below = atmosphericDensity((hKm - eps) * 1000);
      const at = atmosphericDensity(hKm * 1000);
      const above = atmosphericDensity((hKm + eps) * 1000);
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
    let prev = atmosphericDensity(0);
    assert.ok(prev > 0);
    for (let hKm = 1; hKm <= 2000; hKm += 1) {
      const d = atmosphericDensity(hKm * 1000);
      assert.ok(d >= 0, `density negative at ${hKm}km: ${d}`);
      assert.ok(d < prev, `density not strictly decreasing at ${hKm}km: ${d} >= ${prev}`);
      prev = d;
    }
  });

  test('atmosphere: extrapolation beyond 1000km uses the last row exponential (measured)', () => {
    // 1000km 超は最終区間(基準1000km, 3.019e-15, スケールハイト268km)の指数外挿。
    const d1500 = atmosphericDensity(1500e3);
    const expected = 3.019e-15 * Math.exp(-(1500 - 1000) / 268.0);
    assert.ok(Math.abs(d1500 - expected) / expected < 1e-9, `d(1500km): ${d1500} vs ${expected}`);
  });
}
