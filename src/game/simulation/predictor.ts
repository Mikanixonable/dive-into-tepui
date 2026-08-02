// 全 GameEntity の予測列(predicted)をフレームあたりの予算内でラウンドロビンに伸ばす。
// 予測列の長短を問わず一律に扱うため、破棄が多発してもフレーム時間がスパイクしない。
import * as C from '../const';
import { EntityManager } from './entity-manager';
import { GameEntity } from '../game-entity/game-entity';
import { Player } from '../player/player';
import { Ephemeris } from '../../physics/ephemeris';
import { len } from '../../physics/vec3';

export class Predictor {
  private cursor = 0;

  constructor(
    private readonly entities: EntityManager,
    private readonly ephemeris: Ephemeris,
  ) {}

  // Game.update の entities.cleanup(...) の後に呼ぶ(死んだ個体を予測しない、積分後の実状態と
  // 突き合わせる)。視点・モードによる条件分岐は持たない — 予測は表示とは独立に常時進む。
  update(simTime: number, player: Player): void {
    const all = this.entities.all();

    // (a) 距離判定は毎フレーム無条件で全対象に行う(二分探索1回ぶんの費用しかかからない)。
    for (const e of all) e.resyncPrediction(simTime, C.PREDICT_RESET_DIST);

    // 予算配分: 操作対象の艦を先頭に、以降はカーソル位置から最大1周だけ回す。
    let budget = C.PREDICT_STEP_BUDGET;
    budget -= this.advanceBudget(player, budget, simTime);

    let visited = 0;
    while (budget > 0 && visited < all.length) {
      const e = all[(this.cursor + visited) % all.length]!;
      budget -= this.advanceBudget(e, budget, simTime);
      visited++;
    }
    this.cursor = all.length > 0 ? (this.cursor + visited) % all.length : 0;
  }

  // budgetSteps を上限に、1体ぶんの予測列を GameEntity.stepPrediction で1ステップずつ伸ばし、
  // 消費したステップ数を返す。刻み幅(stepDtForRadius)は毎ステップ、現在の予測先端の動径から
  // 求め直す(先端がまだ無ければ現在状態の動径で代用 — 生成直後は current.state を種にするので
  // 同じ値になる)。ここが「刻み幅を決めてから1ステップぶん渡す」側、entity 側は「渡された dt で
  // 実際に1ステップ進めるか判断する」側 — stepSim に対する simulationSubStep と同じ分担。
  // ホライズン超過などで stepPrediction が false を返したら、そのエンティティの予算消化を打ち切る。
  private advanceBudget(e: GameEntity, budgetSteps: number, simTime: number): number {
    let consumed = 0;
    while (consumed < budgetSteps) {
      const tipR = e.predicted?.state.r ?? e.state.r;
      const dt = Math.max(C.PREDICT_MIN_STEP_DT, stepDtForRadius(len(tipR)));
      if (!e.stepPrediction(this.ephemeris, simTime, dt)) break;
      consumed++;
    }
    return consumed;
  }
}

// 動径から刻み幅を決める(低軌道では細かく、遠方では粗く)。LEO(~6.8e6m)で約8.5s。
function stepDtForRadius(r: number): number {
  return Math.max(5, Math.min(600, r / 8e5));
}
