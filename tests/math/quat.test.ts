// quat.ts の性質テスト。期待値の正本は回転の代数(合成・逆・基底からの組み立て)で、
// コードの現状ではない。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  LOCAL_FORWARD, LOCAL_UP, qFromAxisAngle, qFromBasis, qFromForwardUp, qNormalize, qRotate, qSlerp,
} from '../../src/math/quat';
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

  test('quat: qSlerp は入力を正規化し、端点をそのまま返す', () => {
    const a = { x: 0, y: 0, z: 0, w: 2 };
    const b = { x: 0, y: 4, z: 0, w: 0 };
    assert.deepEqual(qSlerp(a, b, 0), qNormalize(a));
    assert.deepEqual(qSlerp(a, b, 1), qNormalize(b));
    const mid = qSlerp(a, b, 0.5);
    assert.ok(Number.isFinite(mid.x) && Number.isFinite(mid.y) && Number.isFinite(mid.z) && Number.isFinite(mid.w));
    assert.ok(Math.abs(mid.x * mid.x + mid.y * mid.y + mid.z * mid.z + mid.w * mid.w - 1) < 1e-12);
  });

  test('quat: qSlerp は q と -q を同じ最短経路として扱う', () => {
    const q = qFromAxisAngle(norm(v3(1, 2, 3)), 0.9);
    const minusQ = { x: -q.x, y: -q.y, z: -q.z, w: -q.w };
    const result = qSlerp(q, minusQ, 0.5);
    assert.ok(len(sub(qRotate(result, LOCAL_FORWARD), qRotate(q, LOCAL_FORWARD))) < 1e-12);
    assert.ok(len(sub(qRotate(result, LOCAL_UP), qRotate(q, LOCAL_UP))) < 1e-12);
  });

  test('quat: qSlerp は近接回転を正規化 lerp で安定に補間する', () => {
    const axis = norm(v3(1, -2, 3));
    const a = qFromAxisAngle(axis, 0);
    const b = qFromAxisAngle(axis, 1e-10);
    const result = qSlerp(a, b, 0.5);
    const expected = qFromAxisAngle(axis, 0.5e-10);
    assert.ok(len(sub(qRotate(result, LOCAL_FORWARD), qRotate(expected, LOCAL_FORWARD))) < 1e-12);
  });

  test('quat: qSlerp は 180 度近傍でも有限かつ単位長になる', () => {
    const a = qFromAxisAngle(v3(0, 1, 0), 0);
    const b = qFromAxisAngle(v3(0, 1, 0), Math.PI);
    const result = qSlerp(a, b, 0.5);
    assert.ok(Object.values(result).every(Number.isFinite));
    assert.ok(Math.abs(result.x * result.x + result.y * result.y + result.z * result.z + result.w * result.w - 1) < 1e-12);
    assert.ok(len(sub(qRotate(result, LOCAL_FORWARD), v3(1, 0, 0))) < 1e-12);
  });

  test('quat: qSlerp は非単位入力でも決定的な有限値を返す', () => {
    const a = { x: 0, y: 0, z: 0, w: 1e300 };
    const b = { x: 0, y: -1e250, z: 0, w: 1e250 };
    const first = qSlerp(a, b, 0.37);
    const second = qSlerp(a, b, 0.37);
    assert.deepEqual(first, second);
    assert.ok(Object.values(first).every(Number.isFinite));
    assert.ok(Math.abs(first.x * first.x + first.y * first.y + first.z * first.z + first.w * first.w - 1) < 1e-12);
  });
}
