import type { EnemySaveData } from '../../save/save-data';
import type { Enemy } from './enemy';

// Enemy の現在状態をセーブデータへ変換する責務を持つ。
export function serializeEnemy(enemy: Enemy): EnemySaveData {
  return {
    id: enemy.id,
    name: enemy.name,
    kind: 'enemy',
    // 運動状態・姿勢。
    r: { ...enemy.state.r },
    v: { ...enemy.state.v },
    q: { ...enemy.att.q },
    w: { ...enemy.att.w },
    enemyKind: enemy.enemyKind,
    alive: enemy.alive,
    health: enemy.hp,
    accent: enemy.accent,
    orbitLineColor: enemy.orbitLineColor,
    waveId: enemy.waveId,
    // 陣形所属は無所属の単体敵も多いため、値がある場合だけキーを持たせる。
    ...(enemy.formationId === undefined ? {} : { formationId: enemy.formationId }),
    ...(enemy.formationRole === undefined ? {} : { formationRole: enemy.formationRole }),
    burstLeft: enemy.burstLeft,
    burstDelay: enemy.burstDelay,
    showTrajectoryLine: enemy.showTrajectoryLine,
    protein: enemy.proteinRuntime?.combat.serialize(),
  };
}
