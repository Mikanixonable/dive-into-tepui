// quat.ts の性質テスト。期待値の正本は回転の代数(合成・逆・基底からの組み立て)で、
// コードの現状ではない。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { LOCAL_FORWARD, LOCAL_UP, qFromBasis, qFromForwardUp, qRotate } from '../../src/math/quat';
import { cross, len, norm, sub, v3 } from '../../src/math/vec3';

export function register(): void {
  test('quat: qFromBasis は fwd を +Z、up を +Y へ写す', () => {
    const fwd = norm(v3(1, 2, 3));
    const up = norm(cross(cross(fwd, v3(0, 1, 0)), fwd));
    const q = qFromBasis(fwd, up);
    assert.ok(len(sub(qRotate(q, LOCAL_FORWARD), fwd)) < 1e-9);
    assert.ok(len(sub(qRotate(q, LOCAL_UP), up)) < 1e-9);
  });

  test('quat: qFromBasis は up を再直交化するので、傾いた up でも fwd は保たれる', () => {
    const fwd = norm(v3(0, 0, 1));
    const q = qFromBasis(fwd, norm(v3(0.3, 1, 0.7)));
    assert.ok(len(sub(qRotate(q, LOCAL_FORWARD), fwd)) < 1e-9);
  });

  test('quat: 基底が定まらない入力では、qFromForwardUp は null・qFromBasis は単位回転', () => {
    assert.equal(qFromForwardUp(v3(0, 0, 0), v3(0, 1, 0)), null);
    assert.deepEqual(qFromBasis(v3(0, 0, 0), v3(0, 1, 0)), { x: 0, y: 0, z: 0, w: 1 });
    assert.equal(qFromForwardUp(v3(0, 1, 0), v3(0, 2, 0)), null);
    assert.deepEqual(qFromBasis(v3(0, 1, 0), v3(0, 2, 0)), { x: 0, y: 0, z: 0, w: 1 });
  });
}
