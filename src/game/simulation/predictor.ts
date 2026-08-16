// GameEntity.predicted をフレーム予算内でラウンドロビンに伸ばす。
// mode='map' で全エンティティ、'combat' で自機のみを対象にする。
import * as C from '../const';
import { EntityManager } from './entity-manager';
import { GameEntity } from '../game-entity/game-entity';
import { Player } from '../player/player';
import { Ephemeris } from '../../physics/ephemeris';
import type { Attractor } from '../../physics/attractor';
import { strongestAttractor } from '../../physics/attractor';
import { keplerPeriod } from '../../physics/elements';
import { len, sub } from '../../physics/vec3';
import { attractorsNearInto, classifyAttractors, predictedAttractorsAt } from './attractors';
import type { PerfCounts } from '../../perf-meter';

export class Predictor {
  private cursor = 0;
  private readonly currentAttractorsScratch: Attractor[] = [];
  private readonly stepAttractorsScratch: Attractor[] = [];
  private readonly divergenceAttractorsScratch: Attractor[] = [];

  tracked = 0; // 予測対象の個体数
  finished = 0; // 先端がホライズンに達した/打ち切られた個体数
  discarded = 0; // 乖離判定で破棄した個体数
  lastSteps = 0; // 消費した積分ステップ数

  constructor(
    private readonly entities: EntityManager,
    private readonly ephemeris: Ephemeris,
  ) {}

  // entities.cleanup(...) の後に呼ぶ。horizon は simTime から先に予測する長さ [s]。
  update(simTime: number, player: Player | null, horizon: number, mode: 'map' | 'combat' = 'map'): void {
    const all = mode === 'map' ? this.entities.all() : player ? [player] : [];

    // 伸長を止めている間も実状態は進み続けるため、乖離判定は毎フレーム全対象に行う。
    this.tracked = 0;
    this.finished = 0;
    this.discarded = 0;
    this.lastSteps = 0;
    const classified = classifyAttractors(this.ephemeris.attractorsAt(simTime));
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

  // budgetSteps を上限に予測列を1ステップずつ伸ばし、消費したステップ数を返す。
  private advanceBudget(e: GameEntity, budgetSteps: number, simTime: number, horizon: number): number {
    if (!e.predictsFuture) return 0;
    // 引力を持たないエンティティは重力源一覧に載り得ないので、除外の走査ごと省く。
    const selfId = e.mu !== 0 ? e.id : undefined;
    let consumed = 0;
    while (consumed < budgetSteps) {
      const tipState = e.predicted?.state ?? e.state;
      // 先端が表示窓を覆っていたらここで抜ける。刻み幅を残り時間で切らないので先端はホライズンを
      // 少し越えて止まり、simTime が追いつくまでの数フレームは重力源の解決ごと省ける。
      if (tipState.t >= simTime + horizon) break;
      // 刻み幅を決める重力源はステップ開始時刻で評価する。予測の重力源を長時間保持すると、
      // 月のように速く動く天体の位置が固定され、近傍周回の予測が実軌道から離れてしまう。
      // 自分の引力を自分に加算しないよう、e 自身は一覧から除く。
      const currentClassified = classifyAttractors(
        predictedAttractorsAt(this.ephemeris, this.entities, tipState.t),
      );
      const currentAttractors = attractorsNearInto(
        tipState.r, currentClassified, this.currentAttractorsScratch, selfId,
      );
      // 刻み幅とケプラー外挿の中心天体は、どちらもこの1回の strongestAttractor から求める。
      // ただし外挿の中心は解析天体(Ephemeris の登録天体)に限る — 動的重力源が最強のときは、
      // 解析天体だけの一覧(同じ t なのでリングキャッシュに当たる)から選び直す。
      const rawCenter = strongestAttractor(tipState.r, currentAttractors);
      const extrapolationCenter = rawCenter.id in this.ephemeris.registry
        ? rawCenter
        : strongestAttractor(tipState.r, this.ephemeris.gravityAttractorsAt(tipState.t));
      // 1歩の上限は表示窓ぶん。その場の周期が表示窓よりずっと長い遠方の個体では、1歩が窓を
      // 何倍も飛び越えて、窓の中身が両端からの補間だけになってしまう。
      const dt = Math.min(
        horizon,
        Math.max(
          C.PREDICT_MIN_STEP_DT,
          keplerPeriod(len(sub(tipState.r, rawCenter.state.r)), rawCenter.mu) / C.PREDICT_STEPS_PER_REV,
          horizon / C.PREDICT_MAX_STEPS,
        ),
      );
      // RK4 の各ステップには、その中点時刻の重力源を渡す。実シミュレーションも各サブステップ
      // の中点で attractorsAt を解決しており、予測だけ過去の天体位置を保持しないようにする。
      const stepClassified = classifyAttractors(
        predictedAttractorsAt(this.ephemeris, this.entities, tipState.t + dt / 2),
      );
      const stepAttractors = attractorsNearInto(
        tipState.r, stepClassified, this.stepAttractorsScratch, selfId,
      );
      if (!e.stepPredicted(stepAttractors, simTime, dt, horizon, extrapolationCenter)) break;
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
