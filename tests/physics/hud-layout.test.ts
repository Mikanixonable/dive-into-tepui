import * as assert from 'node:assert/strict';
import { clampOverlayPosition } from '../../src/game/hud/layout';
import { test } from './harness';

export function register(): void {
  test('hud layout: context menu is clamped inside every viewport edge', () => {
    const viewport = { width: 320, height: 568 };
    const overlay = { width: 168, height: 180 };
    assert.deepEqual(
      clampOverlayPosition({ x: 319, y: 567 }, overlay, viewport),
      { x: 146, y: 382 },
    );
    assert.deepEqual(
      clampOverlayPosition({ x: -20, y: -30 }, overlay, viewport),
      { x: 6, y: 6 },
    );
  });
}
