// 全 GameEntity の予測列(predictedTrajectory)をフレームあたりの予算内でラウンドロビンに伸ばす。
// 予測列の長短を問わず一律に扱うため、破棄が多発してもフレーム時間がスパイクしない。
import * as C from '../const';
import { EntityManager } from './entity-manager';
import { GameEntity } from '../game-entity/game-entity';
import { Player } from '../player/player';
import { Ephemeris } from '../../physics/ephemeris';
import { localOrbitPeriod } from '../../physics/attractor';
import { ClassifiedAttractors, attractorsNear, classifyAttractors, predictedAttractorsAt } from './attractors';

export class Predictor {
  private cursor = 0;

  // 直近の update() で数えた予測列の状況(?perf=1 の表示用)。
  tracked = 0; // 予測対象の個体数
  finished = 0; // うち伸長が終わったもの(先端がホライズンに達した/打ち切られた)
  discarded = 0; // このフレームに乖離で破棄したもの

  constructor(
    private readonly entities: EntityManager,
    private readonly ephemeris: Ephemeris,
  ) {}

  // Game.update の entities.cleanup(...) の後に呼ぶ(死んだ個体を予測しない、積分後の実状態と
  // 突き合わせる)。視点・モードによる条件分岐は持たない — 予測は表示とは独立に常時進む。
  // horizon は simTime から先に予測する長さ [s]。
  update(simTime: number, player: Player | null, horizon: number): void {
    const all = this.entities.all();

    // 距離判定は毎フレーム無条件で全対象に行う(二分探索1回ぶんの費用しかかからない)。
    // 伸長を止めている間も実状態は進むので、乖離した列をここで落とさないと
    // 現在と無関係な軌道が描かれ続ける。
    this.tracked = 0;
    this.finished = 0;
    this.discarded = 0;
    const attractors = this.ephemeris.attractorsAt(simTime);
    for (const e of all) {
      if (e.discardPredictionIfDiverged(simTime, attractors)) this.discarded++;
      if (!e.predictsFuture) continue;
      this.tracked++;
      const reachedHorizon = e.predictedTrajectory !== null && e.predictedTrajectory.state.t > simTime + horizon;
      if (reachedHorizon || e.predictionTruncated) this.finished++;
    }

    // 予算配分: 操作対象の艦を先頭に、以降はカーソル位置から最大1周だけ回す。艦に渡す分は
    // 全体の PREDICT_PLAYER_BUDGET_RATIO までに抑え、残りは必ずラウンドロビンへ回す —
    // 艦の予測が完成するまで他の個体が止まると、その予測を重力源として読む計画軌道の形まで
    // 艦の予測進捗に左右されてしまう。
    let budget = C.PREDICT_STEP_BUDGET;
    if (player) {
      const playerBudget = Math.floor(C.PREDICT_STEP_BUDGET * C.PREDICT_PLAYER_BUDGET_RATIO);
      budget -= this.advanceBudget(player, playerBudget, simTime, horizon);
    }

    let visited = 0;
    while (budget > 0 && visited < all.length) {
      const e = all[(this.cursor + visited) % all.length]!;
      budget -= this.advanceBudget(e, budget, simTime, horizon);
      visited++;
    }
    this.cursor = all.length > 0 ? (this.cursor + visited) % all.length : 0;
  }

  // budgetSteps を上限に、1体ぶんの予測列を GameEntity.stepPredicted で1ステップずつ伸ばし、
  // 消費したステップ数を返す。刻み幅は毎ステップ、現在の予測先端の時刻・位置から求め直す
  // (先端がまだ無ければ現在状態で代用 — 生成直後は actualTrajectory.state を種にするので
  // 同じ値になる)。重力源の空間分類は先端が PREDICT_ATTRACTOR_REBUILD_SEC 進むごとに1回
  // だけ組み、その間は使い回す(Simulator.substep が1サブステップで1回だけ組むのと同じ規約)
  // — その時間ぶんの重力源位置の遅れは、予測の刻み幅そのものが持つ RK4 の誤差より小さい。
  // ここが「1ステップぶんの前提を決めて渡す」側、entity 側は「渡された前提で実際に1ステップ
  // 進めるか判断する」側 — stepActual に対する substep と同じ分担。ホライズン超過などで
  // stepPredicted が false を返したら、そのエンティティの予算消化を打ち切る。
  private advanceBudget(e: GameEntity, budgetSteps: number, simTime: number, horizon: number): number {
    if (!e.predictsFuture) return 0;
    let consumed = 0;
    let classified: ClassifiedAttractors | null = null;
    let classifiedAt = 0;
    while (consumed < budgetSteps) {
      // 刻み幅は「その場の周期の等分」と「ホライズン全体をステップ上限で割った値」の粗い方。
      // 後者があるので、表示期間を年スケールにしてもステップ数が有界に収まる。
      const tipState = e.predictedTrajectory?.state ?? e.state;
      if (classified === null || tipState.t - classifiedAt >= C.PREDICT_ATTRACTOR_REBUILD_SEC) {
        classified = classifyAttractors(predictedAttractorsAt(this.ephemeris, this.entities, tipState.t));
        classifiedAt = tipState.t;
      }
      const attractors = attractorsNear(tipState.r, classified);
      const dt = Math.max(
        C.PREDICT_MIN_STEP_DT,
        localOrbitPeriod(tipState.r, attractors) / C.PREDICT_STEPS_PER_REV,
        horizon / C.PREDICT_MAX_STEPS,
      );
      if (!e.stepPredicted(attractors, simTime, dt, horizon)) break;
      consumed++;
    }
    return consumed;
  }
}
