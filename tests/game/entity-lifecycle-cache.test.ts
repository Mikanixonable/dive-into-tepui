// EntityLifecycle の派生一覧キャッシュ。集合が同じ間は配列実体を再利用し、世代が変わったときは
// 以前の読み手が保持する snapshot を書き換えず新しい配列へ切り替えることを固定する。
import * as assert from 'node:assert/strict';
import type * as THREE from 'three/webgpu';
import { test } from '../harness';
import { EntityLifecycle } from '../../src/game/dynamic/entity-lifecycle';
import type { DynamicEntity } from '../../src/game/dynamic/dynamic-entity/dynamic-entity';
import type { DynamicMotion } from '../../src/game/dynamic/dynamic-motion';
import type { CelestialBodies } from '../../src/game/celestial/celestial-bodies';
import type { RunEventSink } from '../../src/game/run-events';

function fakeEntity(id: string, controllable: boolean): DynamicEntity {
  return {
    id,
    capKind: null,
    controllable,
    motion: { alive: true } as unknown as DynamicMotion,
  } as unknown as DynamicEntity;
}

function lifecycle(): EntityLifecycle {
  return new EntityLifecycle(
    {} as unknown as THREE.Scene,
    {} as unknown as RunEventSink,
    {} as unknown as CelestialBodies,
  );
}

export function register(): void {
  test('entity-lifecycle: 同一 collectionRevision では motions/controllables の配列を再利用する', () => {
    const owner = lifecycle();
    const passive = fakeEntity('passive', false);
    const controlled = fakeEntity('controlled', true);
    owner.add(passive);
    owner.add(controlled);

    const motions = owner.allMotions();
    const controllables = owner.controllables;
    assert.equal(owner.allMotions(), motions);
    assert.equal(owner.controllables, controllables);
    assert.deepEqual(motions, [passive.motion, controlled.motion]);
    assert.deepEqual(controllables, [controlled]);
  });

  test('entity-lifecycle: revision 更新後も以前の派生 snapshot は書き換えない', () => {
    const owner = lifecycle();
    const first = fakeEntity('first', false);
    owner.add(first);
    const previousMotions = owner.allMotions();
    const previousControllables = owner.controllables;

    const second = fakeEntity('second', true);
    owner.add(second);
    const nextMotions = owner.allMotions();
    const nextControllables = owner.controllables;

    assert.notEqual(nextMotions, previousMotions);
    assert.notEqual(nextControllables, previousControllables);
    assert.deepEqual(previousMotions, [first.motion]);
    assert.deepEqual(previousControllables, []);
    assert.deepEqual(nextMotions, [first.motion, second.motion]);
    assert.deepEqual(nextControllables, [second]);
  });
}
