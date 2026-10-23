import * as assert from 'node:assert/strict';
import {
  ammoAlarmLevel, armorAlarmLevel, dynamicPressureAlarmLevel, fuelAlarmLevel, temperatureAlarmLevel,
} from '../../src/game/alarm/alarm-level';
import { MAG_ROUNDS } from '../../src/game/player/ammo-spec';
import { MAX_DYN_PRESSURE } from '../../src/game/player/aero-load';
import { test } from '../harness';

// FLIGHT.md「警報の条件」の閾値と、境界値の扱い(達したとき)を確かめる。
export function register(): void {
  test('alarm level: temperature is caution at 70% and warning at 90% of the limit', () => {
    const max = 1000;
    assert.equal(temperatureAlarmLevel(0, max), 'normal');
    assert.equal(temperatureAlarmLevel(699, max), 'normal');
    assert.equal(temperatureAlarmLevel(700, max), 'caution');
    assert.equal(temperatureAlarmLevel(899, max), 'caution');
    assert.equal(temperatureAlarmLevel(900, max), 'warning');
    assert.equal(temperatureAlarmLevel(1500, max), 'warning');
  });

  test('alarm level: dynamic pressure is caution at 50% and warning at 80% of the limit', () => {
    assert.equal(dynamicPressureAlarmLevel(0, MAX_DYN_PRESSURE), 'normal');
    assert.equal(dynamicPressureAlarmLevel(MAX_DYN_PRESSURE * 0.49, MAX_DYN_PRESSURE), 'normal');
    assert.equal(dynamicPressureAlarmLevel(MAX_DYN_PRESSURE * 0.5, MAX_DYN_PRESSURE), 'caution');
    assert.equal(dynamicPressureAlarmLevel(MAX_DYN_PRESSURE * 0.79, MAX_DYN_PRESSURE), 'caution');
    assert.equal(dynamicPressureAlarmLevel(MAX_DYN_PRESSURE * 0.8, MAX_DYN_PRESSURE), 'warning');
  });

  test('alarm level: fuel is caution at 20% and warning at 5% of a full load, a full tank is normal', () => {
    const max = 1000;
    assert.equal(fuelAlarmLevel(1000, max), 'normal');
    assert.equal(fuelAlarmLevel(201, max), 'normal');
    assert.equal(fuelAlarmLevel(200, max), 'caution');
    assert.equal(fuelAlarmLevel(51, max), 'caution');
    assert.equal(fuelAlarmLevel(50, max), 'warning');
    assert.equal(fuelAlarmLevel(0, max), 'warning');
  });

  test('alarm level: a vessel without fuel or limits is never alarmed', () => {
    assert.equal(fuelAlarmLevel(0, 0), 'normal');
    assert.equal(temperatureAlarmLevel(500, 0), 'normal');
    assert.equal(dynamicPressureAlarmLevel(500, 0), 'normal');
    assert.equal(armorAlarmLevel(0, 0), 'normal');
  });

  test('alarm level: ammo is normal at a full load, caution at one spare magazine, warning when empty', () => {
    // 40/40 の装填済みと予備の弾倉 2 本が、開始時の満載。
    assert.equal(ammoAlarmLevel(MAG_ROUNDS, 2), 'normal');
    assert.equal(ammoAlarmLevel(MAG_ROUNDS, 7), 'normal');
    assert.equal(ammoAlarmLevel(MAG_ROUNDS, 1), 'caution');
    assert.equal(ammoAlarmLevel(0, 1), 'caution');
    assert.equal(ammoAlarmLevel(MAG_ROUNDS, 0), 'caution');
    assert.equal(ammoAlarmLevel(1, 0), 'caution');
    assert.equal(ammoAlarmLevel(0, 0), 'warning');
  });

  test('alarm level: armor is warning at 30% or less and has no caution step', () => {
    assert.equal(armorAlarmLevel(100, 100), 'normal');
    assert.equal(armorAlarmLevel(31, 100), 'normal');
    assert.equal(armorAlarmLevel(30, 100), 'warning');
    assert.equal(armorAlarmLevel(0, 100), 'warning');
  });
}
