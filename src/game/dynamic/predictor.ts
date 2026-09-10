// DynamicMotion.predicted と、計画軌道の各区間の弧を、共有のフレーム予算内で伸ばす。1歩ぶんの
// 積分(刻み幅・窓解決・到達判定)は PredictedArc が持ち、ここは予算の配分を持つ。伸長対象は
// 「その個体の未来を読む消費者がいるか」(DynamicMotion.hasFutureReader)で決まる。
// 弧は1本ずつ別の先端時刻で伸び、1フレームの歩数は予算で切られる — 追い越された弧は読まれなく
// なり、その個体は実シミュレーションの積分へ落ちる。弧どうしの剛体接触と刻みの決まり方を除けば、
// 個体1つと解析天体の関係(引く天体・表面到達・大気での焼失・刻みの上限)は実シミュレーション
// と同じ答えでなければならない。
import type { PredictableMotion, PredictableMotionRoster } from './dynamic-simulation-participant';
import { simulationMaxStep, SUBSTEP_MAX_DT, SUBSTEP_MAX_COUNT } from './time-step';
import { PredictedArc } from './predicted-arc';
import type { PerfCounts } from '../perf-counts';
import type { CelestialBodies } from '../celestial/celestial-bodies';

// 消費される弧が、消費前線より過去側にも保持しておく余裕 [s]。保持窓の左端が前線に一致すると
// at(前線) を挟む補間区間が消える。予測線の下端は simTime なので、余分に保持しても描画は変わらない。
const ARC_RETAIN_MARGIN = 300;

// 1フレームに配る積分ステップ数の上限。1歩 ≈ 0.025〜0.055ms(ブラウザ実測)なので、成長中の
// 予測・計画が1フレームに使うのは ~15〜33ms まで。消費されている個体を追い抜かせないだけで
// 1体あたり SUBSTEP_MAX_COUNT(=64)歩/フレームが要り、ホライズンへ伸ばすぶんはその上に乗る。
export const ARC_STEP_BUDGET = 600;
// 1フレームの予算のうち、操作対象の弧+計画軌道の弧(interactive 枠)に割ける割合の上限。優先は
// するが独占はさせない — 計画の弧は他個体の予測を重力源・衝突判定の相手として読むので、編集
// 直後の計画に全額を食わせると、その依存先の予測の成長が止まる。
export const ARC_INTERACTIVE_RATIO = 0.5;
// background のラウンドロビンで1体に必ず渡すステップ数の下限。最初の保持サンプル1つ分
// (sampleInterval / 刻み幅 ≒ 10 ステップ)に届かない配分では、弧が消費されないまま捨てられ、
// 作り直しを繰り返す。
export const ARC_MIN_ITEM_STEPS = 16;

export class Predictor {
  private cursor = 0;

  private lastSteps = 0; // 実体側で消費した積分ステップ数
  private lastPlanSteps = 0; // 計画の弧で消費した積分ステップ数
  private lastBodies = 0; // 弧が解決した天体の延べ数
  private lastRevisits = 0; // そのうち期限到来で訪問したものの数

  constructor(
    private readonly roster: PredictableMotionRoster,
    private readonly celestialBodies: CelestialBodies,
  ) {}

