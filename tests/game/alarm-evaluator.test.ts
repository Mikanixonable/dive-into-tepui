import * as assert from 'node:assert/strict';
import { AlarmEvaluator, type AlarmMeasurements } from '../../src/game/alarm/alarm-evaluator';
import {
  altitudeAlarmLevel, dynamicPressureAlarmLevel, fuelAlarmLevel, temperatureAlarmLevel,
} from '../../src/game/alarm/alarm-level';
import { test } from '../harness';

const MAX_TEMP = 1000;
const MAX_Q = 1000;
const MAX_FUEL = 1000;

// 全項目が平常の測定値。必要な項目だけ上書きして使う。
function calm(overrides: Partial<AlarmMeasurements> = {}): AlarmMeasurements {
  return {
    temperatureK: 300, maxTemperatureK: MAX_TEMP,
    dynamicPressurePa: 0, maxDynamicPressurePa: MAX_Q,
    fuel: MAX_FUEL, maxFuel: MAX_FUEL,
    ammo: { roundsInMag: 40, magsLeft: 2 },
    altitude: { meters: 420e3, descentRateMps: 0, descending: false },
    ...overrides,
  };
}

// 平常の測定値で評価器を1度回し、最初の測定値を引き継ぎ済みにした評価器を返す。
function adoptedEvaluator(): AlarmEvaluator {
  const evaluator = new AlarmEvaluator();
  evaluator.update(0, calm());
  return evaluator;
}

