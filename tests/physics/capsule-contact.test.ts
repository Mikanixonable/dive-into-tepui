// カプセルの掃引接触の回帰テスト。球は両端の一致するカプセルなので、球どうしの掃引が既存の
// sweptSphereToi と一致することをまず固定する。
import * as assert from 'node:assert/strict';
import {
  closestPointsOnSegments, sphereAsSweptCapsule, sweptCapsuleSphereToi, sweptCapsuleToi,
} from '../../src/physics/capsule-contact';
import type { SweptCapsule } from '../../src/physics/capsule-contact';
import { sweptSphereToi } from '../../src/physics/sphere-contact';
import { v3 } from '../../src/physics/vec3';
import { test } from './harness';

// 静止したカプセル。
function still(a: ReturnType<typeof v3>, b: ReturnType<typeof v3>, radius: number): SweptCapsule {
  return { aStart: a, bStart: b, aEnd: a, bEnd: b, radius };
}

export function register(): void {
  test('最接近点: 直交する線分・平行な線分・点に退化した線分', () => {
    const cross = closestPointsOnSegments(v3(-1, 0, 0), v3(1, 0, 0), v3(0, -1, 1), v3(0, 1, 1));
    assert.ok(Math.abs(cross.s - 0.5) < 1e-12);
    assert.ok(Math.abs(cross.t - 0.5) < 1e-12);
    // 平行で完全に重なる場合、s は自由に取れるので端に置かれ、t がそれに対応する。
    const parallel = closestPointsOnSegments(v3(0, 0, 0), v3(2, 0, 0), v3(0, 1, 0), v3(2, 1, 0));
    assert.ok(Math.abs(parallel.s - parallel.t) < 1e-12);
    const degenerate = closestPointsOnSegments(v3(0, 0, 0), v3(0, 0, 0), v3(-1, 1, 0), v3(1, 1, 0));
    assert.equal(degenerate.s, 0);
    assert.ok(Math.abs(degenerate.t - 0.5) < 1e-9);
  });

  test('両端が一致するカプセルどうしの掃引が、掃引球と一致する', () => {
    const cases: readonly (readonly [number, number, number])[] = [
      [-10, 10, 2], [-3, 4, 2], [-10, -3, 2],
    ];
    for (const [from, to, radiusSum] of cases) {
      const sphere = sweptSphereToi(v3(), v3(), v3(from, 0, 0), v3(to, 0, 0), radiusSum);
      const capsule = sweptCapsuleToi(
        sphereAsSweptCapsule(v3(), v3(), radiusSum / 2),
        sphereAsSweptCapsule(v3(from, 0, 0), v3(to, 0, 0), radiusSum / 2),
      );
      if (sphere === null) {
        assert.equal(capsule, null, `${from}→${to}`);
        continue;
      }
      assert.ok(capsule, `${from}→${to}`);
      assert.ok(Math.abs(capsule.toi - sphere.toi) < 1e-5, `${capsule.toi} vs ${sphere.toi}`);
      // 法線は sweptSphereToi が a→b で答えるのと同じ向き。
      assert.ok(capsule.normal.x * sphere.normal.x > 0);
    }
  });

  test('細長い機体を1フレームで貫く弾が、機体に収まる外接球では捕まらずカプセルでは捕まる', () => {
    // 半径 1 m・長さ 40 m の細長い機体。機体に収まる外接球は半径 1 m の1つしかない。
    const hull = still(v3(0, 0, -20), v3(0, 0, 20), 1);
    // 尾部(z = 15)を横切る弾。1フレームで機体を貫通し、両端は機体の外にある。
    const bulletStart = v3(-50, 0, 15);
    const bulletEnd = v3(50, 0, 15);
    assert.equal(sweptSphereToi(v3(), v3(), bulletStart, bulletEnd, 1 + 0.1), null);
    const hit = sweptCapsuleSphereToi(hull, bulletStart, bulletEnd, 0.1);
    assert.ok(hit);
    // 弾の中心が x = −1.1 に達する時刻。
    assert.ok(Math.abs(hit.toi - (50 - 1.1) / 100) < 1e-3, `toi ${hit.toi}`);
    assert.ok(hit.normal.x < 0);
  });

  test('軸から外れて通り過ぎる弾は、機体を包む大きな球なら当たるがカプセルでは当たらない', () => {
    const hull = still(v3(0, 0, -20), v3(0, 0, 20), 1);
    const start = v3(-50, 5, 15);
    const end = v3(50, 5, 15);
    // 機体全体を包む半径 20 m の球なら、この軌跡は球を貫く。
    assert.ok(sweptSphereToi(v3(), v3(), start, end, 20 + 0.1));
    assert.equal(sweptCapsuleSphereToi(hull, start, end, 0.1), null);
  });

  test('カプセル対カプセル: 平行・直交・ねじれの位置', () => {
    const target = still(v3(-5, 0, 0), v3(5, 0, 0), 1);
    // 平行に接近して触れる。
    const parallel = sweptCapsuleToi(target, {
      aStart: v3(-5, 10, 0), bStart: v3(5, 10, 0), aEnd: v3(-5, 0, 0), bEnd: v3(5, 0, 0), radius: 1,
    });
    assert.ok(parallel);
    assert.ok(Math.abs(parallel.toi - 0.8) < 1e-3, `toi ${parallel.toi}`);
    assert.ok(parallel.normal.y > 0.99);
    // 直交して差し込む。
    const perpendicular = sweptCapsuleToi(target, {
      aStart: v3(0, 10, -5), bStart: v3(0, 10, 5), aEnd: v3(0, 0, -5), bEnd: v3(0, 0, 5), radius: 1,
    });
    assert.ok(perpendicular);
    assert.ok(Math.abs(perpendicular.toi - 0.8) < 1e-3, `toi ${perpendicular.toi}`);
    // ねじれの位置。z = 3 の高さを x 軸に直交して通るので、軸どうしは交わらない。
    const skew = sweptCapsuleToi(target, {
      aStart: v3(0, 10, 3), bStart: v3(0, 10, 3), aEnd: v3(0, 0, 3), bEnd: v3(0, 0, 3), radius: 1,
    });
    // 軸間距離 3 は半径和 2 を超えるので触れない。
    assert.equal(skew, null);
  });

  test('すれ違いは偽陽性にならず、開始時点の重なりは離散 solver へ委ねる', () => {
    const target = still(v3(-5, 0, 0), v3(5, 0, 0), 1);
    assert.equal(sweptCapsuleSphereToi(target, v3(-20, 3, 0), v3(20, 3, 0), 0.5), null);
    // 開始時点で軸の上に重なっている。
    assert.equal(sweptCapsuleSphereToi(target, v3(0, 0, 0), v3(20, 0, 0), 0.5), null);
  });

  test('非有限な入力は接触なしになる', () => {
    const target = still(v3(-5, 0, 0), v3(5, 0, 0), 1);
    assert.equal(sweptCapsuleSphereToi(target, v3(NaN, 0, 0), v3(20, 0, 0), 0.5), null);
    assert.equal(sweptCapsuleSphereToi(target, v3(-20, 0, 0), v3(20, 0, 0), NaN), null);
  });
}
