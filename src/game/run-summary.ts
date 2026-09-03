// ランの外側が一覧へ描くための、いまのランの要約。索引の形は知らない — 素の値だけを返し、
// どう並べてどう見せるかは受け取った側が決める。
import type { Game } from './game';
import type { GamePhase } from './stages/stage';
import { orbitInfo } from './orbit-info';
import { autoOrbitReference } from './orbit-reference';

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

// 自機が居ない周回でも値が欠けないよう、軌道の項は星系の原点へ寄せる。
export function runSummaryOf(game: Game): RunSummary {
  const player = game.player;
  const celestial = game.celestialSystem;
  const info = player === null ? null : orbitInfo(
    player,
    autoOrbitReference(player.state.r, celestial.celestialMotions, player.state.t),
    player.state.t, (id: string) => celestial.nameOf(id),
  );
  return {
    simTime: game.simTime,
    phase: game.activeStage.phase,
    centerBodyId: info ? info.centerId : celestial.origin.id,
    centerBodyName: info ? info.centerName : celestial.nameOf(celestial.origin.id),
    altitude: info ? info.alt : 0,
    speed: info ? info.spd : 0,
    hpRatio: player !== null && player.maxHp > 0 ? Math.max(0, player.hp) / player.maxHp : 0,
    maxHp: player ? player.maxHp : 0,
    magazines: player ? player.magsLeft : 0,
    money: game.dynamicSystem.bases.reduce((sum, b) => sum + b.baseState.money, 0),
    playerCount: game.dynamicSystem.players.length,
    enemyAliveCount: game.dynamicSystem.enemies.filter((e) => e.alive).length,
  };
}
