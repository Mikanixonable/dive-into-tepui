// solar-system.ts の回帰テスト。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { SIDEREAL_DAY, SOLAR_SYSTEM, bodyDef, spinRateOf } from '../../src/physics/solar-system';

export function register(): void {
  test('spinRateOf: 地球は 2π/恒星日', () => {
    const rate = spinRateOf(bodyDef(SOLAR_SYSTEM, 'earth'));
    assert.ok(rate !== null);
    assert.ok(Math.abs(rate - (2 * Math.PI) / SIDEREAL_DAY) / ((2 * Math.PI) / SIDEREAL_DAY) < 1e-12);
  });

  // 逆行自転は軸を反転せず角速度の符号で表す(ephemeris.spinRotationAt の規約)。
  test('spinRateOf: 逆行自転(金星・天王星)は負', () => {
    assert.ok(spinRateOf(bodyDef(SOLAR_SYSTEM, 'venus'))! < 0);
    assert.ok(spinRateOf(bodyDef(SOLAR_SYSTEM, 'uranus'))! < 0);
  });

  test('spinRateOf: 自転モデルを持たない天体(ceres)は null', () => {
    assert.equal(spinRateOf(bodyDef(SOLAR_SYSTEM, 'ceres')), null);
  });
}
