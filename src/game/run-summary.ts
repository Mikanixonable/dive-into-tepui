// いまのランの要約。
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
