// いまのランの要約と、その組み立て。
import { isEnemy } from './dynamic/dynamic-entity/enemy';
import { isModularShip } from './ship/modular-ship';
import { autoOrbitReference } from './orbit-reference';
import { orbitInfo } from './orbit-info';
import type { CelestialBodies } from './celestial/celestial-bodies';
import type { Controllable } from './dynamic/dynamic-entity/controllable';
import type { DynamicEntity } from './dynamic/dynamic-entity/dynamic-entity';
import type { GamePhase } from './stages/stage';

export interface RunSummary {
  readonly simTime: number;
  readonly phase: GamePhase;
  // 自機の軌道の中心天体。自機が居なければ星系の原点。
  readonly centerBodyId: string;
  readonly centerBodyName: string;
  readonly altitude: number;
  readonly speed: number;
  // 自機が居なければ 0。
  readonly hpRatio: number;
  readonly maxHp: number;
  readonly magazines: number;
  readonly playerCount: number;
  readonly enemyAliveCount: number;
}

// いまの状態から1周回ぶんの要約を組む。自機が居ない周回では、軌道の項を星系の原点で埋める。
export function summarizeRun(
  simTime: number, phase: GamePhase, controlled: Controllable | null,
  celestial: CelestialBodies, entities: readonly DynamicEntity[],
): RunSummary {
  // 操作対象が存在する周回であれば、軌道情報も対象オブジェクトから算出する。
  const info = controlled === null ? null : orbitInfo(
    controlled,
    autoOrbitReference(
      controlled.motion.state.r, celestial.celestialMotions, controlled.motion.state.t,
    ),
    controlled.motion.state.t, (id: string) => celestial.nameOf(id),
  );
  return {
    simTime,
    phase,
    centerBodyId: info ? info.centerId : celestial.originId,
    centerBodyName: info ? info.centerName : celestial.nameOf(celestial.originId),
    altitude: info ? info.alt : 0,
    speed: info ? info.spd : 0,
    hpRatio: controlled !== null && controlled.hp !== null && controlled.maxHp !== null && controlled.maxHp > 0
      ? Math.max(0, controlled.hp) / controlled.maxHp
      : 0,
    maxHp: controlled?.maxHp ?? 0,
    magazines: controlled?.fire?.mags ?? 0,
    playerCount: entities.filter(isModularShip).length,
    enemyAliveCount: entities.filter(isEnemy).filter((e) => e.motion.alive).length,
  };
}
