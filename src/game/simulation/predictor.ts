// GameEntity.predicted をフレーム予算内でラウンドロビンに伸ばす。1歩ぶんの積分(刻み幅・窓解決・
// 到達判定)は game/simulation/predicted-arc.ts の PredictedArc へ移り、ここは予算の配分だけを持つ。
// mode='map' で全エンティティ、'combat' で自機のみを対象にする。
import * as C from '../const';
import { EntityManager } from './entity-manager';
import { GameEntity } from '../game-entity/game-entity';
import { Player } from '../player/player';
import { Ephemeris } from '../../physics/ephemeris';
import type { Attractor } from '../../physics/attractor';
import { attractorsNearInto, classifyAttractors } from './attractors';
import type { FutureAttractors } from './future-attractors';
import type { PerfCounts } from '../../perf-meter';

export class Predictor {
  private cursor = 0;
  private readonly divergenceAttractorsScratch: Attractor[] = [];

  tracked = 0; // 予測対象の個体数
  finished = 0; // 先端がホライズンに達した/打ち切られた個体数
  discarded = 0; // 乖離判定で破棄した個体数
  lastSteps = 0; // 消費した積分ステップ数

  constructor(
    private readonly entities: EntityManager,
    private readonly ephemeris: Ephemeris,
    private readonly futureAttractors: FutureAttractors,
  ) {}

  // entities.cleanup(...) の後に呼ぶ。horizon は simTime から先に予測する長さ [s]。
  update(simTime: number, player: Player | null, horizon: number, mode: 'map' | 'combat' = 'map'): void {
    const all = mode === 'map' ? this.entities.all() : player ? [player] : [];

    // 伸長を止めている間も実状態は進み続けるため、乖離判定は毎フレーム全対象に行う。
    this.tracked = 0;
    this.finished = 0;
    this.discarded = 0;
    this.lastSteps = 0;
    const classified = classifyAttractors(this.ephemeris.gravityAttractorsAt(simTime));
    for (const e of all) {
      if (!e.predictsFuture) continue;
      const attractors = attractorsNearInto(e.state.r, classified, this.divergenceAttractorsScratch);
      if (e.discardPredictionIfDiverged(simTime, attractors)) this.discarded++;
      this.tracked++;
      const reachedHorizon = e.predicted !== null && e.predicted.state.t >= simTime + horizon;
      if (reachedHorizon || e.predictionTruncated) this.finished++;
    }

    // 操作対象の艦は先頭で処理する。艦の予測を計画軌道が重力源として読むため、艦の予測完成を
    // 他の個体より優先するが、上限は PREDICT_PLAYER_BUDGET_RATIO に抑えて残りをラウンドロビンへ回す。
    const frameBudget = mode === 'map' ? C.PREDICT_STEP_BUDGET : C.PREDICT_COMBAT_STEP_BUDGET;
    let budget = frameBudget;
    if (player) {
      const others = all.some((e) => e !== player);
      const playerBudget = others ? Math.floor(frameBudget * C.PREDICT_PLAYER_BUDGET_RATIO) : frameBudget;
      budget -= this.advanceBudget(player, playerBudget, simTime, horizon);
    }

    // 1体あたりの取り分は残額を残り訪問数で均等割りする。1体が丸ごと消費すると、後続の個体が
    // PREDICT_MIN_ENTITY_STEPS に届かないまま次フレームの乖離判定で破棄され、作り直しを繰り返す。
    let visited = 0;
    while (budget > 0 && visited < all.length) {
      const e = all[(this.cursor + visited) % all.length]!;
      if (e !== player) {
        const share = Math.max(C.PREDICT_MIN_ENTITY_STEPS, Math.floor(budget / (all.length - visited)));
        budget -= this.advanceBudget(e, Math.min(budget, share), simTime, horizon);
      }
      visited++;
    }
    this.cursor = all.length > 0 ? (this.cursor + visited) % all.length : 0;
  }

  // budgetSteps を上限に予測列を1歩ずつ伸ばし、消費した歩数を返す。要求終端・保持窓の左端を
  // 弧へ書いてから step() を呼ぶだけで、刻み幅・窓解決・到達判定は弧(PredictedArc)の責務。
  private advanceBudget(e: GameEntity, budgetSteps: number, simTime: number, horizon: number): number {
    const arc = e.ensurePredictedArc(this.futureAttractors);
    if (arc === null) return 0;
    arc.requiredEnd = simTime + horizon;
    arc.retainFrom = simTime;
    let consumed = 0;
    // step() が false を返したら(requiredEnd 到達・打ち切りのいずれか)、予算が残っていてもそこで止まる。
    while (consumed < budgetSteps && arc.step()) {
      consumed++;
      this.lastSteps++;
    }
    return consumed;
  }

  // 負荷確認ウィンドウが読む、直近フレームの予測伸長の集計値。
  perfCounts(): Pick<PerfCounts, 'predicted' | 'predictComplete' | 'predictDiscarded' | 'predictorSteps'> {
    return {
      predicted: this.tracked,
      predictComplete: this.finished,
      predictDiscarded: this.discarded,
      predictorSteps: this.lastSteps,
    };
  }
}
