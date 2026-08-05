import * as assert from 'node:assert/strict';
import { sweptSphereToi } from '../../src/physics/swept-sphere';
import { v3 } from '../../src/physics/vec3';
import { test } from './harness';

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
}
