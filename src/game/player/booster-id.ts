import { EntityIdAllocator } from '../game-entity/entity-id';

const allocator = new EntityIdAllocator('booster-');

// 接続中の段と分離後エンティティで同じ ID を引き継ぐ。
export function nextBoosterId(restoredId?: string): string {
  return allocator.next(restoredId);
}
