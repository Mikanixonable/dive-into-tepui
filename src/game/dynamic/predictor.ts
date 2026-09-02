// DynamicEntity.predicted と、計画軌道の各区間の弧を、共有のフレーム予算内で伸ばす。1歩ぶんの
// 積分(刻み幅・窓解決・到達判定)は game/dynamic/predicted-arc.ts の PredictedArc へ持ち、
// ここは予算の配分だけを持つ。伸長対象は「その個体の未来を読む消費者がいるか」
// (DynamicEntity.hasFutureReader)で決まる。
//
// 実シミュレーション(game/dynamic/simulator.ts の Simulator)との役割の違いは2点で、
// 二重性はこの2点に由来する。統一はできない。
//  1. 同時性。こちらは選ばれた少数の弧を1本ずつ、それぞれ別の先端時刻で伸ばす。共通の瞬間が
//     無いので、絞り込みは弧ごと(ArcCelestialBodies)にしか組めず、弧どうしの剛体接触は解けない。
//  2. 刻みの決まり方。こちらは simTime を追い越されない範囲で先へ伸びればよいので、1フレームの
//     歩数を予算で切り、足りなければ遅れる — 追い越された弧は読まれなくなり、その個体は
//     実シミュレーションの積分へ落ちるだけで壊れない。
// **この2点に起因しない部分は、両者で同じ答えでなければならない** — 個体1つと解析天体の
// 関係(どの天体が引くか・表面へ到達したか・大気で焼失したか・刻みをどこまで広げてよいか)。
import { DynamicSystem } from './dynamic-system';
import { DynamicEntity } from './dynamic-entity/dynamic-entity';
import { Player } from '../player/player';
import { simulationMaxStep, SUBSTEP_MAX_DT, SUBSTEP_MAX_COUNT } from './time-step';
import type { CelestialSystem } from '../celestial/celestial-system';
import { PredictedArc } from './predicted-arc';
import type { PerfCounts } from '../../perf-meter';

// 消費される弧が、消費前線より過去側にも保持しておく余裕 [s]。保持窓の左端が前線に一致すると
// at(前線) を挟む補間区間が消える。予測線の下端は simTime なので、余分に保持しても描画は変わらない。
const ARC_RETAIN_MARGIN = 300;

// 1フレームに配る積分ステップ数の上限。1歩 ≈ 0.025〜0.055ms(弧が保持する一覧ぶんの
// 天体解決+掃引到達判定、ブラウザ実測)なので、成長中の予測・計画が1フレームに使うのは
// ~15〜33ms まで。ここへ払った時間は積分側から返ってくる — 消費される弧の1歩は
// simDt/SUBSTEP_MAX_COUNT 秒ぶんを覆い、高ワープではその区間の実シミュレーションのサブステップ
// 数百回ぶんの積分を1歩で肩代わりする。消費されている個体を追い抜かせないだけで1体あたり
// SUBSTEP_MAX_COUNT(=64)歩/フレームが要り、ホライズンへ伸ばすぶんはその上に乗る。
export const ARC_STEP_BUDGET = 600;
// 1フレームの予算のうち、操作艦の弧+計画軌道の弧(interactive 枠)に割ける割合の上限。
// 優先はするが独占はさせない — 計画の弧は他個体の予測を重力源・衝突判定の相手として読むため、
// 編集直後の計画にこの枠を丸ごと食わせると、その依存先(background 側)の予測の成長が止まる。
export const ARC_INTERACTIVE_RATIO = 0.5;
// background のラウンドロビンで1体に必ず渡すステップ数の下限。予測列の history に最初の
// 保持サンプルが積まれるまでは at() がほぼ全時刻で null を返し、実シミュレーションが消費
// できずに積分して弧を捨てるので、その1サンプル分(sampleInterval / 刻み幅 ≒ 10 ステップ)を
// 下回る配分は作り直しを繰り返す。
export const ARC_MIN_ITEM_STEPS = 16;

export class Predictor {
  private cursor = 0;

  tracked = 0; // 予測対象の個体数
  finished = 0; // 先端がホライズンに達した/打ち切られた個体数
  lastSteps = 0; // 実体側で消費した積分ステップ数
  lastPlanSteps = 0; // 計画の弧で消費した積分ステップ数
  lastBodies = 0; // 弧が解決した天体の延べ数
  lastRevisits = 0; // そのうち期限到来で訪問したものの数
  // 操作艦の予測先端が simTime よりどれだけ先か [s]。弧が無ければ null。
  lastArcLead: number | null = null;

