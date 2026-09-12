// 1周回の戦果を記録する面。敵の撃破と自然損耗、自機の喪失を受け取り、発射・命中の集計を差し出す。
import type { Enemy } from '../dynamic/dynamic-entity/enemy';
import type { ScoreCounter } from './stage-utils/score-counter';

// 敵が失われた理由。'killed' 以外は自然損耗で、撃破数ではなく喪失数へ数える。
// 焼失(大気)と衝突(固体表面)は別の現象なので分けて持つ。
export type EnemyDeathCause = 'killed' | 'burnup' | 'collision' | 'despawn';

export interface StageOutcome {
  readonly scoreCounter: ScoreCounter;
  // 敵1体の消滅を記録する。cause 省略時は撃破として数える。
  recordEnemyDeath(enemy: Enemy, simTime: number, cause?: EnemyDeathCause): void;
  // 自機の喪失を記録し、reason を結果画面の本文に添える。
  recordPlayerLost(reason: string): void;
}
