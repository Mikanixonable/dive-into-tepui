import type { DynamicEntity } from '../dynamic/dynamic-entity/dynamic-entity';
import type { EntityIdAllocators } from '../dynamic/dynamic-entity/entity-id';

// 射撃側が「弾を作った」ことだけを通知する出力ポート。登録方法や上限管理は所有者が決める。
// 採番器は弾自身の識別子に要るので、作る側が同じポートから受け取る。
export interface ProjectileEmitter {
  readonly idAllocators: EntityIdAllocators;
  emit(projectile: DynamicEntity): void;
}
