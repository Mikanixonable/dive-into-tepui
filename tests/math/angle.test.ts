// angle.ts の性質テスト。期待値の正本は「位相を 2π の整数倍だけずらしても向きは変わらず、
// 畳んだ値は [0, 2π) に収まる」という数学的な性質で、コードの現状ではない。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { wrapAngle } from '../../src/math/angle';

const TAU = 2 * Math.PI;

export function register(): void {
  test('angle: 畳んだ位相は [0, 2π) に収まる', () => {
    for (const angle of [-100, -7.5, -TAU, -1e-9, 0, 1e-9, Math.PI, TAU - 1e-9, TAU, 123.4]) {
      const wrapped = wrapAngle(angle);
      assert.ok(wrapped >= 0 && wrapped < TAU, `angle=${angle} → ${wrapped}`);
    }
  });

  test('angle: 畳み込みは向きを変えない(2π の整数倍だけずれる)', () => {
    for (const angle of [0.1, -3.7, 42.0, -Math.PI]) {
      assert.ok(
        Math.abs(Math.sin(angle) - Math.sin(wrapAngle(angle))) < 1e-12
        && Math.abs(Math.cos(angle) - Math.cos(wrapAngle(angle))) < 1e-12,
        `angle=${angle}`,
      );
    }
  });

  test('angle: 区間内の位相はそのまま返る', () => {
    for (const angle of [0, 1e-9, Math.PI / 3, Math.PI, TAU - 1e-9]) {
      assert.ok(Math.abs(wrapAngle(angle) - angle) < 1e-12, `angle=${angle}`);
    }
  });
}
