// 天体定義の自転モデルの回帰テスト。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { spinRateOf } from '../../src/physics/celestial-motion';
import { CERES } from '../../src/physics/solar-system/dwarf-planets';
import { EARTH } from '../../src/physics/solar-system/earth-system';
import { VENUS } from '../../src/physics/solar-system/inner-planets';
import { URANUS } from '../../src/physics/solar-system/uranus-system';
import { SIDEREAL_DAY } from '../../src/physics/solar-system/constants';

export function register(): void {
  test('spinRateOf: 地球は 2π/恒星日', () => {
    const rate = spinRateOf(EARTH);
    assert.ok(rate !== null);
    assert.ok(Math.abs(rate - (2 * Math.PI) / SIDEREAL_DAY) / ((2 * Math.PI) / SIDEREAL_DAY) < 1e-12);
  });

  // 逆行自転は軸を反転せず角速度の符号で表す(spinRotationAt の規約)。
  test('spinRateOf: 逆行自転(金星・天王星)は負', () => {
    assert.ok(spinRateOf(VENUS)! < 0);
    assert.ok(spinRateOf(URANUS)! < 0);
  });

  test('spinRateOf: 自転モデルを持たない天体(ceres)は null', () => {
    assert.equal(spinRateOf(CERES), null);
  });
}
