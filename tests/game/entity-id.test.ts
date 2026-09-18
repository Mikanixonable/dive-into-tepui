// 実体 id の採番器の直列化が、保存前に払い出した id を復元後に払い出させないことを検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { EntityIdAllocators, type EntityIdAllocator } from '../../src/game/dynamic/dynamic-entity/entity-id';

// allocators が種別ごとに持つ採番器。
function allocatorsOf(allocators: EntityIdAllocators): readonly EntityIdAllocator[] {
  return [allocators.entity, allocators.base, allocators.ammoPickup, allocators.rcsFuelPickup, allocators.booster];
}

export function register(): void {
  test('entity-id: 復元した採番器は、保存前に払い出した id をどの種別でも払い出さない', () => {
    // CODING-RULE R11: 復元した id から数え直す採番は、作り直すと保存前と違う値になる正本である
    const allocators = new EntityIdAllocators();
    const issued = new Set<string>();
    for (const allocator of allocatorsOf(allocators)) {
      issued.add(allocator.next());
      issued.add(allocator.next());
    }
    // 記録から戻した個体の id を採用したぶんも、払い出した id に数える。
    issued.add(allocators.entity.next('entity-9'));

    // 採用した番号を追い越すまで払い出す。
    const restored = EntityIdAllocators.deserialize(allocators.serialize());
    for (const allocator of allocatorsOf(restored)) {
      for (let i = 0; i < 10; i++) {
        const id = allocator.next();
        assert.ok(!issued.has(id), id);
      }
    }
  });
}
