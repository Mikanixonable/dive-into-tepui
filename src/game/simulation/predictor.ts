// GameEntity.predicted と、計画軌道の各区間の弧を、共有のフレーム予算内で伸ばす。1歩ぶんの
// 積分(刻み幅・窓解決・到達判定)は game/simulation/predicted-arc.ts の PredictedArc へ持ち、
// ここは予算の配分だけを持つ。伸長対象は「その個体の未来を読む消費者がいるか」
// (GameEntity.hasFutureReader)で決まり、乖離判定は消費者の有無によらず毎フレーム
// 予測しうる全エンティティへ行う。
import * as C from '../const';
import { EntityManager } from './entity-manager';
import { GameEntity } from '../game-entity/game-entity';
import { Player } from '../player/player';
import { Ephemeris } from '../../physics/ephemeris';
import type { Attractor } from '../../physics/attractor';
import { attractorsNearInto, classifyAttractors } from './attractors';
import type { FutureAttractors } from './future-attractors';
import { PredictedArc } from './predicted-arc';
import type { PerfCounts } from '../../perf-meter';

export class Predictor {
  private cursor = 0;
  private readonly divergenceAttractorsScratch: Attractor[] = [];

  tracked = 0; // 予測対象の個体数
  finished = 0; // 先端がホライズンに達した/打ち切られた個体数
  discarded = 0; // 乖離判定で破棄した個体数
  lastSteps = 0; // 実体側で消費した積分ステップ数
  lastPlanSteps = 0; // 計画の弧で消費した積分ステップ数

  constructor(
    private readonly entities: EntityManager,
    private readonly ephemeris: Ephemeris,
    private readonly futureAttractors: FutureAttractors,
  ) {}

  // Game.update の本流から無条件に(ポーズ中・決着後も)呼ぶ。horizon は simTime から先に
  // 予測する長さ [s]。canDisplayFuture は表示時刻が現在より先へ動けるかで、未来ゴーストが
  // 伸長理由として成り立つかを決める。planArcs は plan/plan-path.ts の PlanPath が owned で
  // 持つ弧を時刻順に渡したもの(PlanEditor.growableArcs 経由) — requiredEnd/retainFrom は
  // 渡す前に書き込み済みなので、ここでは step() を呼ぶだけでよい。
  update(
    simTime: number, player: Player | null, horizon: number, canDisplayFuture: boolean,
    planArcs: readonly PredictedArc[],
  ): void {
    // 乖離判定は消費者の有無によらず毎フレーム行う。伸長を止めている個体を放置すると
    // 古い予測列が凍結されたまま FutureAttractors に読まれ続けるため。
    this.tracked = 0;
    this.finished = 0;
    this.discarded = 0;
    this.lastSteps = 0;
    this.lastPlanSteps = 0;
    const classified = classifyAttractors(this.ephemeris.gravityAttractorsAt(simTime));
    for (const e of this.entities.all()) {
      if (!e.predictsFuture) continue;
      const attractors = attractorsNearInto(e.state.r, classified, this.divergenceAttractorsScratch);
      if (e.discardPredictionIfDiverged(simTime, attractors)) this.discarded++;
      this.tracked++;
      const reachedHorizon = e.predicted !== null && e.predicted.state.t >= simTime + horizon;
      if (reachedHorizon || e.predictionTruncated) this.finished++;
    }

    // 伸ばすのは未来を読む消費者がいる個体だけ。線の有無は前フレームの状態を読むことになるが、
    // 弧は何フレームもかけて伸びるので、伸ばし始めが1フレーム遅れても描かれる線は変わらない。
    const targets = this.entities.all().filter((e) => e.hasFutureReader(canDisplayFuture));
    const interactiveShip = player !== null && player.hasFutureReader(canDisplayFuture) ? player : null;

    // interactive 枠: 操作艦の弧 → 計画の弧(時刻順)の順に消費する。上限は他に伸ばす対象が
    // いれば1フレーム予算の一部に絞り、いなければ全額を渡す。計画の弧は他の実体の予測を
    // 重力源・衝突体として読むので、編集直後の計画に全額を食わせると、その依存先の成長が
    // 止まってしまう。
    const others = targets.some((e) => e !== interactiveShip);
    let interactiveBudget = others
      ? Math.floor(C.ARC_STEP_BUDGET * C.ARC_INTERACTIVE_RATIO) : C.ARC_STEP_BUDGET;
    let budget = C.ARC_STEP_BUDGET;
    if (interactiveShip) {
      const consumed = this.advanceBudget(interactiveShip, interactiveBudget, simTime, horizon);
      budget -= consumed;
      interactiveBudget -= consumed;
    }
    for (const arc of planArcs) {
      if (interactiveBudget <= 0) break;
      const consumed = this.grow(arc, interactiveBudget);
      this.lastPlanSteps += consumed;
      budget -= consumed;
      interactiveBudget -= consumed;
    }

    // 1体あたりの取り分は残額(interactive の使い残し込み)を残り訪問数で均等割りする。1体が
    // 丸ごと消費すると、後続の個体が ARC_MIN_ITEM_STEPS に届かないまま次フレームの乖離判定で
    // 破棄され、作り直しを繰り返す。
    let visited = 0;
    while (budget > 0 && visited < targets.length) {
      const e = targets[(this.cursor + visited) % targets.length]!;
      if (e !== interactiveShip) {
        const share = Math.max(C.ARC_MIN_ITEM_STEPS, Math.floor(budget / (targets.length - visited)));
        budget -= this.advanceBudget(e, Math.min(budget, share), simTime, horizon);
      }
      visited++;
    }
    this.cursor = targets.length > 0 ? (this.cursor + visited) % targets.length : 0;
  }

  // budgetSteps を上限に予測列を1歩ずつ伸ばし、消費した歩数を実体側の集計へ積んで返す。
  // 要求終端・保持窓の左端を弧へ書いてから grow を呼ぶだけで、刻み幅・窓解決・到達判定は
  // 弧(PredictedArc)の責務。
  private advanceBudget(e: GameEntity, budgetSteps: number, simTime: number, horizon: number): number {
    const arc = e.ensurePredictedArc(this.futureAttractors);
    if (arc === null) return 0;
    arc.requiredEnd = simTime + horizon;
    arc.retainFrom = simTime;
    const consumed = this.grow(arc, budgetSteps);
    this.lastSteps += consumed;
    return consumed;
  }

  // arc を budgetSteps を上限に1歩ずつ伸ばし、消費した歩数を返す。step() が false を返したら
  // (requiredEnd 到達・打ち切りのいずれか)、予算が残っていてもそこで止まる。実体・計画の弧の
  // 両方がこの1本を共有する。
  private grow(arc: PredictedArc, budgetSteps: number): number {
    let consumed = 0;
    while (consumed < budgetSteps && arc.step()) consumed++;
    return consumed;
  }

  // 負荷確認ウィンドウが読む、直近フレームの予測伸長の集計値。planSteps は計画の弧ぶんの
  // 積分step数 — 区間の再生成数(planArcs)は plan/plan-editor.ts が答える。
  perfCounts(): Pick<PerfCounts, 'predicted' | 'predictComplete' | 'predictDiscarded' | 'predictorSteps' | 'planSteps'> {
    return {
      predicted: this.tracked,
      predictComplete: this.finished,
      predictDiscarded: this.discarded,
      predictorSteps: this.lastSteps,
      planSteps: this.lastPlanSteps,
    };
  }
}
