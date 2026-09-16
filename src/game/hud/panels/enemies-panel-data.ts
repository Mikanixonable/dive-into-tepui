// CONTACTS パネルへ渡す値を、ゲーム状態からこのフレームの表示モデルへ組み立てる。
import { len, sub, type Vec3 } from '../../../math/vec3';
import { isEnemy, type Enemy } from '../../dynamic/dynamic-entity/enemy';
import type { CombatTarget } from '../../dynamic/dynamic-entity/combat-target';
import type { Controllable } from '../../dynamic/dynamic-entity/controllable';
import type { StageOutcome } from '../../stages/stage-outcome';
import type { EntityRoster } from '../../dynamic/entity-roster';
import type { Targeter } from '../../targeter';
import type { EnemiesPanelViewModel, EnemyRow } from './enemies-panel';

// waveId を持つ敵ごとに「第N波」1行へ集約して組み立てる。
// waveId 不在の敵は個別の行になる。ターゲットが波のメンバーなら、その波の行を強調する側に倒す。
function buildEnemyRows(
  enemies: readonly Enemy[], viewerPositionEci: Vec3, primaryTarget: CombatTarget | null,
): EnemyRow[] {
  const singles: EnemyRow[] = [];
  const waves = new Map<number, { count: number; nearestDistanceM: number; targeted: boolean }>();
  for (const enemy of enemies) {
    const distanceM = len(sub(enemy.motion.state.r, viewerPositionEci));
    const targeted = enemy === primaryTarget;
    if (enemy.waveId === undefined) {
      singles.push({ kind: 'single', id: enemy.id, name: enemy.name, distanceM, targeted });
      continue;
    }
    const waveSummary = waves.get(enemy.waveId);
    if (!waveSummary) {
      waves.set(enemy.waveId, { count: 1, nearestDistanceM: distanceM, targeted });
    } else {
      waveSummary.count += 1;
      waveSummary.nearestDistanceM = Math.min(waveSummary.nearestDistanceM, distanceM);
      waveSummary.targeted = waveSummary.targeted || targeted;
    }
  }
  const waveRows: EnemyRow[] = Array.from(waves.entries()).map(([waveId, waveSummary]) => ({
    kind: 'wave', waveId, count: waveSummary.count,
    distanceM: waveSummary.nearestDistanceM, targeted: waveSummary.targeted,
  }));
  return [...singles, ...waveRows].sort((a, b) => a.distanceM - b.distanceM);
}

// CONTACTS パネルが読む値を作る。null は操作対象が存在しない状態を表す。
export function enemiesPanelView(
  viewer: Controllable | null, activeStage: StageOutcome, roster: EntityRoster,
  targeter: Targeter, isMapView: boolean,
): EnemiesPanelViewModel | null {
  if (!viewer) return null;
  const { kills, totalEnemiesSpawned } = activeStage.scoreCounter;
  const rows = buildEnemyRows(
    roster.all().filter(isEnemy).filter((enemy) => enemy.motion.alive),
    viewer.motion.state.r,
    targeter.aliveTarget,
  );
  return {
    remainingCount: totalEnemiesSpawned - kills,
    totalEnemiesSpawned,
    rows,
    isMapView,
  };
}
