import * as assert from 'node:assert/strict';
import { v3 } from '../../src/math/vec3';
import { kinematicState, type KinematicState } from '../../src/physics/kinematic-state';
import {
  casingEntityCollision, casingSweptEntityCollision, casingSphereCollision,
  CASING_COLLISION_BOUND_RADIUS,
} from '../../src/game/dynamic/dynamic-entity/casing-collision';
import { DynamicMotion } from '../../src/game/dynamic/dynamic-motion';
import { test } from '../harness';

function state(x: number, y = 0, z = 0): KinematicState<'eci'> {
  return kinematicState<'eci'>(0, v3(x, y, z), v3());
}

function casingMotion(stateValue: KinematicState<'eci'>): DynamicMotion {
  return new DynamicMotion(stateValue, {
    behavior: {
      contactKind: 'casing',
    } as DynamicMotion['behavior'],
  });
}

export function register(): void {
  test('casing-collision: 外接球が触れない遠方の薬莢ペアは早期棄却され null を返す', () => {
    const a = casingMotion(state(0, 0, 0));
    const b = casingMotion(state(2.0, 0, 0)); // 2.0m > 2 * 0.7816m (~1.563m)

    assert.equal(casingEntityCollision(a, b, a.state, b.state), null);
  });

  test('casing-collision: 外接球が触れうる近傍で実際に触れる薬莢ペアは接触結果を返す', () => {
    const a = casingMotion(state(0, 0, 0));
    const b = casingMotion(state(0.3, 0, 0)); // 半径0.231の2倍以下で触れる

    const hit = casingEntityCollision(a, b, a.state, b.state);
    assert.notEqual(hit, null);
    assert.ok((hit?.pushOut ?? 0) > 0);
  });

  test('casing-collision: 掃引区間で外接球が触れないペアはカプセル判定を呼ばず早期棄却する', () => {
    const a = casingMotion(state(0, 0, 0));
    const b = casingMotion(state(5, 0, 0));

    // 区間中、a は (0,0,0)->(0,1,0)、b は (5,0,0)->(5,1,0) と並進。最近接距離は 5m で触れない
    const prevA = state(0, 0, 0);
    const currA = state(0, 1, 0);
    const prevB = state(5, 0, 0);
    const currB = state(5, 1, 0);

    assert.equal(casingSweptEntityCollision(a, b, prevA, currA, prevB, currB), null);
  });

  test('casing-collision: 掃引区間で交差するペアは掃引接触を返す', () => {
    const a = casingMotion(state(0, 0, 0));
    const b = casingMotion(state(0, 0, 0));

    // a は静止、b は (0, 1.5, 0) から (0, 0.2, 0) へ接近して交差
    const prevA = state(0, 0, 0);
    const currA = state(0, 0, 0);
    const prevB = state(0, 1.5, 0);
    const currB = state(0, 0.2, 0);

    const swept = casingSweptEntityCollision(a, b, prevA, currA, prevB, currB);
    assert.notEqual(swept, null);
    assert.ok(swept!.toi >= 0 && swept!.toi <= 1);
  });

  test('casing-collision: 球との接触でも外接球距離を超える相手は早期棄却する', () => {
    const a = casingMotion(state(0, 0, 0));
    const sphereCenter = v3(CASING_COLLISION_BOUND_RADIUS + 2.0, 0, 0);
    const sphereRadius = 0.5;

    assert.equal(casingSphereCollision(a, sphereCenter, sphereRadius, a.state), null);
  });
}
