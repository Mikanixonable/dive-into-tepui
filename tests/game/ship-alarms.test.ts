import * as assert from 'node:assert/strict';
import { ShipAlarms } from '../../src/game/alarm/ship-alarms';
import { MAX_HULL_TEMP } from '../../src/game/dynamic/dynamic-entity/combat-ship-entity';
import { test } from '../harness';

// 操作艦の警報(状態)の振る舞い(UI-DESIGN.md「警報と通知」): 鳴る・確認・解除。
export function register(): void {
  test('ship alarms: temperature rises to caution at 70% and warning at 90% of the hull limit', () => {
    const alarms = new ShipAlarms();
    alarms.update(MAX_HULL_TEMP * 0.69);
    assert.equal(alarms.count, 0);
    assert.equal(alarms.worst, 'normal');
    alarms.update(MAX_HULL_TEMP * 0.7);
    assert.equal(alarms.count, 1);
    assert.equal(alarms.worst, 'caution');
    assert.equal(alarms.entries[0]?.id, 'hullTemperature');
    // 注意の段に警報音は無い。
    assert.equal(alarms.unacknowledgedWarning, false);
    alarms.update(MAX_HULL_TEMP * 0.9);
    assert.equal(alarms.worst, 'warning');
    assert.equal(alarms.unacknowledgedWarning, true);
  });

  test('ship alarms: acknowledging a warning silences it but the alarm stays until the condition clears', () => {
    const alarms = new ShipAlarms();
    alarms.update(MAX_HULL_TEMP * 0.95);
    assert.equal(alarms.unacknowledgedWarning, true);
    alarms.acknowledge();
    // 確認で音は止まるが、警報は条件が戻るまで残る。
    assert.equal(alarms.unacknowledgedWarning, false);
    assert.equal(alarms.count, 1);
    assert.equal(alarms.entries[0]?.acknowledged, true);
    alarms.update(MAX_HULL_TEMP * 0.5);
    assert.equal(alarms.count, 0);
  });

  test('ship alarms: a warning that re-enters after dropping needs to be acknowledged again', () => {
    const alarms = new ShipAlarms();
    alarms.update(MAX_HULL_TEMP * 0.95);
    alarms.acknowledge();
    alarms.update(MAX_HULL_TEMP * 0.75);
    assert.equal(alarms.worst, 'caution');
    alarms.update(MAX_HULL_TEMP * 0.95);
    assert.equal(alarms.unacknowledgedWarning, true);
  });

  test('ship alarms: the step does not flicker while the temperature oscillates at the boundary', () => {
    const alarms = new ShipAlarms();
    alarms.update(MAX_HULL_TEMP * 0.9);
    assert.equal(alarms.worst, 'warning');
    alarms.update(MAX_HULL_TEMP * 0.89);
    assert.equal(alarms.worst, 'warning');
    alarms.update(MAX_HULL_TEMP * 0.87);
    assert.equal(alarms.worst, 'caution');
  });

  test('ship alarms: no controllable means no alarms', () => {
    const alarms = new ShipAlarms();
    alarms.update(MAX_HULL_TEMP * 0.95);
    alarms.update(null);
    assert.equal(alarms.count, 0);
    assert.equal(alarms.worst, 'normal');
    assert.equal(alarms.unacknowledgedWarning, false);
  });
}
