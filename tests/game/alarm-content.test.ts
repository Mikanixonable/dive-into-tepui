import * as assert from 'node:assert/strict';
import type { ActiveAlarm } from '../../src/game/alarm/alarm-evaluator';
import { ALTITUDE_CAUTION_M, ALTITUDE_WARNING_M } from '../../src/game/alarm/alarm-level';
import { alarmActionSignature, alarmContent } from '../../src/game/hud/alarm-content';
import { test } from '../harness';

function altitudeAlarm(overrides: Partial<ActiveAlarm>): ActiveAlarm {
  return {
    item: 'altitude', level: 'caution', acknowledged: false, value: 300e3, secondaryValue: 0, descending: false,
    ...overrides,
  };
}

function messageText(alarm: ActiveAlarm): string {
  return alarmContent(alarm).message.map((part) => part.text).join('');
}

// 警報の文言: 注意の原因の振り分けと、値が動いても行動の構成が変わらないこと。
export function register(): void {
  test('alarm content: an altitude caution names its cause from the descent warning, not the rate sign', () => {
    // 降下率の警告が掛かっている間は降下中。降下率は四捨五入して示す。
    const descending = messageText(altitudeAlarm({ value: 300e3, secondaryValue: -5.4, descending: true }));
    assert.match(descending, /降下中 -5 m\/s/);
    // 低高度が原因で、平滑化した降下率が僅かに負でも、降下中とは言わない。
    const low = messageText(altitudeAlarm({ value: 100e3, secondaryValue: -0.2, descending: false }));
    assert.doesNotMatch(low, /降下中/);
    assert.match(low, new RegExp(`${ALTITUDE_CAUTION_M / 1000} km を下回った`));
  });

  test('alarm content: the altitude warning states the warning altitude from the shared constant', () => {
    const text = messageText(altitudeAlarm({ level: 'warning', value: 70e3 }));
    assert.match(text, new RegExp(`${ALTITUDE_WARNING_M / 1000} km 以下`));
  });

  test('alarm content: the action signature does not depend on the measured value', () => {
    const at = (value: number) => alarmActionSignature(alarmContent({
      item: 'temperature', level: 'caution', acknowledged: false, value, secondaryValue: null, descending: false,
    }));
    assert.equal(at(700), at(742));
    // 段が変わると行動の構成が変わる(温度の警告は射撃を止める)。
    const warning = alarmActionSignature(alarmContent({
      item: 'temperature', level: 'warning', acknowledged: false, value: 950, secondaryValue: null, descending: false,
    }));
    assert.notEqual(at(700), warning);
  });
}
