import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { monthlyClimateClockAt } from '../../src/render/cloud/monthly-climate-clock';

export function register(): void {
  test('monthly climate clock: UTC月の開始と月境界を正しく周回する', () => {
    const january = monthlyClimateClockAt(Date.UTC(2024, 0, 1) / 1000);
    assert.deepEqual(january, { monthIndex: 0, blend: 0 });

    const decemberEnd = monthlyClimateClockAt(Date.UTC(2024, 11, 31, 23, 59, 59) / 1000);
    assert.equal(decemberEnd.monthIndex, 11);
    assert.ok(decemberEnd.blend > 0.99 && decemberEnd.blend < 1);

    const januaryNext = monthlyClimateClockAt(Date.UTC(2025, 0, 1) / 1000);
    assert.deepEqual(januaryNext, { monthIndex: 0, blend: 0 });
  });

  test('monthly climate clock: 月の長さに応じてblendを線形に進める', () => {
    const middle = monthlyClimateClockAt(Date.UTC(2024, 1, 15, 12) / 1000);
    assert.equal(middle.monthIndex, 1);
    assert.equal(middle.blend, 14.5 / 29);
  });

  test('monthly climate clock: 非有限時刻を拒否する', () => {
    assert.throws(() => monthlyClimateClockAt(Number.NaN), /finite/);
  });
}
