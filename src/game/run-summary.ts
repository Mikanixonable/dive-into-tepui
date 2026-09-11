// いまのランの要約と、その組み立て。
import { isBase } from './dynamic/dynamic-entity/base';
import { isEnemy } from './dynamic/dynamic-entity/enemy';
import { isPlayer } from './player/player';
import { autoOrbitReference } from './orbit-reference';
import { orbitInfo } from './orbit-info';
import type { Game } from './game';
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
  readonly money: number;
  readonly playerCount: number;
  readonly enemyAliveCount: number;
}

// いまの状態から1周回ぶんの要約を組む。自機が居ない周回では、軌道の項を星系の原点で埋める。
export function runSummary(game: Game): RunSummary {
  // 操作対象が居る周回なら、軌道の項もそこから解く。
  const controlled = game.activeControllable;
  const celestial = game.celestialSystem;
  const info = controlled === null ? null : orbitInfo(
    controlled,
    autoOrbitReference(
      controlled.motion.state.r, celestial.celestialMotions, controlled.motion.state.t,
    ),
    controlled.motion.state.t, (id: string) => celestial.nameOf(id),
  );
  const entities = game.dynamicSystem.all();
  return {
    simTime: game.simTime,
    phase: game.activeStage.phase,
    centerBodyId: info ? info.centerId : celestial.originId,
    centerBodyName: info ? info.centerName : celestial.nameOf(celestial.originId),
    altitude: info ? info.alt : 0,
    speed: info ? info.spd : 0,
    hpRatio: controlled !== null && controlled.hp !== null && controlled.maxHp !== null && controlled.maxHp > 0
      ? Math.max(0, controlled.hp) / controlled.maxHp
      : 0,
    maxHp: controlled?.maxHp ?? 0,
    magazines: controlled?.fire?.mags ?? 0,
    money: entities.filter(isBase).reduce((sum, b) => sum + b.money, 0),
    playerCount: entities.filter(isPlayer).length,
    enemyAliveCount: entities.filter(isEnemy).filter((e) => e.motion.alive).length,
  };
}
