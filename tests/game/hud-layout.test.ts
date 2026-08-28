import * as assert from 'node:assert/strict';
import { clampOverlayPosition } from '../../src/game/hud/layout';
import { test } from '../harness';

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

  test('hud layout: dragged property window position stays clamped after a viewport shrink', () => {
    const overlay = { width: 220, height: 160 };
    // ヘッダドラッグでウィンドウ端まで動かした状態を模する。
    const draggedInWideViewport = clampOverlayPosition(
      { x: 900, y: 500 },
      overlay,
      { width: 1000, height: 600 },
    );
    assert.deepEqual(draggedInWideViewport, { x: 774, y: 434 });
    // window.resize でビューポートが縮んだあと、同じ座標を再クランプする。
    const reclampedAfterShrink = clampOverlayPosition(
      draggedInWideViewport,
      overlay,
      { width: 400, height: 300 },
    );
    assert.deepEqual(reclampedAfterShrink, { x: 174, y: 134 });
  });
}
