// 全 GameEntity の予測列(predictedTrajectory)をフレームあたりの予算内でラウンドロビンに伸ばす。
// 予測列の長短を問わず一律に扱うため、破棄が多発してもフレーム時間がスパイクしない。
import * as C from '../const';
import { EntityManager } from './entity-manager';
import { GameEntity } from '../game-entity/game-entity';
import { Player } from '../player/player';
import { Ephemeris } from '../../physics/ephemeris';
import { localOrbitPeriod } from '../../physics/attractor';
import { attractorsNear, classifyAttractors, predictedAttractorsAt } from './attractors';

export class Predictor {
  private cursor = 0;

  // 直近の update() で数えた予測列の状況(?perf=1 の表示用)。
  tracked = 0; // 予測対象の個体数
  complete = 0; // うち先端がホライズンに達しているもの
  discarded = 0; // このフレームに乖離で破棄したもの
  lastSteps = 0; // 直近フレームに予測器が実際に消費した積分step数

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
    this.complete = 0;
    this.discarded = 0;
    this.lastSteps = 0;
    const attractors = this.ephemeris.attractorsAt(simTime);
    for (const e of all) {
      if (e.resyncPrediction(simTime, attractors, horizon)) this.discarded++;
      if (!e.predictsFuture) continue;
      this.tracked++;
      if (e.predictedTrajectory !== null && e.predictedTrajectory.state.t > simTime + horizon) this.complete++;
    }

    // 予算配分: 操作対象の艦を先頭に、以降はカーソル位置から最大1周だけ回す。
    let budget = C.PREDICT_STEP_BUDGET;
    if (player) budget -= this.advanceBudget(player, budget, simTime, horizon);

    let visited = 0;
    while (budget > 0 && visited < all.length) {
      const e = all[(this.cursor + visited) % all.length]!;
      budget -= this.advanceBudget(e, budget, simTime, horizon);
      visited++;
    }
    this.cursor = all.length > 0 ? (this.cursor + visited) % all.length : 0;
  }

  // budgetSteps を上限に、1体ぶんの予測列を GameEntity.stepPredicted で1ステップずつ伸ばし、
  // 消費したステップ数を返す。刻み幅と重力源は毎ステップ、現在の予測先端の時刻・位置から
  // 求め直す(先端がまだ無ければ現在状態で代用 — 生成直後は actualTrajectory.state を種に
  // するので同じ値になる)。ここが「1ステップぶんの前提を決めて渡す」側、entity 側は
  // 「渡された前提で実際に1ステップ進めるか判断する」側 — stepActual に対する substep と
  // 同じ分担。ホライズン超過などで stepPredicted が false を返したら、そのエンティティの
  // 予算消化を打ち切る。
  private advanceBudget(e: GameEntity, budgetSteps: number, simTime: number, horizon: number): number {
    if (!e.predictsFuture) return 0;
    let consumed = 0;
    while (consumed < budgetSteps) {
      // 刻み幅は「その場の周期の等分」と「ホライズン全体をステップ上限で割った値」の粗い方。
      // 後者があるので、表示期間を年スケールにしてもステップ数が有界に収まる。
      const tipState = e.predictedTrajectory?.state ?? e.state;
      const classified = classifyAttractors(predictedAttractorsAt(this.ephemeris, this.entities, tipState.t));
      const attractors = attractorsNear(tipState.r, classified);
      const dt = Math.max(
        C.PREDICT_MIN_STEP_DT,
        localOrbitPeriod(tipState.r, attractors) / C.PREDICT_STEPS_PER_REV,
        horizon / C.PREDICT_MAX_STEPS,
      );
      if (!e.stepPredicted(attractors, simTime, dt, horizon)) break;
      consumed++;
      this.lastSteps++;
    }
    return consumed;
  }
}
