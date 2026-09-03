// polar-euler.ts の性質テスト。期待値の正本は「分解と組み立ては互いに逆である」という
// 数学的な同値関係で、コードの現状ではない。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  POLAR_PITCH_LIMIT, eulerFromRotation, rotationFromEuler, sphericalOffset,
} from '../../src/math/polar-euler';
import { LOCAL_FORWARD, LOCAL_UP, qFromBasis, qRotate } from '../../src/math/quat';
import { cross, dot, len, norm, sub, v3, Vec3 } from '../../src/math/vec3';

// 2つの回転が同じ向きを表すか。局所基底の写り先で比べる(q と -q を同一視するため)。
function sameOrientation(a: Parameters<typeof qRotate>[0], b: Parameters<typeof qRotate>[0], tol = 1e-9): boolean {
  return len(sub(qRotate(a, LOCAL_FORWARD), qRotate(b, LOCAL_FORWARD))) < tol
    && len(sub(qRotate(a, LOCAL_UP), qRotate(b, LOCAL_UP))) < tol;
}

const POLARS: readonly Vec3[] = [
  v3(0, 1, 0),
  norm(v3(0.3, 0.9, -0.2)),
  v3(1, 0, 0), // reference の種が極軸と平行になる縮退ケース
  norm(v3(-0.4, -0.5, 0.77)),
];

export function register(): void {
  test('polar-euler: 分解 → 組み立てで元の向きへ戻る(極軸を変えても)', () => {
    for (const polar of POLARS) {
      for (const [yaw, pitch, roll] of [[0.4, 0.2, 0], [-2.1, -1.0, 0.7], [3.0, 1.2, -2.5]]) {
        const q = rotationFromEuler({ yaw, pitch, roll }, polar);
        const back = rotationFromEuler(eulerFromRotation(q, polar), polar);
        assert.ok(sameOrientation(q, back, 1e-8), `polar=${JSON.stringify(polar)} yaw=${yaw}`);
      }
    }
  });

  test('polar-euler: 仰角は真上・真下の手前で止まる', () => {
    const polar = v3(0, 1, 0);
    for (const pitch of [Math.PI, -Math.PI, 10]) {
      const euler = eulerFromRotation(rotationFromEuler({ yaw: 0, pitch, roll: 0 }, polar), polar);
      assert.ok(Math.abs(euler.pitch) <= POLAR_PITCH_LIMIT + 1e-12, `pitch=${pitch} → ${euler.pitch}`);
    }
  });

  test('polar-euler: 仰角は極軸との成す角で決まる', () => {
    const polar = norm(v3(0.2, 0.9, 0.1));
    const q = rotationFromEuler({ yaw: 1.1, pitch: 0.5, roll: 0.3 }, polar);
    assert.ok(Math.abs(dot(qRotate(q, LOCAL_FORWARD), polar) - Math.sin(0.5)) < 1e-9);
  });

  test('polar-euler: sphericalOffset は +Y を天頂とする球面座標', () => {
    assert.ok(len(sub(sphericalOffset({ yaw: 0, pitch: 0, roll: 0 }, 5), v3(5, 0, 0))) < 1e-12);
    assert.ok(len(sub(sphericalOffset({ yaw: 0, pitch: Math.PI / 2, roll: 0 }, 5), v3(0, 5, 0))) < 1e-12);
    assert.ok(Math.abs(len(sphericalOffset({ yaw: 1.2, pitch: 0.4, roll: 0 }, 7)) - 7) < 1e-12);
  });

  test('polar-euler: sphericalOffset は roll に依らない', () => {
    const a = sphericalOffset({ yaw: 1.2, pitch: 0.4, roll: 0 }, 7);
    const b = sphericalOffset({ yaw: 1.2, pitch: 0.4, roll: 2.5 }, 7);
    assert.deepEqual(a, b);
  });
}
