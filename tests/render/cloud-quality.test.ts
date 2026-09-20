// 雲品質と性能budgetの回帰テスト。baselineを使い回して別機器を合格扱いにしない。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { CLOUD_QUALITY, cloudPerformanceBudget } from '../../src/render/cloud/cloud-quality';

export function register(): void {
  test('cloud-quality: standardはlow以下の負荷で固定される', () => {
    assert.ok(CLOUD_QUALITY.low.atmosphereSamples < CLOUD_QUALITY.standard.atmosphereSamples);
    assert.ok(CLOUD_QUALITY.standard.atmosphereSamples < CLOUD_QUALITY.high.atmosphereSamples);
    assert.equal(CLOUD_QUALITY.standard.maxFieldUpdatesPerSecond, 4);
  });

  test('cloud-quality: headroomからcloud budgetを導く', () => {
    const budget = cloudPerformanceBudget(10, 1000 / 60);
    assert.equal(budget.qualification, 'qualified');
    assert.equal(budget.headroomMs, 1000 / 60 - 10);
    assert.equal(budget.cloudBudgetMs, Math.min(0.20 * (1000 / 60), 0.50 * budget.headroomMs));
  });

  test('cloud-quality: headroom 0 は60fps qualification不能', () => {
    const budget = cloudPerformanceBudget(20, 16.67);
    assert.equal(budget.headroomMs, 0);
    assert.equal(budget.cloudBudgetMs, 0);
    assert.equal(budget.qualification, 'unqualified');
  });

  test('cloud-quality: 未計測値は合格扱いにしない', () => {
    assert.equal(cloudPerformanceBudget(Number.NaN).qualification, 'unqualified');
    assert.equal(cloudPerformanceBudget(5, Number.NaN).qualification, 'unqualified');
  });
}
