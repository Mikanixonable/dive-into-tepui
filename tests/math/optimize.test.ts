// optimize.ts の回帰テスト。理論値で自明な単峰関数に対して十分な精度で最小点を当てることを確認する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { goldenSectionMin } from '../../src/math/optimize';

export function register(): void {
  test('optimize: goldenSectionMin finds the minimum of a quadratic well inside the interval', () => {
    const f = (x: number): number => (x - 0.37) ** 2;
    const x = goldenSectionMin(0, 1, f, 40);
    assert.ok(Math.abs(x - 0.37) < 1e-6, `expected x close to 0.37, got ${x}`);
  });

  test('optimize: goldenSectionMin converges to the endpoint for a monotonic function', () => {
    const f = (x: number): number => x;
    const x = goldenSectionMin(0, 1, f, 40);
    assert.ok(x < 1e-6, `expected x close to 0 (the minimum), got ${x}`);
  });

  test('optimize: goldenSectionMin is deterministic for the same inputs and iteration count', () => {
    const f = (x: number): number => (x - 0.6) ** 2;
    const x1 = goldenSectionMin(0, 1, f, 25);
    const x2 = goldenSectionMin(0, 1, f, 25);
    assert.equal(x1, x2);
  });
}
