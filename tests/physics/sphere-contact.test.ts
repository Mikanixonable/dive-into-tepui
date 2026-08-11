import * as assert from 'node:assert/strict';
import { containingBody, sweptHermiteSphereToi, sweptSphereToi } from '../../src/physics/sphere-contact';
import { kinematicState } from '../../src/physics/kinematic-state';
import { v3 } from '../../src/physics/vec3';
import { test } from './harness';
import type { Attractor } from '../../src/physics/attractor';

export function register(): void {
  test('swept sphere: catches a complete pass-through in one frame', () => {
    const hit = sweptSphereToi(v3(), v3(), v3(-10, 0, 0), v3(10, 0, 0), 2);
    assert.ok(hit);
    assert.ok(Math.abs(hit.toi - 0.4) < 1e-12);
    assert.deepEqual(hit.normal, v3(-1, 0, 0));
  });

  test('swept sphere: catches the same crossing when frame interval is split', () => {
    assert.equal(sweptSphereToi(v3(), v3(), v3(-10, 0, 0), v3(-3, 0, 0), 2), null);
    const hit = sweptSphereToi(v3(), v3(), v3(-3, 0, 0), v3(4, 0, 0), 2);
    assert.ok(hit);
    assert.ok(Math.abs(hit.toi - 1 / 7) < 1e-12);
  });

  test('swept sphere: misses a near pass and delegates initial overlap to discrete solver', () => {
    assert.equal(sweptSphereToi(v3(), v3(), v3(-10, 3, 0), v3(10, 3, 0), 2), null);
    assert.equal(sweptSphereToi(v3(), v3(), v3(1, 0, 0), v3(3, 0, 0), 2), null);
  });

  test('Hermite swept sphere: detects a moving-body pass when both endpoints are outside', () => {
    const prev = kinematicState(0, v3(-10, 0, 0), v3(20, 0, 0));
    const next = kinematicState(1, v3(10, 0, 0), v3(20, 0, 0));
    const toi = sweptHermiteSphereToi(prev, next, v3(0, -10, 0), v3(0, 10, 0), 2);
    assert.ok(toi !== null);
    const expected = 0.5 - Math.sqrt(2) / 20;
    assert.ok(Math.abs(toi - expected) < 1e-6, `unexpected moving-body TOI: ${toi}`);
  });

  test('Hermite swept sphere: does not report an initial overlap', () => {
    const prev = kinematicState(0, v3(1, 0, 0), v3(1, 0, 0));
    const next = kinematicState(1, v3(3, 0, 0), v3(1, 0, 0));
    assert.equal(sweptHermiteSphereToi(prev, next, v3(), v3(), 2), null);
  });

  // 弦は天体から離れているのに Hermite 曲線が膨らんで天体を掠める配置。掃引前の棄却が
  // 弦の長さで近似されていると、この通過を取りこぼす。
  test('Hermite swept sphere: 弦は外れていても曲線が膨らんで届く通過を捕まえる', () => {
    const prev = kinematicState(0, v3(-1000, 900, 0), v3(3000, -5400, 0));
    const next = kinematicState(1, v3(1000, 900, 0), v3(3000, 5400, 0));
    assert.equal(sweptSphereToi(v3(), v3(), v3(-1000, 900, 0), v3(1000, 900, 0), 700), null);
    const toi = sweptHermiteSphereToi(prev, next, v3(), v3(), 700);
    assert.ok(toi !== null && toi > 0 && toi < 1, `unexpected bulge TOI: ${toi}`);
  });

  test('Hermite swept sphere: 制御点の箱ごと球から離れた天体は null', () => {
    const prev = kinematicState(0, v3(-10, 0, 0), v3(20, 0, 0));
    const next = kinematicState(1, v3(10, 0, 0), v3(20, 0, 0));
    assert.equal(sweptHermiteSphereToi(prev, next, v3(1e9, 0, 0), v3(1e9, 0, 0), 1000), null);
  });

  test('containingBody: 半径内の点はその球を返す', () => {
    const earth: Attractor = {
      id: 'earth', mu: 1, radius: 6.371e6, state: kinematicState(0, v3(), v3()), degree2: null, isStar: false,
    };
    assert.equal(containingBody(v3(6.371e6 - 1, 0, 0), [earth], 0), earth);
  });

  test('containingBody: 半径外の点は null', () => {
    const earth: Attractor = {
      id: 'earth', mu: 1, radius: 6.371e6, state: kinematicState(0, v3(), v3()), degree2: null, isStar: false,
    };
    assert.equal(containingBody(v3(6.371e6 + 1, 0, 0), [earth], 0), null);
  });

  test('containingBody: margin ぶん半径の外側まで内側とみなす', () => {
    const earth: Attractor = {
      id: 'earth', mu: 1, radius: 6.371e6, state: kinematicState(0, v3(), v3()), degree2: null, isStar: false,
    };
    assert.equal(containingBody(v3(6.371e6 + 500, 0, 0), [earth], 1000), earth);
    assert.equal(containingBody(v3(6.371e6 + 1500, 0, 0), [earth], 1000), null);
  });

  // 非有限な入力(始点・終点の位置・半径和)はどれも null へ落ちることを固定する —
  // resolveSphereCollision と同じ「参加者フィルタが破れても伝播しない」最後の砦。
  test('swept sphere: 始点が非有限なら null', () => {
    assert.equal(sweptSphereToi(v3(NaN, 0, 0), v3(0, 0, 0), v3(-10, 0, 0), v3(10, 0, 0), 2), null);
  });

  test('swept sphere: 終点が非有限なら null', () => {
    assert.equal(sweptSphereToi(v3(0, 0, 0), v3(NaN, 0, 0), v3(-10, 0, 0), v3(10, 0, 0), 2), null);
  });

  test('swept sphere: 半径和が非有限なら null', () => {
    assert.equal(sweptSphereToi(v3(0, 0, 0), v3(0, 0, 0), v3(-10, 0, 0), v3(10, 0, 0), NaN), null);
  });

  test('containingBody: 複数の球から最初に触れているものを返す', () => {
    const near: Attractor = {
      id: 'near', mu: 1, radius: 1000, state: kinematicState(0, v3(), v3()), degree2: null, isStar: false,
    };
    const far: Attractor = {
      id: 'far', mu: 1, radius: 1000, state: kinematicState(0, v3(1e6, 0, 0), v3()), degree2: null, isStar: false,
    };
    assert.equal(containingBody(v3(1e6, 0, 0), [near, far], 0), far);
    assert.equal(containingBody(v3(5e5, 0, 0), [near, far], 0), null);
  });
}
