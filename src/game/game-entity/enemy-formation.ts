// タンパク質陣形における敵の役割と、陣形内の生存状況に基づく供給条件を扱う。
export type FormationRole = 'attacker' | 'shield' | 'energy';

type FormationEnemyStatus = {
  readonly alive: boolean;
  readonly formationId?: string;
  readonly formationRole?: FormationRole;
};

// 陣形の攻撃担当だけが必要とする、同じ陣形内の生存エネルギー役を都度集計する。
// formationId が無い敵は単体敵として、従来どおり供給条件を満たすものとする。
export function isFormationEnergyAvailable(
  formationRole: FormationRole | undefined,
  formationId: string | undefined,
  enemies: readonly FormationEnemyStatus[],
): boolean {
  if (formationRole !== 'attacker' || formationId === undefined) return true;
  return enemies.some((enemy) => (
    enemy.alive && enemy.formationId === formationId && enemy.formationRole === 'energy'
  ));
}
