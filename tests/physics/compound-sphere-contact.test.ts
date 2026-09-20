// surface proxy の掃引は exact shape の候補を落とさず、球の直接 TOI を返すことを確認する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { kinematicState } from '../../src/physics/kinematic-state';
import { v3 } from '../../src/math/vec3';
import {
  sweptCompoundSphereContact,
  type CompoundSphereShape,
} from '../../src/physics/compound-sphere-contact';

function state(t: number, x: number): ReturnType<typeof kinematicState<'eci'>> {
  return kinematicState<'eci'>(t, v3(x, 0, 0), v3(20, 0, 0));
}

function proxy(moduleId = 'tank', center = v3(3, 0, 0), radius = 1): CompoundSphereShape {
  return { primitives: [{ moduleId, center, radius }] };
}

export function register(): void {
  test('compound-sphere: local center の回転不変 envelope から最初の TOI を求める', () => {
    const hit = sweptCompoundSphereContact(
      proxy(), state(0, -10), state(1, 10), state(0, 0), state(1, 0), 0.2,
    );
    assert.ok(hit !== null);
    assert.equal(hit.moduleIdA, 'tank');
    assert.ok(Math.abs(hit.toi - 0.29) < 1e-10, `toi=${hit.toi}`);
  });

  test('compound-sphere: 同時刻は moduleId の辞書順で決定する', () => {
    const shape: CompoundSphereShape = {
      primitives: [
        { moduleId: 'z', center: v3(), radius: 1 },
        { moduleId: 'a', center: v3(), radius: 1 },
      ],
    };
    const hit = sweptCompoundSphereContact(
      shape, state(0, 0), state(0, 0), state(0, 0), state(0, 0), 0.2,
    );
    assert.equal(hit?.moduleIdA, 'a');
    assert.equal(hit?.toi, 0);
  });

  test('compound-sphere: 空・不正 shape は候補なしとして扱う', () => {
    assert.equal(sweptCompoundSphereContact(
      { primitives: [] }, state(0, -1), state(1, 1), state(0, 0), state(1, 0), 1,
    ), null);
    assert.equal(sweptCompoundSphereContact(
      { primitives: [{ moduleId: '', center: v3(), radius: 1 }] },
      state(0, -1), state(1, 1), state(0, 0), state(1, 0), 1,
    ), null);
  });
}
