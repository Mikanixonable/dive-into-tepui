// 慣性テンソルの代数(平行軸の定理・座標変換・主慣性モーメント)の回帰テスト。
import * as assert from 'node:assert/strict';
import { norm, v3 } from '../../src/physics/vec3';
import type { InertiaTensor } from '../../src/physics/inertia-tensor';
import {
  ZERO_INERTIA, addInertia, pointMassInertia, principalMoments, rotateInertia, translateInertia,
} from '../../src/physics/inertia-tensor';
import { test } from './harness';

function close(actual: number, expected: number, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

export function register(): void {
  test('質点の慣性テンソルが解析値と一致する', () => {
    const inertia = pointMassInertia(2, v3(3, 0, 0));
    close(inertia.ixx, 0);
    close(inertia.iyy, 18);
    close(inertia.izz, 18);
    close(inertia.ixy, 0);
  });

  test('斜めに置いた質点が慣性乗積を生む', () => {
    const inertia = pointMassInertia(3, v3(2, 5, 0));
    // −∫xy dm = −m·x·y。
    close(inertia.ixy, -30);
    close(inertia.ixz, 0);
    close(inertia.izz, 3 * (4 + 25));
  });

  test('平行軸の定理が往復する', () => {
    const cm: InertiaTensor = { ixx: 5, iyy: 7, izz: 9, ixy: 1, ixz: -2, iyz: 0.5 };
    const offset = v3(1.5, -2, 3);
    const moved = translateInertia(cm, 4, offset);
    const back = translateInertia(moved, -4, offset);
    for (const key of ['ixx', 'iyy', 'izz', 'ixy', 'ixz', 'iyz'] as const) close(back[key], cm[key]);
  });

  test('ダンベルの慣性テンソルが2つの質点の和として求まる', () => {
    // 質量 m の質点2つを距離 2d で並べた系の、重心まわりの慣性モーメントは 2·m·d²。
    const total = addInertia(pointMassInertia(3, v3(0, 0, 2)), pointMassInertia(3, v3(0, 0, -2)));
    close(total.ixx, 2 * 3 * 4);
    close(total.iyy, 2 * 3 * 4);
    close(total.izz, 0);
  });

  test('座標系を z 軸まわりに 90 度回すと x と y の慣性モーメントが入れ替わる', () => {
    const inertia: InertiaTensor = { ixx: 2, iyy: 5, izz: 9, ixy: 0, ixz: 0, iyz: 0 };
    // 新しい基底の x 軸が元の +y、y 軸が元の −x を向く。
    const rotated = rotateInertia(inertia, v3(0, 1, 0), v3(-1, 0, 0), v3(0, 0, 1));
    close(rotated.ixx, 5);
    close(rotated.iyy, 2);
    close(rotated.izz, 9);
  });

  test('任意の正規直交基底への変換が対角和と固有値を保つ', () => {
    const inertia: InertiaTensor = { ixx: 4, iyy: 6, izz: 11, ixy: 1.2, ixz: -0.7, iyz: 0.4 };
    const z = norm(v3(1, 2, 3));
    const x = norm(v3(-2, 1, 0));
    const y = norm(v3(x.y * z.z - x.z * z.y, x.z * z.x - x.x * z.z, x.x * z.y - x.y * z.x));
    const rotated = rotateInertia(inertia, x, y, z);
    close(rotated.ixx + rotated.iyy + rotated.izz, inertia.ixx + inertia.iyy + inertia.izz, 1e-9);
    const before = principalMoments(inertia);
    const after = principalMoments(rotated);
    close(after.x, before.x, 1e-9);
    close(after.y, before.y, 1e-9);
    close(after.z, before.z, 1e-9);
  });

  test('主慣性モーメントが対角なテンソルでは対角成分そのものになる', () => {
    const principal = principalMoments({ ixx: 7, iyy: 2, izz: 5, ixy: 0, ixz: 0, iyz: 0 });
    close(principal.x, 2);
    close(principal.y, 5);
    close(principal.z, 7);
    // 3軸とも等しい場合(球)。
    const sphere = principalMoments({ ixx: 3, iyy: 3, izz: 3, ixy: 0, ixz: 0, iyz: 0 });
    close(sphere.x, 3);
    close(sphere.z, 3);
  });

  test('0 の慣性テンソルは加算の単位元である', () => {
    const inertia: InertiaTensor = { ixx: 1, iyy: 2, izz: 3, ixy: 4, ixz: 5, iyz: 6 };
    assert.deepEqual(addInertia(inertia, ZERO_INERTIA), inertia);
  });
}
