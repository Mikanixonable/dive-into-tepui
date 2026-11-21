// 予測の弧をなぞる個体(followsPredictedArc)の弧と計画軌道の各区間の弧を、共有のフレーム予算内で
// 伸ばす。1フレームの配分は「追いつき分」(消費される弧の先端を消費前線の先へ出す歩 — 歩数予算の
// 内側で必ず渡し、実時間では削らない)と「伸長分」(そこから要求終端へ伸ばす歩 — 歩数予算に加えて
// 実時間の上限も掛ける)に分かれる。弧は1本ずつ別の先端時刻で伸び、先端を実シミュレーションに
// 追い越された個体は積分へ落ちる。弧どうしの剛体接触と刻みの決まり方を除けば、個体1つと解析天体の
// 関係(引く天体・表面到達・大気での焼失・刻みの上限)は実シミュレーションと同じ答えでなければならない。
import type { PredictableMotion, PredictableMotionRoster } from './dynamic-simulation-participant';
import { simulationMaxStep, SUBSTEP_MAX_DT, SUBSTEP_MAX_COUNT } from './time-step';
import type { PredictedArc } from './predicted-arc';
import type { TrajectoryDemand } from './trajectory-demand';
import type { PerfCounts } from '../perf-counts';
import type { CelestialBodies } from '../celestial/celestial-bodies';

// 消費される弧が、消費前線より過去側にも保持しておく余裕 [s]。保持窓の左端が前線に一致すると
// at(前線) を挟む補間区間が消える。
const ARC_RETAIN_MARGIN = 300;

// 1フレームに割り当てる積分ステップ数の上限。1歩 ≈ 0.025〜0.055ms(ブラウザ実測)なので、成長中の
// 予測・計画が1フレームに使うのは ~15〜33ms まで。消費されている個体を追い抜かせないだけで
// 1体あたり SUBSTEP_MAX_COUNT(=64)歩/フレームが要り、ホライズンへ伸ばすぶんはその上に乗る。
// 歩数とは別に、伸長分には実時間の上限(ARC_EXTENSION_MS)も掛かる。
export const ARC_STEP_BUDGET = 600;
// 1フレームの予算のうち、操作対象の弧+計画軌道の弧(interactive 枠)に割ける割合の上限。優先は
// するが独占はさせない — 編集直後の計画に全予算を消費させると、他の個体の予測の成長が止まる。
export const ARC_INTERACTIVE_RATIO = 0.5;
// background のラウンドロビンで1体に必ず渡すステップ数の下限。最初の保持サンプル1つ分
// (sampleInterval / 刻み幅 ≒ 10 ステップ)に届かない配分では、弧が消費されないまま捨てられ、
// 作り直しを繰り返す。
export const ARC_MIN_ITEM_STEPS = 16;
// 伸長分が1フレームに使ってよい実時間 [ms]。追いつき分には掛けない — 追いつく歩はフレームの長さに
// よらず必要で、時間で削ると弧が実シミュレーションに追い越されて捨てられる。歩数を切らずに実時間で
// 打ち切るのは、CPU の遅い端末で予算一杯の伸長がフレームを食い潰さないため。
const ARC_EXTENSION_MS = 4;
// 伸長分の時限を判定するために時計を読む間隔 [歩]。毎歩読むと時計自体の呼び出し費用が効きすぎる。
const ARC_CLOCK_POLL_STEPS = 8;

export class Predictor {
  // 次に伸ばす個体の巡回の位置と、直近フレームの計数。
  private cursor = 0;
  // update が組む、弧をなぞる対象の一覧(使い回し — update の外では参照しない)。
  private readonly targets: PredictableMotion[] = [];

  private lastSteps = 0; // 実体側で消費した積分ステップ数
  private lastPlanSteps = 0; // 計画の弧で消費した積分ステップ数
  private lastBodies = 0; // 弧が解決した天体の延べ数
  private lastRevisits = 0; // そのうち期限到来で訪問したものの数

  public constructor(
    private readonly roster: PredictableMotionRoster,
    private readonly celestialBodies: CelestialBodies,
    // 伸長分の時限を測る時計 [ms]。
    private readonly clock: () => number = () => performance.now(),
  ) {}

