import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  AMBIENT_SHADOW_LUMA_END,
  AMBIENT_SHADOW_LUMA_START,
  ambientShadowDesaturation,
} from '../../src/render/pipeline/visual-effect-lut';

const luma = ([r, g, b]: readonly [number, number, number]): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

export function register(): void {
  test('visual effect lut: disabled is identity', () => {
    const color = [0.03, 0.15, 0.4] as const;
    assert.deepEqual(ambientShadowDesaturation(color, false), color);
  });

  test('visual effect lut: dark colors lose half their saturation without changing luma', () => {
    const color = [0.02, 0.12, 0.35] as const;
    const adjusted = ambientShadowDesaturation(color, true);
    const gray = luma(color);
    assert.ok(Math.abs(luma(adjusted) - gray) < 1e-12);
    assert.ok(Math.abs(adjusted[2] - gray) < Math.abs(color[2] - gray));
  });

  test('visual effect lut: bright colors and transition endpoint are unchanged', () => {
    const bright = [0.6, 0.8, 1] as const;
    assert.deepEqual(ambientShadowDesaturation(bright, true), bright);
    const atEnd = [AMBIENT_SHADOW_LUMA_END, AMBIENT_SHADOW_LUMA_END, AMBIENT_SHADOW_LUMA_END] as const;
    assert.deepEqual(ambientShadowDesaturation(atEnd, true), atEnd);
    assert.ok(AMBIENT_SHADOW_LUMA_START < AMBIENT_SHADOW_LUMA_END);
  });
}
