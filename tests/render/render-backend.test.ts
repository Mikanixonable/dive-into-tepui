// 描画バックエンドの判定と、利用者への示し方の決定を固定する(SPEC「描画バックエンド」)。
// WebGPU で描けていれば無通知、WebGL2 へ落ちていれば通知、どちらの基盤も無ければ
// エラーで止まる、という対応がここで検査できる。
import * as assert from 'node:assert/strict';
import {
  renderBackendKindOf, renderBackendNoticeOf,
} from '../../src/render/render-backend';
import { test } from '../harness';

export function register(): void {
  test('render backend: WebGPU フラグが立てば webgpu', () => {
    assert.equal(renderBackendKindOf(true, false), 'webgpu');
    // 両方立つ入力でも、第一の基盤である WebGPU を採る。
    assert.equal(renderBackendKindOf(true, true), 'webgpu');
  });

  test('render backend: WebGL フラグだけなら webgl2', () => {
    assert.equal(renderBackendKindOf(false, true), 'webgl2');
  });

  test('render backend: どちらのフラグも無ければ unavailable', () => {
    assert.equal(renderBackendKindOf(false, false), 'unavailable');
  });

  test('render backend: バックエンドごとに示し方が決まる', () => {
    assert.equal(renderBackendNoticeOf('webgpu'), 'none');
    assert.equal(renderBackendNoticeOf('webgl2'), 'fallback-notice');
    assert.equal(renderBackendNoticeOf('unavailable'), 'unavailable-error');
  });
}
