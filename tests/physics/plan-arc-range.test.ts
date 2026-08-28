// 計画線の表示範囲をサンプル列へ切り出す処理の回帰テスト。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { samplesInRange } from '../../src/game/plan/arc-range';
import { kinematicState } from '../../src/physics/kinematic-state';
import { v3 } from '../../src/math/vec3';

export function register(): void {
  test('plan arc range: 表示窓の端点を補間状態として含める', () => {
    const source = [
      kinematicState(0, v3(0, 0, 0), v3(1, 0, 0)),
      kinematicState(5, v3(5, 0, 0), v3(1, 0, 0)),
      kinematicState(10, v3(10, 0, 0), v3(1, 0, 0)),
    ];
    const result = samplesInRange(source, 2, 8, (t) =>
      t < 0 || t > 10 ? null : kinematicState(t, v3(t, 0, 0), v3(1, 0, 0)));

    assert.deepEqual(result.map((s) => s.t), [2, 5, 8]);
    assert.deepEqual(result.map((s) => s.r.x), [2, 5, 8]);
  });
}
