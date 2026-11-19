// 描画先の寸法(src/render/viewport.ts)のテスト。実効ピクセル比は端末の
// devicePixelRatio に引っ張られて際限なく大きくならないこと — スマホ級の
// 高 DPR 端末で描画画素数が爆発しないための上限を固定する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { effectivePixelRatio } from '../../src/render/viewport';
import type { Viewport } from '../../src/render/viewport';

// 寸法は実効ピクセル比に効かないので、代表値で固定する。
function viewportWith(pixelRatio: number): Viewport {
  return { width: 960, height: 540, pixelRatio };
}

export function register(): void {
  test('viewport: 実効ピクセル比は devicePixelRatio が大きくても 2 を超えない', () => {
    assert.equal(effectivePixelRatio(viewportWith(3), 1), 2);
    assert.equal(effectivePixelRatio(viewportWith(4), 1), 2);
    assert.equal(effectivePixelRatio(viewportWith(3), 0.75), 1.5);
    assert.equal(effectivePixelRatio(viewportWith(3), 0.5), 1);
  });

  test('viewport: 上限以下の devicePixelRatio はそのまま解像度倍率が掛かる', () => {
    assert.equal(effectivePixelRatio(viewportWith(2), 1), 2);
    assert.equal(effectivePixelRatio(viewportWith(1.25), 1), 1.25);
    assert.equal(effectivePixelRatio(viewportWith(1.25), 0.75), 0.9375);
    assert.equal(effectivePixelRatio(viewportWith(1), 0.5), 0.5);
  });
}
