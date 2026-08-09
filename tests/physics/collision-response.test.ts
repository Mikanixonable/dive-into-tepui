import * as assert from 'node:assert/strict';
import { resolveSphereCollision } from '../../src/physics/collision-response';
import { dot, lenSq, sub, v3, Vec3 } from '../../src/physics/vec3';
import { test } from './harness';

function overlapPair(vA: Vec3, vB: Vec3, invMassA: number, invMassB: number, restitution: number) {
  return resolveSphereCollision(
    { r: v3(-0.6, 0, 0), v: vA, radius: 1, invMass: invMassA },
    { r: v3(0.6, 0, 0), v: vB, radius: 1, invMass: invMassB },
    restitution,
  );
}

export function register(): void {
  test('collision-response: 運動量保存', () => {
    const massA = 2, massB = 5;
    const vA = v3(3, -1, 0), vB = v3(-2, 0.5, 0);
    const res = overlapPair(vA, vB, 1 / massA, 1 / massB, 0.4)!;
    const before = v3(massA * vA.x + massB * vB.x, massA * vA.y + massB * vB.y, massA * vA.z + massB * vB.z);
    const after = v3(
      massA * res.vA.x + massB * res.vB.x,
      massA * res.vA.y + massB * res.vB.y,
      massA * res.vA.z + massB * res.vB.z,
    );
    assert.ok(lenSq(sub(after, before)) < 1e-9);
  });

  test('collision-response: e=1 で運動エネルギー保存、e<1 で単調に損失する', () => {
    const massA = 3, massB = 1;
    const vA = v3(2, 0, 0), vB = v3(-4, 0, 0);
    const ke = (a: Vec3, b: Vec3) => 0.5 * massA * lenSq(a) + 0.5 * massB * lenSq(b);
    const keBefore = ke(vA, vB);

    const elastic = overlapPair(vA, vB, 1 / massA, 1 / massB, 1)!;
    assert.ok(Math.abs(ke(elastic.vA, elastic.vB) - keBefore) < 1e-9);

    let prevKe = keBefore;
    for (const e of [0.8, 0.5, 0.2, 0]) {
      const res = overlapPair(vA, vB, 1 / massA, 1 / massB, e)!;
      const keAfter = ke(res.vA, res.vB);
      assert.ok(keAfter < prevKe, `e=${e} でエネルギーが単調に減っていない`);
      prevKe = keAfter;
    }
  });

  test('collision-response: 逆質量0の相手は動かず、こちらの法線速度が-e倍になる', () => {
    const vA = v3(5, 0, 0); // 天体(不動)へ正面から接近
    const vB = v3(0, 0, 0);
    const res = overlapPair(vA, vB, 1 / 10, 0, 0.5)!;
    assert.deepEqual(res.rB, v3(0.6, 0, 0));
    assert.deepEqual(res.vB, vB);
    const vnBefore = dot(sub(vB, vA), res.normal);
    const vnAfter = dot(sub(res.vB, res.vA), res.normal);
    assert.ok(Math.abs(vnAfter - (-0.5 * vnBefore)) < 1e-9);
  });

  test('collision-response: 力積は換算質量に比例する', () => {
    const vA = v3(4, 0, 0), vB = v3(-4, 0, 0);
    const light = overlapPair(vA, vB, 1, 1, 0.6)!; // mass 1, 1 → 換算質量 0.5
    const heavy = overlapPair(vA, vB, 0.1, 0.1, 0.6)!; // mass 10, 10 → 換算質量 5(10倍)
    assert.ok(Math.abs(heavy.impulse - light.impulse * 10) < 1e-6);
  });

  test('collision-response: Δv(=impulse/mass)は質量に反比例する', () => {
    const massA = 2, massB = 8;
    const vA = v3(3, 0, 0), vB = v3(-3, 0, 0);
    const res = overlapPair(vA, vB, 1 / massA, 1 / massB, 0.5)!;
    const dvA = Math.abs(res.vA.x - vA.x);
    const dvB = Math.abs(res.vB.x - vB.x);
    assert.ok(Math.abs(dvA * massA - dvB * massB) < 1e-9);
    assert.ok(dvA > dvB); // 軽いA側のΔvの方が大きい
  });
}
