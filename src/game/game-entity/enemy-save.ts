import type { EnemySaveData } from '../save-data';
import type { Enemy } from './enemy';

// Enemy の現在状態をセーブデータへ変換する。
export function serializeEnemy(enemy: Enemy): EnemySaveData {
  return {
    id: enemy.id,
    name: enemy.name,
    kind: 'enemy',
    r: { ...enemy.state.r },
    v: { ...enemy.state.v },
    q: { ...enemy.att.q },
    w: { ...enemy.att.w },
    enemyKind: enemy.enemyKind,
    alive: enemy.alive,
    health: enemy.hp,
    accent: enemy.accent,
    waveId: enemy.waveId,
    ...(enemy.formationId === undefined ? {} : { formationId: enemy.formationId }),
    ...(enemy.formationRole === undefined ? {} : { formationRole: enemy.formationRole }),
    burstLeft: enemy.burstLeft,
    burstDelay: enemy.burstDelay,
    showTrajectoryLine: enemy.showTrajectoryLine,
    protein: enemy.proteinRuntime?.combat.serialize(),
  };
}