// FLIGHT.md「警報の条件」の入る閾値と、入る閾値と戻る閾値を分けて境界で明滅しない規則を確かめる。
export function register(): void {
  test('alarm level: hysteresis keeps temperature until the leave ratio and demotes stepwise', () => {
    assert.equal(temperatureAlarmLevel(700, MAX_TEMP, 'normal'), 'caution');
    assert.equal(temperatureAlarmLevel(650, MAX_TEMP, 'caution'), 'caution');
    assert.equal(temperatureAlarmLevel(650, MAX_TEMP, 'normal'), 'normal');
    assert.equal(temperatureAlarmLevel(619, MAX_TEMP, 'caution'), 'normal');
    assert.equal(temperatureAlarmLevel(850, MAX_TEMP, 'warning'), 'warning');
    assert.equal(temperatureAlarmLevel(850, MAX_TEMP, 'caution'), 'caution');
    assert.equal(temperatureAlarmLevel(810, MAX_TEMP, 'warning'), 'caution');
    assert.equal(temperatureAlarmLevel(900, MAX_TEMP, 'caution'), 'warning');
  });

  test('alarm level: hysteresis for dynamic pressure and fuel', () => {
    assert.equal(dynamicPressureAlarmLevel(450, MAX_Q, 'caution'), 'caution');
    assert.equal(dynamicPressureAlarmLevel(399, MAX_Q, 'caution'), 'normal');
    assert.equal(dynamicPressureAlarmLevel(750, MAX_Q, 'warning'), 'warning');
    assert.equal(dynamicPressureAlarmLevel(699, MAX_Q, 'warning'), 'caution');
    assert.equal(fuelAlarmLevel(220, MAX_FUEL, 'caution'), 'caution');
    assert.equal(fuelAlarmLevel(250, MAX_FUEL, 'caution'), 'normal');
    assert.equal(fuelAlarmLevel(70, MAX_FUEL, 'warning'), 'warning');
    assert.equal(fuelAlarmLevel(80, MAX_FUEL, 'warning'), 'caution');
  });

  test('alarm level: altitude is caution below 120 km or while descending, warning below 80 km', () => {
    assert.equal(altitudeAlarmLevel(130e3, false, 'normal'), 'normal');
    assert.equal(altitudeAlarmLevel(119e3, false, 'normal'), 'caution');
    assert.equal(altitudeAlarmLevel(300e3, true, 'normal'), 'caution');
    assert.equal(altitudeAlarmLevel(79e3, false, 'normal'), 'warning');
    // 戻る閾値は 125 km と 85 km。
    assert.equal(altitudeAlarmLevel(122e3, false, 'caution'), 'caution');
    assert.equal(altitudeAlarmLevel(126e3, false, 'caution'), 'normal');
    assert.equal(altitudeAlarmLevel(83e3, false, 'warning'), 'warning');
    assert.equal(altitudeAlarmLevel(86e3, false, 'warning'), 'caution');
  });

  test('alarm evaluator: a calm start shows no alarm and no sound', () => {
    const evaluator = adoptedEvaluator();
    assert.deepEqual(evaluator.alarms, []);
    assert.equal(evaluator.sound, null);
    assert.equal(evaluator.cautionCount, 0);
    assert.equal(evaluator.warningCount, 0);
  });

  test('alarm evaluator: an alarm does not flicker around its enter threshold', () => {
    const evaluator = adoptedEvaluator();
    const levels: string[] = [];
    // 70% の境界を挟んで揺れる温度。
    for (const [i, temperatureK] of [690, 705, 695, 710, 640, 700, 610].entries()) {
      evaluator.update(100 + i, calm({ temperatureK }));
      levels.push(evaluator.levelOf('temperature'));
    }
    assert.deepEqual(levels, ['normal', 'caution', 'caution', 'caution', 'caution', 'caution', 'normal']);
  });

  test('alarm evaluator: a new warning is unacknowledged and sounds, acknowledging keeps it until the condition clears', () => {
    const evaluator = adoptedEvaluator();
    evaluator.update(100, calm({ temperatureK: 950 }));
    assert.equal(evaluator.warningCount, 1);
    assert.equal(evaluator.hasUnacknowledgedWarning, true);
    assert.equal(evaluator.sound, 'warning');

    evaluator.acknowledge();
    assert.equal(evaluator.hasUnacknowledgedWarning, false);
    assert.equal(evaluator.alarms[0]?.acknowledged, true);
    evaluator.update(200, calm({ temperatureK: 950 }));
    assert.equal(evaluator.sound, null);
    assert.equal(evaluator.warningCount, 1);

    evaluator.update(300, calm({ temperatureK: 300 }));
    assert.deepEqual(evaluator.alarms, []);
    assert.deepEqual(evaluator.clearedWarnings, ['temperature']);
  });

  test('alarm evaluator: an unacknowledged warning repeats its sound at a fixed interval', () => {
    const evaluator = adoptedEvaluator();
    evaluator.update(1000, calm({ temperatureK: 950 }));
    assert.equal(evaluator.sound, 'warning');
    evaluator.update(1500, calm({ temperatureK: 950 }));
    assert.equal(evaluator.sound, null);
    evaluator.update(3100, calm({ temperatureK: 950 }));
    assert.equal(evaluator.sound, 'warning');
  });

  test('alarm evaluator: a caution sounds once and a demotion keeps the acknowledgement', () => {
    const evaluator = adoptedEvaluator();
    evaluator.update(100, calm({ fuel: 150 }));
    assert.equal(evaluator.levelOf('fuel'), 'caution');
    assert.equal(evaluator.sound, 'caution');
    evaluator.update(200, calm({ fuel: 150 }));
    assert.equal(evaluator.sound, null);

    evaluator.update(300, calm({ temperatureK: 950 }));
    evaluator.acknowledge();
    // 警告から注意へ降りても確認済みのまま、新しい音は鳴らない。
    evaluator.update(400, calm({ temperatureK: 850 }));
    assert.equal(evaluator.levelOf('temperature'), 'warning');
    evaluator.update(500, calm({ temperatureK: 800 }));
    assert.equal(evaluator.levelOf('temperature'), 'caution');
    assert.equal(evaluator.alarms.find((alarm) => alarm.item === 'temperature')?.acknowledged, true);
    assert.equal(evaluator.sound, null);
  });

  test('alarm evaluator: an escalation after acknowledging is unacknowledged again', () => {
    const evaluator = adoptedEvaluator();
    evaluator.update(100, calm({ temperatureK: 750 }));
    evaluator.acknowledge();
    assert.equal(evaluator.alarms[0]?.acknowledged, true);
    evaluator.update(200, calm({ temperatureK: 950 }));
    assert.equal(evaluator.alarms[0]?.level, 'warning');
    assert.equal(evaluator.alarms[0]?.acknowledged, false);
    assert.equal(evaluator.sound, 'warning');
  });

  test('alarm evaluator: warnings come first and newer alarms come first within a level', () => {
    const evaluator = adoptedEvaluator();
    evaluator.update(100, calm({ fuel: 150 }));
    evaluator.update(200, calm({ fuel: 150, temperatureK: 750 }));
    evaluator.update(300, calm({ fuel: 150, temperatureK: 750, dynamicPressurePa: 950 }));
    assert.deepEqual(evaluator.alarms.map((alarm) => alarm.item), ['dynamicPressure', 'temperature', 'fuel']);
    // 注意だった燃料が警告へ昇格すると、同じ警告の中で最も新しい。
    evaluator.update(400, calm({ fuel: 20, temperatureK: 750, dynamicPressurePa: 950 }));
    assert.deepEqual(evaluator.alarms.map((alarm) => alarm.item), ['fuel', 'dynamicPressure', 'temperature']);
    assert.equal(evaluator.cautionCount, 1);
    assert.equal(evaluator.warningCount, 2);
  });

  test('alarm evaluator: alarms present at the first measurement are adopted acknowledged and silent', () => {
    const evaluator = new AlarmEvaluator();
    evaluator.update(0, calm({ temperatureK: 950, fuel: 100 }));
    assert.equal(evaluator.warningCount, 1);
    assert.equal(evaluator.cautionCount, 1);
    assert.equal(evaluator.hasUnacknowledgedWarning, false);
    assert.equal(evaluator.sound, null);
  });

  test('alarm evaluator: losing the operated ship withdraws every alarm without a clearing notice', () => {
    const evaluator = adoptedEvaluator();
    evaluator.update(100, calm({ temperatureK: 950 }));
    evaluator.update(200, null);
    assert.deepEqual(evaluator.alarms, []);
    assert.deepEqual(evaluator.clearedWarnings, []);
    assert.equal(evaluator.sound, null);
  });

  test('alarm evaluator: only a warning that returned to normal produces a clearing notice', () => {
    const evaluator = adoptedEvaluator();
    evaluator.update(100, calm({ fuel: 150 }));
    evaluator.update(200, calm());
    assert.deepEqual(evaluator.clearedWarnings, []);
    evaluator.update(300, calm({ fuel: 30 }));
    evaluator.update(400, calm({ fuel: 150 }));
    assert.deepEqual(evaluator.clearedWarnings, []);
    evaluator.update(500, calm());
    assert.deepEqual(evaluator.clearedWarnings, ['fuel']);
  });

  test('alarm evaluator: ammo is caution at one spare magazine and warning when empty', () => {
    const evaluator = adoptedEvaluator();
    evaluator.update(100, calm({ ammo: { roundsInMag: 40, magsLeft: 1 } }));
    assert.equal(evaluator.levelOf('ammo'), 'caution');
    evaluator.update(200, calm({ ammo: { roundsInMag: 0, magsLeft: 0 } }));
    assert.equal(evaluator.levelOf('ammo'), 'warning');
    evaluator.update(300, calm({ ammo: null }));
    assert.equal(evaluator.levelOf('ammo'), 'normal');
  });
}
