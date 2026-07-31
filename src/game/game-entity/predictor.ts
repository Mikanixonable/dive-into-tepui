// 全 GameEntity の予測列(predicted)を、フレームあたりの予算内でなるはやに伸ばす。EntityManager
// の参照を受け取ってその配列を更新する点は Simulator と同じパターン(EntityManager から見て
// 「実シミュレーション」と「予測」は対称な2人目の更新者 — better_predict.md §3-5)。持つ状態は
// ラウンドロビンのカーソルだけ。どの列が短いか(新規スポーンなのか、破棄されたばかりなのか)を
// 区別しない — 区別しないからこそ、破棄がいくら起きてもこのクラスのフレーム時間はスパイクしない
// (短い予算をなるはやで使い切るだけで、リソースが足りなければ後回しになる)。
import * as C from '../const';
import { EntityManager } from './entity-manager';
import { GameEntity } from './game-entity';
import { Player } from '../player/player';
import { Ephemeris } from '../../physics/ephemeris';
import { predictStepDt } from '../../physics/predict';
import { len } from '../../physics/vec3';

export class Predictor {
  // 次フレームにどのエンティティから予算を配り始めるか(EntityManager.all() のインデックス)。
  private cursor = 0;

  constructor(
    private readonly entities: EntityManager,
    private readonly ephemeris: Ephemeris,
  ) {}

  // Game.update の entities.cleanup(...) の後に呼ぶ(死んだ個体を予測しない、積分後の実状態と
  // 突き合わせる)。視点・モードによる条件分岐は持たない — 予測は表示とは独立に常時進む。
  update(simTime: number, player: Player): void {
    const rest = this.entities.all();

    // (a) 距離判定は毎フレーム無条件で全対象に行う(二分探索1回ぶんの費用しかかからない)。
    player.resyncPrediction(simTime, C.PREDICT_RESET_DIST);
    for (const e of rest) e.resyncPrediction(simTime, C.PREDICT_RESET_DIST);

    // 予算配分: 自機を先頭に、以降はカーソル位置から最大1周だけ回す。
    let budget = C.PREDICT_STEP_BUDGET;
    budget -= this.advanceBudget(player, budget, simTime);

    let visited = 0;
    while (budget > 0 && visited < rest.length) {
      const e = rest[(this.cursor + visited) % rest.length]!;
      budget -= this.advanceBudget(e, budget, simTime);
      visited++;
    }
    this.cursor = rest.length > 0 ? (this.cursor + visited) % rest.length : 0;
  }

  // budgetSteps を上限に、1体ぶんの予測列を GameEntity.stepPrediction で1ステップずつ伸ばし、
  // 消費したステップ数を返す。刻み幅(predictStepDt)は毎ステップ、現在の予測先端の動径から
  // 求め直す(先端がまだ無ければ現在状態の動径で代用 — 生成直後は current.state を種にするので
  // 同じ値になる)。ここが「刻み幅を決めてから1ステップぶん渡す」側、entity 側は「渡された dt で
  // 実際に1ステップ進めるか判断する」側 — stepSim に対する simulationSubStep と同じ分担。
  // ホライズン超過などで stepPrediction が false を返したら、そのエンティティの予算消化を打ち切る。
  private advanceBudget(e: GameEntity, budgetSteps: number, simTime: number): number {
    let consumed = 0;
    while (consumed < budgetSteps) {
      const tipR = e.predicted?.state.r ?? e.state.r;
      const dt = Math.max(C.PREDICT_MIN_STEP_DT, predictStepDt(len(tipR), e.predictDuration));
      if (!e.stepPrediction(this.ephemeris, simTime, dt)) break;
      consumed++;
    }
    return consumed;
  }
}
