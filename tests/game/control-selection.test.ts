// 操作対象の復元が、不在・撃破済みの id を安全に生存中の対象へ畳むことを検査する。
import * as assert from 'node:assert/strict';
import { ControlSelection } from '../../src/game/control-selection';
import type { Controllable } from '../../src/game/dynamic/dynamic-entity/controllable';
import type { DynamicSystem } from '../../src/game/dynamic/dynamic-system';
import { test } from '../harness';

function controllable(id: string, alive: boolean): Controllable {
  return { id, motion: { alive } } as unknown as Controllable;
}

function dynamicSystem(controllables: readonly Controllable[]): DynamicSystem {
  return { controllables } as unknown as DynamicSystem;
}

export function register(): void {
  test('control-selection: 不在または撃破済みの保存 id は生存中の先頭へ復元する', () => {
    const dead = controllable('dead', false);
    const survivor = controllable('survivor', true);
    const system = dynamicSystem([dead, survivor]);

    assert.equal(ControlSelection.deserialize('missing', system).current, survivor);
    assert.equal(ControlSelection.deserialize('dead', system).current, survivor);
  });

  test('control-selection: null の保存値は未操作状態を保つ', () => {
    const survivor = controllable('survivor', true);
    assert.equal(ControlSelection.deserialize(null, dynamicSystem([survivor])).current, null);
  });
}
