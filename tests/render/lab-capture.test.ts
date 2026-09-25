import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { assertCaptureTargetWasRendered } from '../../tools/render-lab/lab';

export function register(): void {
  test('render-lab capture: 透明 sentinel が残った readback を撮影成功にしない', () => {
    assert.throws(
      () => assertCaptureTargetWasRendered(new Uint8Array([255, 0, 255, 0, 255, 0, 255, 0])),
      /capture target was not overwritten/,
    );
  });

  test('render-lab capture: 黒い画素も不透明な描画結果として受理する', () => {
    assert.doesNotThrow(
      () => assertCaptureTargetWasRendered(new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255])),
    );
  });
}
