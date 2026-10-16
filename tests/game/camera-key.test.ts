// ビュー・照準・注視対象の組をカメラ同一性の文字列へ写す規則を検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { cameraKeyOf } from '../../src/game/camera/camera-key';

const cameraKey = cameraKeyOf('combat', false, 'ship-1');

export function register(): void {
  test('camera-key: 同じビュー・照準・注視対象は同じ文字列になる', () => {
    assert.equal(cameraKeyOf('combat', false, 'ship-1'), cameraKey);
  });

  test('camera-key: 組の各要素が替わると別の文字列になる', () => {
    assert.notEqual(cameraKeyOf('map', false, 'ship-1'), cameraKey);
    assert.notEqual(cameraKeyOf('combat', true, 'ship-1'), cameraKey);
    assert.notEqual(cameraKeyOf('combat', false, 'ship-2'), cameraKey);
  });

  test('camera-key: 対象なしと文字列 undefined は別の鍵になる', () => {
    assert.notEqual(cameraKeyOf('combat', false, null), cameraKeyOf('combat', false, 'undefined'));
  });
}
