// 敵の攻撃グループ判定に必要な、Enemy本体から独立した読み取り契約。
export interface EnemyAttackGroupMember {
  readonly motion: { readonly alive: boolean };
  readonly attackGroupId: string;
  readonly isBursting: boolean;
}

// 同じ攻撃グループに属する、現在バースト中の敵機数を数える。
export function countAttackingEnemiesInGroup(
  enemies: readonly EnemyAttackGroupMember[], groupId: string,
): number {
  let count = 0;
  for (const enemy of enemies) {
    if (enemy.motion.alive && enemy.attackGroupId === groupId && enemy.isBursting) count++;
  }
  return count;
}