  // このフレームぶんの積分予算を、操作対象の弧・計画の弧・その他の個体へ配って伸ばす。ポーズ中・
  // 決着後も呼んでよい。simDt はこのフレームの時間送りで、消費される弧の刻み上限を実シミュレー
  // ションと揃えるのに使う。horizon は simTime から先へ予測する長さ [s]、canDisplayFuture は
  // 表示時刻が現在より先へ動けるか。planArcs は時刻順に並べた計画の弧。
  update(
    simTime: number, simDt: number, controlled: PredictableMotion | null, horizon: number, canDisplayFuture: boolean,
    planArcs: readonly PredictedArc[],
  ): void {
    this.lastSteps = 0;
    this.lastPlanSteps = 0;
    this.lastBodies = 0;
    this.lastRevisits = 0;
    const maxStep = simulationMaxStep(simDt, SUBSTEP_MAX_DT, SUBSTEP_MAX_COUNT);
    // 伸ばすのは未来を読む消費者がいる個体だけ。線の有無は前フレームの状態を読むことになるが、
    // 弧は何フレームもかけて伸びるので、伸ばし始めが1フレーム遅れても描かれる線は変わらない。
    const targets = this.roster.allMotions().filter((e) => e.hasFutureReader(canDisplayFuture));
    const interactive = controlled !== null && controlled.hasFutureReader(canDisplayFuture) ? controlled : null;

    // interactive 枠: 操作対象の弧 → 計画の弧(時刻順)。他に伸ばす対象がいなければ全額を渡す。
    const others = targets.some((e) => e !== interactive);
    let interactiveBudget = others
      ? Math.floor(ARC_STEP_BUDGET * ARC_INTERACTIVE_RATIO) : ARC_STEP_BUDGET;
    let budget = ARC_STEP_BUDGET;
    if (interactive) {
      const consumed = this.advanceBudget(interactive, interactiveBudget, simTime, horizon, maxStep);
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
    // 丸ごと消費すると、後続の個体が ARC_MIN_ITEM_STEPS に届かないまま実シミュレーションに
    // 消費されず積分へ落ちて弧が捨てられ、作り直しを繰り返す。
    let visited = 0;
    while (budget > 0 && visited < targets.length) {
      const e = targets[(this.cursor + visited) % targets.length]!;
      if (e !== interactive) {
        const share = Math.max(ARC_MIN_ITEM_STEPS, Math.floor(budget / (targets.length - visited)));
        budget -= this.advanceBudget(e, Math.min(budget, share), simTime, horizon, maxStep);
      }
      visited++;
    }
    this.cursor = targets.length > 0 ? (this.cursor + visited) % targets.length : 0;
  }

  // budgetSteps を上限に予測列を1歩ずつ伸ばし、消費した歩数を実体側の集計へ積んで返す。
  // 要求終端・保持窓の左端・実シミュレーションの刻み上限は、伸ばす前に弧へ書き込む。
  private advanceBudget(
    e: PredictableMotion, budgetSteps: number, simTime: number, horizon: number, maxStep: number,
  ): number {
    const arc = e.ensurePredictedArc(this.celestialBodies.celestialMotions);
    if (arc === null) return 0;
    arc.requiredEnd = simTime + horizon;
    arc.retainFrom = simTime - ARC_RETAIN_MARGIN;
    arc.simulationMaxStep = maxStep;
    const consumed = this.grow(arc, budgetSteps);
    this.lastSteps += consumed;
    return consumed;
  }

  // arc を budgetSteps を上限に1歩ずつ伸ばし、消費した歩数を返す。step() が false を返したら
  // (requiredEnd 到達・打ち切りのいずれか)、予算が残っていてもそこで止まる。
  private grow(arc: PredictedArc, budgetSteps: number): number {
    let consumed = 0;
    while (consumed < budgetSteps && arc.step()) {
      consumed++;
      this.lastBodies += arc.lastResolvedBodies;
      this.lastRevisits += arc.lastRevisitedBodies;
    }
    return consumed;
  }

  // 直近フレームの予測伸長の集計値。planSteps は計画の弧ぶんの積分step数。horizon は予測の
  // 要求終端までの長さで、先端が届いた個体を数えるのに使う。
  perfCounts(simTime: number, horizon: number, controlled: PredictableMotion | null): Pick<PerfCounts,
  'predicted' | 'predictComplete' | 'predictorSteps' | 'planSteps'
  | 'arcCelestialBodies' | 'arcRevisits' | 'arcLead'> {
    // 先端が要求終端へ届いた個体と、打ち切られた個体を「完了」と数える。
    let tracked = 0;
    let finished = 0;
    for (const e of this.roster.allMotions()) {
      if (!e.predictsFuture) continue;
      tracked++;
      const reachedHorizon = e.predicted !== null && e.predicted.state.t >= simTime + horizon;
      if (reachedHorizon || e.predictionTruncated) finished++;
    }
    return {
      predicted: tracked,
      predictComplete: finished,
      predictorSteps: this.lastSteps,
      planSteps: this.lastPlanSteps,
      arcCelestialBodies: this.lastBodies,
      arcRevisits: this.lastRevisits,
      arcLead: controlled !== null && controlled.predicted !== null ? controlled.predicted.state.t - simTime : null,
    };
  }
}
