// マップで必要な GameEntity の予測列(predictedTrajectory)をフレームあたりの予算内で
// ラウンドロビンに伸ばす。戦闘ビューでは自機の線だけを小さい予算で維持する。
// 予測列の長短を問わず一律に扱うため、破棄が多発してもフレーム時間がスパイクしない。
import * as C from '../const';
import { EntityManager } from './entity-manager';
import { GameEntity } from '../game-entity/game-entity';
import { Player } from '../player/player';
import { Ephemeris } from '../../physics/ephemeris';
import type { Attractor } from '../../physics/attractor';
import { localOrbitPeriod } from '../../physics/attractor';
import { ClassifiedAttractors, attractorsNearInto, classifyAttractors, predictedAttractorsAt } from './attractors';

export class Predictor {
  private cursor = 0;
  private readonly nearbyAttractorsScratch: Attractor[] = [];

  // 直近の update() で数えた予測列の状況(?perf=1 の表示用)。
  tracked = 0; // 予測対象の個体数
  finished = 0; // うち伸長が終わったもの(先端がホライズンに達した/打ち切られた)
  discarded = 0; // このフレームに乖離で破棄したもの
  lastSteps = 0; // 直近フレームに予測器が実際に消費した積分step数

  constructor(
    private readonly entities: EntityManager,
    private readonly ephemeris: Ephemeris,
  ) {}

  // Game.update の entities.cleanup(...) の後に呼ぶ(死んだ個体を予測しない、積分後の実状態と
  // 突き合わせる)。map では全表示対象、combat では自機だけを候補にする。
  // 戦闘中も自機の予測線は残すが、予算を小さくして非表示エンティティのresync・RK4を避ける。
  // horizon は simTime から先に予測する長さ [s]。
  update(simTime: number, player: Player | null, horizon: number, mode: 'map' | 'combat' = 'map'): void {
    const all = mode === 'map' ? this.entities.all() : player ? [player] : [];

    // 距離判定は毎フレーム無条件で全対象に行う(二分探索1回ぶんの費用しかかからない)。
    // 伸長を止めている間も実状態は進むので、乖離した列をここで落とさないと
    // 現在と無関係な軌道が描かれ続ける。
    this.tracked = 0;
    this.finished = 0;
    this.discarded = 0;
    this.lastSteps = 0;
    const attractors = this.ephemeris.attractorsAt(simTime);
    for (const e of all) {
      if (e.discardPredictionIfDiverged(simTime, attractors)) this.discarded++;
      if (!e.predictsFuture) continue;
      this.tracked++;
      const reachedHorizon = e.predictedTrajectory !== null && e.predictedTrajectory.state.t > simTime + horizon;
      if (reachedHorizon || e.predictionTruncated) this.finished++;
    }

    // 予算配分: 操作対象の艦を先頭に、以降はカーソル位置から最大1周だけ回す。艦に渡す分は
    // そのフレームの予算の PREDICT_PLAYER_BUDGET_RATIO までに抑え、残りは必ずラウンドロビンへ
    // 回す — 艦の予測が完成するまで他の個体が止まると、その予測を重力源として読む計画軌道の
    // 形まで艦の予測進捗に左右されてしまう。
    const frameBudget = mode === 'map' ? C.PREDICT_STEP_BUDGET : C.PREDICT_COMBAT_STEP_BUDGET;
    let budget = frameBudget;
    if (player) {
      // 回す相手が自機しかいないなら上限は意味を持たない(残りを誰も使わない)ので全額渡す。
      const others = all.some((e) => e !== player);
      const playerBudget = others ? Math.floor(frameBudget * C.PREDICT_PLAYER_BUDGET_RATIO) : frameBudget;
      budget -= this.advanceBudget(player, playerBudget, simTime, horizon);
    }

    let visited = 0;
    while (budget > 0 && visited < all.length) {
      const e = all[(this.cursor + visited) % all.length]!;
      // player は上で優先処理済み。map の all にも player が含まれるので、ここで再処理すると
      // 自機だけが予算を二重に消費し、戦闘時は同じ予測線を2回伸ばすことになる。
      if (e !== player) budget -= this.advanceBudget(e, budget, simTime, horizon);
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
      const tipState = e.predictedTrajectory?.state ?? e.state;
      if (classified === null || tipState.t - classifiedAt >= C.PREDICT_ATTRACTOR_REBUILD_SEC) {
        classified = classifyAttractors(predictedAttractorsAt(this.ephemeris, this.entities, tipState.t));
        classifiedAt = tipState.t;
      }
      const attractors = attractorsNearInto(tipState.r, classified, this.nearbyAttractorsScratch);
      // 1ステップは表示期間より長くしない。先端は設計上ホライズンを1ステップぶん超えた所で
      // 止まるので、上限が無いと局所周期が跳ね上がった瞬間に先端が暦の有効域の外まで飛び、
      // 次の周回で attractorsAt がその時刻を引いて失敗する。
      const dt = Math.min(
        horizon,
        Math.max(
          C.PREDICT_MIN_STEP_DT,
          localOrbitPeriod(tipState.r, attractors) / C.PREDICT_STEPS_PER_REV,
          horizon / C.PREDICT_MAX_STEPS,
        ),
      );
      if (!e.stepPredicted(attractors, simTime, dt, horizon)) break;
      consumed++;
      this.lastSteps++;
    }
    return consumed;
  }
}