  // このフレームぶんの積分予算を、操作対象の弧・計画の弧・その他の個体へ配って伸ばす。ポーズ中・
  // 決着後も呼んでよい。simDt はこのフレームの時間送りで、消費される弧の追いつき先(消費前線)と
  // 刻み上限を実シミュレーションと揃えるのに使う。demand は伸ばす長さと計画の弧を持つ、
  // そのフレームの需要。
  public update(
    simTime: number, simDt: number, controlled: PredictableMotion | null, demand: TrajectoryDemand,
  ): void {
    this.lastSteps = 0;
    this.lastPlanSteps = 0;
    this.lastBodies = 0;
    this.lastRevisits = 0;
    const horizon = demand.horizon;
    const maxStep = simulationMaxStep(simDt, SUBSTEP_MAX_DT, SUBSTEP_MAX_COUNT);
    const targets = this.targets;
    targets.length = 0;
    for (const e of this.roster.allMotions()) {
      if (e.followsPredictedArc) targets.push(e);
    }
    const interactive = controlled !== null && controlled.followsPredictedArc ? controlled : null;
    // 消費前線 — 追いつき分が先端を越えさせる時刻。このフレームに消費される歩が届く先。
    const consumeEnd = simTime + simDt;
    // 伸長分を打ち切る時限。この1回の読み以降、伸長分は ARC_CLOCK_POLL_STEPS ごとに時計を読む。
    const extensionDeadline = this.clock() + ARC_EXTENSION_MS;

    // interactive 枠: 操作対象の弧 → 計画の弧(時刻順)。他に伸ばす対象がいなければ全額を渡す。
    const others = targets.some((e) => e !== interactive);
    let interactiveBudget = others
      ? Math.floor(ARC_STEP_BUDGET * ARC_INTERACTIVE_RATIO) : ARC_STEP_BUDGET;
    let budget = ARC_STEP_BUDGET;
    if (interactive) {
      const { consumed, extension } = this.advanceBudget(
        interactive, interactiveBudget, budget,
        simTime, consumeEnd, horizon, maxStep, extensionDeadline,
      );
      budget -= consumed;
      interactiveBudget -= extension;
    }
    for (const arc of demand.planArcs) {
      if (interactiveBudget <= 0 || this.clock() >= extensionDeadline) break;
      const consumed = this.grow(arc, Math.min(interactiveBudget, budget), extensionDeadline);
      this.lastPlanSteps += consumed;
      budget -= consumed;
      interactiveBudget -= consumed;
    }

    // 残額(interactive の使い残し込み)を残り訪問数で均等割りする — 1体が丸ごと使うと、後続の
    // 個体の弧が ARC_MIN_ITEM_STEPS に届かないまま捨てられ、作り直しを繰り返す。
    let visited = 0;
    while (budget > 0 && visited < targets.length) {
      const e = targets[(this.cursor + visited) % targets.length]!;
      if (e !== interactive) {
        const share = Math.max(ARC_MIN_ITEM_STEPS, Math.floor(budget / (targets.length - visited)));
        budget -= this.advanceBudget(
          e, Math.min(budget, share), budget,
          simTime, consumeEnd, horizon, maxStep, extensionDeadline,
        ).consumed;
      }
      visited++;
    }
    this.cursor = targets.length > 0 ? (this.cursor + visited) % targets.length : 0;
  }

  // 個体の弧を伸ばし、消費した総歩数とそのうち伸長分の歩数を返す。歩は2つに分かれる —
  // 先端が消費前線 consumeEnd を越えるまでの追いつき分(歩数予算 frameBudget の内側で必ず渡し、
  // 枠・時限は効かせない)と、それ以後の伸長分(枠 extensionBudget と時限 deadline の内側)。
  // 追いつき分の上限は実シミュレーションが1フレームに進む歩数と同じ SUBSTEP_MAX_COUNT。
  private advanceBudget(
    e: PredictableMotion, extensionBudget: number, frameBudget: number,
    simTime: number, consumeEnd: number, horizon: number, maxStep: number, deadline: number,
  ): { consumed: number; extension: number } {
    const arc = e.ensurePredictedArc(this.celestialBodies.celestialMotions);
    if (arc === null) return { consumed: 0, extension: 0 };
    arc.demand(simTime + horizon, simTime - ARC_RETAIN_MARGIN);
    arc.alignSimulationStep(maxStep);
    const catchup = this.growCatchup(arc, consumeEnd, Math.min(SUBSTEP_MAX_COUNT, frameBudget));
    const extension = this.grow(arc, Math.min(extensionBudget, frameBudget - catchup), deadline);
    this.lastSteps += catchup + extension;
    return { consumed: catchup + extension, extension };
  }

  // 追いつき分: 先端が消費前線 consumeEnd を越えるまで、capSteps を上限に1歩ずつ伸ばし、
  // 消費した歩数を返す。
  private growCatchup(arc: PredictedArc, consumeEnd: number, capSteps: number): number {
    let consumed = 0;
    while (consumed < capSteps && arc.trajectory.state.t <= consumeEnd && arc.step()) {
      consumed++;
      this.lastBodies += arc.lastResolvedBodies;
      this.lastRevisits += arc.lastRevisitedBodies;
    }
    return consumed;
  }

  // 伸長分: arc を budgetSteps と時限 deadline の内側で1歩ずつ伸ばし、消費した歩数を返す。
  // 時計は ARC_CLOCK_POLL_STEPS ごとに読む。step() が false を返したら(requiredEnd 到達・
  // 打ち切りのいずれか)、予算が残っていてもそこで止まる。
  private grow(arc: PredictedArc, budgetSteps: number, deadline: number): number {
    let consumed = 0;
    while (consumed < budgetSteps) {
      if (consumed % ARC_CLOCK_POLL_STEPS === 0 && this.clock() >= deadline) break;
      if (!arc.step()) break;
      consumed++;
      this.lastBodies += arc.lastResolvedBodies;
      this.lastRevisits += arc.lastRevisitedBodies;
    }
    return consumed;
  }

  // 直近フレームの予測伸長の集計値。planSteps は計画の弧ぶんの積分step数。horizon は予測の
  // 要求終端までの長さで、先端が届いた個体を数えるのに使う。
  public perfCounts(simTime: number, horizon: number, controlled: PredictableMotion | null): Pick<PerfCounts,
  'predicted' | 'predictComplete' | 'predictorSteps' | 'planSteps'
  | 'arcCelestialBodies' | 'arcRevisits' | 'arcLead'> {
    // 先端が要求終端へ届いた個体と、打ち切られた個体を「完了」と数える。
    let tracked = 0;
    let finished = 0;
    for (const e of this.roster.allMotions()) {
      if (!e.followsPredictedArc) continue;
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
