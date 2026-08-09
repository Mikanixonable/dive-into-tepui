import * as assert from 'node:assert/strict';
import { containingBody, sweptSphereToi } from '../../src/physics/sphere-contact';
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