  constructor(
    private readonly entities: DynamicSystem,
    private readonly celestialSystem: CelestialSystem,
  ) {}

  // Game.update の本流から無条件に(ポーズ中・決着後も)呼ぶ。simDt はこのフレームの時間送り
  // (Simulator.lastSimDt)で、消費される弧の刻み上限を実シミュレーションと揃えるのに使う。
  // horizon は simTime から先に予測する長さ [s]。canDisplayFuture は表示時刻が現在より先へ
  // 動けるかで、未来ゴーストが伸長理由として成り立つかを決める。planArcs は
  // plan/plan-path.ts の PlanPath が owned で持つ弧を時刻順に渡したもの
  // (PlanTrajectory.growableArcs 経由) — requiredEnd/retainFrom は渡す前に書き込み済みなので、
  // ここでは step() を呼ぶだけでよい。
  update(
    simTime: number, simDt: number, player: Player | null, horizon: number, canDisplayFuture: boolean,
    planArcs: readonly PredictedArc[],
  ): void {
    this.tracked = 0;
    this.finished = 0;
    this.lastSteps = 0;
    this.lastPlanSteps = 0;
    this.lastBodies = 0;
    this.lastRevisits = 0;
    const maxStep = simulationMaxStep(simDt, SUBSTEP_MAX_DT, SUBSTEP_MAX_COUNT);
    for (const e of this.entities.all()) {
      if (!e.predictsFuture) continue;
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
      ? Math.floor(ARC_STEP_BUDGET * ARC_INTERACTIVE_RATIO) : ARC_STEP_BUDGET;
    let budget = ARC_STEP_BUDGET;
    if (interactiveShip) {
      const consumed = this.advanceBudget(interactiveShip, interactiveBudget, simTime, horizon, maxStep);
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
      if (e !== interactiveShip) {
        const share = Math.max(ARC_MIN_ITEM_STEPS, Math.floor(budget / (targets.length - visited)));
        budget -= this.advanceBudget(e, Math.min(budget, share), simTime, horizon, maxStep);
      }
      visited++;
    }
    this.cursor = targets.length > 0 ? (this.cursor + visited) % targets.length : 0;

    this.lastArcLead = player !== null && player.predicted !== null
      ? player.predicted.state.t - simTime : null;
  }

  // budgetSteps を上限に予測列を1歩ずつ伸ばし、消費した歩数を実体側の集計へ積んで返す。
  // 要求終端・保持窓の左端・実シミュレーションの刻み上限を弧へ書いてから grow を呼ぶだけで、
  // 刻み幅・窓解決・到達判定は弧(PredictedArc)の責務。
  private advanceBudget(
    e: DynamicEntity, budgetSteps: number, simTime: number, horizon: number, maxStep: number,
  ): number {
    const arc = e.ensurePredictedArc(this.celestialSystem);
    if (arc === null) return 0;
    arc.requiredEnd = simTime + horizon;
    arc.retainFrom = simTime - ARC_RETAIN_MARGIN;
    arc.simulationMaxStep = maxStep;
    const consumed = this.grow(arc, budgetSteps);
    this.lastSteps += consumed;
    return consumed;
  }

  // arc を budgetSteps を上限に1歩ずつ伸ばし、消費した歩数を返す。step() が false を返したら
  // (requiredEnd 到達・打ち切りのいずれか)、予算が残っていてもそこで止まる。実体・計画の弧の
  // 両方がこの1本を共有する。
  private grow(arc: PredictedArc, budgetSteps: number): number {
    let consumed = 0;
    while (consumed < budgetSteps && arc.step()) {
      consumed++;
      this.lastBodies += arc.lastResolvedBodies;
      this.lastRevisits += arc.lastRevisitedBodies;
    }
    return consumed;
  }

  // 負荷確認ウィンドウが読む、直近フレームの予測伸長の集計値。planSteps は計画の弧ぶんの
  // 積分step数 — 区間の再生成数(planArcs)は plan/plan-trajectory.ts が答える。
  perfCounts(): Pick<PerfCounts,
  'predicted' | 'predictComplete' | 'predictorSteps' | 'planSteps'
  | 'arcCelestialBodies' | 'arcRevisits' | 'arcLead'> {
    return {
      predicted: this.tracked,
      predictComplete: this.finished,
      predictorSteps: this.lastSteps,
      planSteps: this.lastPlanSteps,
      arcCelestialBodies: this.lastBodies,
      arcRevisits: this.lastRevisits,
      arcLead: this.lastArcLead,
    };
  }
}
