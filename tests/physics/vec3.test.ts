// vec3.ts のスモークテスト(基本演算)。理論値(解析的に自明な値)で検証。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { add, cross, dot, len, norm, rotateAxis, scale, sub, v3 } from '../../src/physics/vec3';

export function register(): void {
  test('vec3: add/sub/scale', () => {
    const a = v3(1, 2, 3);
    const b = v3(4, 5, 6);
    assert.deepEqual(add(a, b), { x: 5, y: 7, z: 9 });
    assert.deepEqual(sub(b, a), { x: 3, y: 3, z: 3 });
    assert.deepEqual(scale(a, 2), { x: 2, y: 4, z: 6 });
  });

  test('vec3: dot/cross of orthonormal basis', () => {
    const x = v3(1, 0, 0);
    const y = v3(0, 1, 0);
    const z = v3(0, 0, 1);
    assert.equal(dot(x, y), 0);
    assert.deepEqual(cross(x, y), z);
  });

  test('vec3: len/norm', () => {
    assert.equal(len(v3(3, 4, 0)), 5);
    const n = norm(v3(0, 0, 0));
    assert.deepEqual(n, { x: 0, y: 0, z: 0 }, 'ゼロベクトルの正規化は安全にゼロを返す');
    const n2 = norm(v3(5, 0, 0));
    assert.equal(n2.x, 1);
  });

  test('vec3: rotateAxis 90deg about Y maps +X to -Z (right-handed)', () => {
    const r = rotateAxis(v3(1, 0, 0), v3(0, 1, 0), Math.PI / 2);
    assert.ok(Math.abs(r.x) < 1e-12);
    assert.ok(Math.abs(r.y) < 1e-12);
    assert.ok(Math.abs(r.z - -1) < 1e-12);
  });
}
