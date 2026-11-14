// 1周回の戦果を記録するインターフェース。敵の撃破と自然損耗、自機の喪失、自機の射撃と敵への命中を記録する。
import type { Enemy } from '../dynamic/dynamic-entity/enemy';

// 敵が失われた理由。'killed' 以外は自然損耗で、撃破数ではなく喪失数へ数える。
// 焼失(大気)と衝突(固体表面)は別の現象なので分けて持つ。
export type EnemyDeathCause = 'killed' | 'burnup' | 'collision' | 'despawn';

// 自機を失った原因の種類。結果画面の助言を決める。
export type PlayerLossCause = 'surface' | 'structural' | 'heatSaturated' | 'heatOverload';

export interface StageOutcome {
  // 艦の軌道計画を自動実行(自動操縦・理想実行)させるステージか。
  readonly executesPlans: boolean;
  // 攻撃グループの中で同時に発砲してよい敵の数。
  readonly enemyAttackLimit: number;
  // 自機の発砲を1発数える。
  recordShot(): void;
  // 敵への命中を1発数える。
  recordHit(): void;
  // 敵1体の消滅を記録する。cause 省略時は撃破として数える。
  recordEnemyDeath(enemy: Enemy, simTime: number, cause?: EnemyDeathCause): void;
  // 自機の喪失を記録し、reason を結果画面の本文に添える。cause は助言を決める。
  recordPlayerLost(reason: string, cause: PlayerLossCause): void;
}
