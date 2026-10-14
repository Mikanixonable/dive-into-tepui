// カメラの切り替えの判定を、組が同じなら 0・ビュー・照準・注視のどれかが替われば Infinity の不変条件で検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { cameraCutChangeOf, type CameraCutKey } from '../../src/game/camera/camera-cut';

const combatKey: CameraCutKey = { view: 'combat', gunsight: false, focusTargetId: 'ship-1' };

// カメラ状態の差から近傍拡散履歴を捨てる条件を検査する。
export function register(): void {
  test('camera-cut: 初回と同じ状態は履歴を続ける', () => {
    assert.equal(cameraCutChangeOf(null, combatKey), 0);
    assert.equal(cameraCutChangeOf(combatKey, { ...combatKey }), 0);
  });

  test('camera-cut: ビュー・照準・注視対象の切り替えは履歴を捨てる', () => {
    assert.equal(cameraCutChangeOf(combatKey, { ...combatKey, view: 'map' }), Infinity);
    assert.equal(cameraCutChangeOf(combatKey, { ...combatKey, gunsight: true }), Infinity);
    assert.equal(cameraCutChangeOf(combatKey, { ...combatKey, focusTargetId: 'ship-2' }), Infinity);
  });
}
