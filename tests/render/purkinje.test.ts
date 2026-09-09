// プルキンエ補正の明暗遷移。補正そのものはGPUノードなので、ここでは連続性と両端の不変条件を検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  PURKINJE_DARK_LUMINANCE, PURKINJE_LIGHT_LUMINANCE, purkinjeDarknessAt,
} from '../../src/render/pipeline/purkinje';

export function register(): void {
  test('purkinje: bright images keep their original color', () => {
    assert.equal(purkinjeDarknessAt(PURKINJE_LIGHT_LUMINANCE), 0);
    assert.equal(purkinjeDarknessAt(1), 0);
  });

  test('purkinje: dark adaptation changes continuously', () => {
    assert.equal(purkinjeDarknessAt(PURKINJE_DARK_LUMINANCE), 1);
    const middle = purkinjeDarknessAt((PURKINJE_DARK_LUMINANCE + PURKINJE_LIGHT_LUMINANCE) / 2);
    assert.ok(middle > 0 && middle < 1);
    assert.ok(purkinjeDarknessAt(0.10) > purkinjeDarknessAt(0.20));
  });
}
