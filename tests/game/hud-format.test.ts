import * as assert from 'node:assert/strict';
import { fmtDist, fmtDistParts, fmtSpeed, fmtSpeedParts } from '../../src/hud/utils';
import { worstAlarmLevel } from '../../src/hud/alarm-level';
import { test } from '../harness';

// HUD の値と単位の分け方(距離は m/km/Mm、速度は m/s・km/s の境界)と、段の重さの順を確かめる。
export function register(): void {
  // 単位境界の前後と、表示値・単位への分解結果を確認する。
  test('hud format: distance parts switch unit at 1 km and 1 Mm, and join back to fmtDist', () => {
    assert.deepEqual(fmtDistParts(420), { value: '420', unit: 'm' });
    assert.deepEqual(fmtDistParts(1000), { value: '1.00', unit: 'km' });
    assert.deepEqual(fmtDistParts(420_000), { value: '420.00', unit: 'km' });
    assert.deepEqual(fmtDistParts(1.5e6), { value: '1.50', unit: 'Mm' });
    assert.deepEqual(fmtDistParts(Number.NaN), { value: '---', unit: '' });
    for (const m of [420, 1000, 60_000, 384_400_000, Number.POSITIVE_INFINITY]) {
      const { value, unit } = fmtDistParts(m);
      assert.equal(fmtDist(m), unit === '' ? value : `${value} ${unit}`);
    }
  });

  test('hud format: speed parts switch unit at 1000 m/s', () => {
    assert.deepEqual(fmtSpeedParts(12.34), { value: '12.3', unit: 'm/s' });
    assert.deepEqual(fmtSpeedParts(-67.6), { value: '-67.6', unit: 'm/s' });
    assert.deepEqual(fmtSpeedParts(7660), { value: '7.66', unit: 'km/s' });
    assert.deepEqual(fmtSpeedParts(Number.NaN), { value: '---', unit: '' });
    assert.equal(fmtSpeed(7660), '7.66 km/s');
    assert.equal(fmtSpeed(Number.NaN), '---');
  });

  test('hud format: worst alarm level picks warning over caution over normal', () => {
    assert.equal(worstAlarmLevel(), 'normal');
    assert.equal(worstAlarmLevel('normal', 'normal'), 'normal');
    assert.equal(worstAlarmLevel('normal', 'caution'), 'caution');
    assert.equal(worstAlarmLevel('caution', 'warning', 'normal'), 'warning');
  });
}
