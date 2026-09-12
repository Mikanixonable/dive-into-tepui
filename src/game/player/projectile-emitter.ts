import type { DynamicEntity } from '../dynamic/dynamic-entity/dynamic-entity';

// 射撃側が「弾を作った」ことだけを通知する出力ポート。登録方法や上限管理は所有者が決める。
export interface ProjectileEmitter {
  emit(projectile: DynamicEntity): void;
}
