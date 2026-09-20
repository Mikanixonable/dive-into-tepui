// 1周回の戦果を記録するインターフェース。敵の撃破と自然損耗、自機の喪失、自機の射撃と敵への命中を記録する。
import type { Enemy } from '../dynamic/dynamic-entity/enemy';

// 敵が失われた理由。'killed' 以外は自然損耗で、撃破数ではなく喪失数へ数える。
// 焼失(大気)と衝突(固体表面)は別の現象なので分けて持つ。
export type EnemyDeathCause = 'killed' | 'burnup' | 'collision' | 'despawn';

export interface StageOutcome {
  // 自機の発砲を1発数える。
  recordShot(): void;
  // 敵への命中を1発数える。
  recordHit(): void;
  // 敵1体の消滅を記録する。cause 省略時は撃破として数える。
  recordEnemyDeath(enemy: Enemy, simTime: number, cause?: EnemyDeathCause): void;
  // 自機の喪失を記録し、reason を結果画面の本文に添える。
  recordPlayerLost(reason: string): void;
}
