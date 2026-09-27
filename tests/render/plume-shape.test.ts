import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { plumeShape } from '../../src/render/dynamic/player/plume-shape';

export function register(): void {
  // SPEC「推進プルーム」: 真空では半角 ~40° の広い扇、海面密度では明瞭に細い流れ。
  test('plume shape: vacuum is a wide fan and sea-level density a narrow stream', () => {
    const vacuum = plumeShape(0);
    const seaLevel = plumeShape(1.2);
    assert.ok(vacuum.tanHalfAngle > Math.tan((35 * Math.PI) / 180));
    assert.ok(seaLevel.tanHalfAngle < Math.tan((10 * Math.PI) / 180));
  });

  // 密度が高いほど細く絞られ、間は連続に移る。
  test('plume shape: denser ambient narrows the fan and lengthens the stream monotonically', () => {
    let previous = plumeShape(0);
    for (const density of [1e-8, 1e-6, 1e-4, 1e-3, 1e-2, 0.1, 1.2, 10]) {
      const shape = plumeShape(density);
      assert.ok(shape.tanHalfAngle <= previous.tanHalfAngle);
      assert.ok(shape.length >= previous.length);
      assert.ok(shape.decayLength >= previous.decayLength);
      previous = shape;
    }
  });

  test('plume shape: transition has no discontinuity across the density range', () => {
    const totalSpan = plumeShape(0).tanHalfAngle - plumeShape(1e3).tanHalfAngle;
    let previous = plumeShape(0).tanHalfAngle;
    for (let i = 1; i <= 200; i++) {
      const density = Math.pow(10, -9 + (i / 200) * 12);
      const angle = plumeShape(density).tanHalfAngle;
      assert.ok(previous - angle <= totalSpan * 0.05 + 1e-9, `jump at density=${density}`);
      previous = angle;
    }
  });
}
