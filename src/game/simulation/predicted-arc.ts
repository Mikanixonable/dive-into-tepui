// 凍結した起点状態(state0)から要求終端(requiredEnd)へ向けて、step() を呼ぶたびに RK4 で
// 1歩だけ伸びる積分弧。刻み幅の決定・重力源/衝突体の窓解決・表面到達の判定・
// 近地点/遠地点の蓄積を1歩の中で行う。作り直し(無効化)は持ち主がインスタンスを
// 差し替えることで行う。
//
// **弧は大気による焼失を判定しない。** 姿勢も熱の蓄積状態も運ばないので、実体がどこで
// 失われるかを原理的に当てられない。当てられない量を近似で埋めると、その近似の値を実体側と
// 揃え続ける保守が発生する。弧が答えるのは「この自由落下の経路が固体表面へ到達するか」だけ。
import { KinematicState } from '../../physics/kinematic-state';
import { DynamicTrajectory } from '../../physics/dynamic-trajectory';
import { Attractor, BodyImpact, nearestAtmosphereBody, reachedBody, strongestAttractor } from '../../physics/attractor';
import { keplerPeriod } from '../../physics/elements';
import { ApsisTrack } from '../../physics/trajectory-features';
import { dot, len, sub } from '../../physics/vec3';
import { ArcBodies, type ArcBodyWindow, type FutureAttractorProvider } from './arc-bodies';
import { reentryAwareMaxStep } from './time-step';
import * as C from '../const';

// keepDuration ぶんを保持する列へ積む最小間隔 [s]。軌道周期 period を TRAJECTORY_SAMPLES_PER_REV
// 等分した値と、保持窓を ARC_MAX_SAMPLES 等分した値の大きい方(period が非有限なら
// SHIP_HISTORY_DURATION で代用)。
export function trajectorySampleInterval(period: number, keepDuration: number): number {
  const span = isFinite(period) && period > 0 ? period : C.SHIP_HISTORY_DURATION;
  return Math.max(span / C.TRAJECTORY_SAMPLES_PER_REV, keepDuration / C.ARC_MAX_SAMPLES);
}

export class PredictedArc {
  private readonly _trajectory: DynamicTrajectory;
  private _truncated = false;
  private _impact: BodyImpact | null = null;
  private _apsides: ApsisTrack | null = null;
  // この弧が引く天体の一覧。
  private readonly bodies: ArcBodies;
  // 前歩の中点で解決した窓の持ち越し。刻み幅と外挿・極値の中心天体の解決だけに使うので、
  // 半歩〜1フレーム古い内容で構わない(RK4 は鈍感、外挿中心は元から1歩古い)。
  private carriedSources: ArcBodyWindow | null = null;
  // 要求された間引き下限(span / ARC_MAX_SAMPLES)の最も粗い値。周期由来の間隔は含めない —
  // 含めると、作り直しても同じ値になる粗さを理由に represents が毎フレーム作り直しを命じる。
  private _decimation = 0;

  // 所有者が毎フレーム書く。積分先端が到達すべき絶対時刻と、保持窓の左端。
  requiredEnd: number;
  retainFrom: number;
  // 実シミュレーションのサブステップ幅の上限 [s]。消費される弧はこれに刻みを揃える。
  simulationMaxStep = C.SUBSTEP_MAX_DT;

  // state0 を起点に先端を構築する。requiredEnd/retainFrom は state0.t で初期化され、
  // 所有者が書き換えるまで needsGrowth は偽のまま。keplerTail は先端の先を二体ケプラー外挿で
  // 継ぐか — 実体の予測列は継ぐ(true)、計画の区間は継がない(false: 外挿の暫定値の上に
  // 次のノードを置くと、実際に積分し直した結果と繋がらなくなるため)。consumable は
  // 実シミュレーションがこの弧から状態を引くか — 引く弧は刻みと間引きを実シミュレーション側に
  // 合わせ、表示期間由来の項を使わない。
  constructor(
    readonly state0: KinematicState,
    sources: FutureAttractorProvider,
    private readonly bcInv: number,
    private readonly srpCoeff: number,
    private readonly keplerTail: boolean,
    private readonly consumable: boolean,
  ) {
    this._trajectory = new DynamicTrajectory(state0);
    this.requiredEnd = state0.t;
    this.retainFrom = state0.t;
    this.bodies = new ArcBodies(sources);
  }

  // 直近の1歩が解決した天体の数と、そのうち期限到来で訪問したものの数。
  get lastResolvedBodies(): number { return this.bodies.lastResolved; }
  get lastRevisitedBodies(): number { return this.bodies.lastRevisited; }

  get trajectory(): DynamicTrajectory { return this._trajectory; }
  get truncated(): boolean { return this._truncated; }
  get impact(): BodyImpact | null { return this._impact; }
  get apsides(): ApsisTrack | null { return this._apsides; }
  // 打ち切られておらず、先端がまだ requiredEnd に届いていないか。
  get needsGrowth(): boolean { return !this._truncated && this._trajectory.state.t < this.requiredEnd; }
  get decimation(): number { return this._decimation; }

  // この弧が (state0, end) を持つ区間をそのまま表せるか(= 作り直さずに使い回せるか)。起点は
  // 同一参照で判定する — 計画のノードは不変オブジェクトで、編集は必ず別オブジェクトへの
  // 差し替えになるので、参照が同じなら積分の入力も同じ。
  // 積分済みの間引き下限が、要求区間(end で決まる)の求める下限の ARC_MAX_SAMPLE_COARSENING
  // 倍を超えて粗ければ、区間を狭めるだけでは折れ線のクリック候補が飛び飛びの点になってしまう
  // ので表せないと答える。比べるのは間引き下限どうしで、実際のサンプル間隔ではない — 間隔は
  // 刻み幅(ARC_STEPS_PER_REV)でも決まり、そちらは作り直しても同じ値になるので、間隔を下限と
  // 比べると縮めようのない粗さを理由に毎フレーム作り直すことになる。
  represents(state0: KinematicState, end: number): boolean {
    const sampleInterval = (end - this.state0.t) / C.ARC_MAX_SAMPLES;
    if (this._decimation > sampleInterval * C.ARC_MAX_SAMPLE_COARSENING) return false;
    return state0 === this.state0;
  }

  // 1歩伸ばす。伸ばせなければ(既に requiredEnd に達している/打ち切り済みなら)false。
  step(): boolean {
    if (!this.needsGrowth) return false;
    const tip = this._trajectory.state;
    const span = Math.max(0, this.requiredEnd - this.retainFrom);
    this._decimation = Math.max(this._decimation, span / C.ARC_MAX_SAMPLES);

    // 中心窓は最初の1歩だけ先端時刻で解決し、以後は前歩の中点で解決した窓を持ち越す。
    const held = this.carriedSources ?? this.bodies.resolve(tip.t, tip, 0);
    const center = strongestAttractor(tip.r, held.gravity);

    // その場の軌道周期が刻み幅とサンプル間隔の両方の基準になる。
    const period = keplerPeriod(len(sub(tip.r, center.state.r)), center.mu);
    const dt = this.stepDt(tip, span, period, held.collision);
    // 消費される弧の間引きは表示期間(span)由来の項を使わない — 使うと PREDICT パネルの
    // 選択が実体の状態を変えてしまう。消費前線の近く(ARC_FINE_STEPS 歩ぶん)は毎歩保持し、
    // それより遠くは周期基準の間引きへ落とす。
    const sampleInterval = this.consumable
      ? (tip.t - this.retainFrom <= C.ARC_FINE_STEPS * dt ? 0 : trajectorySampleInterval(period, 0))
      : trajectorySampleInterval(period, span);

    // RK4 の各ステップにはその中点時刻の重力源を渡す。実シミュレーションも各サブステップの
    // 中点で重力源を解決しており、弧だけ過去の天体位置を据え置かないようにする。
    const mid = this.bodies.resolve(tip.t + dt / 2, tip, dt);
    // 遮蔽体には mid.collision を渡す — 弧が幾何の相手として追っている窓であり、重力を
    // 及ぼすかとは無関係に成員が決まる。登録天体の全数を毎歩解決することはできない。
    this._trajectory.step(
      dt, mid.gravity, mid.collision, nearestAtmosphereBody(tip.r, mid.collision),
      this.bcInv, this.srpCoeff, null,
      sampleInterval, span, this.keplerTail ? center : null,
    );

    const { r, v } = this._trajectory.state;
    const finite = Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z)
      && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
    if (!finite) {
      this._truncated = true;
      return true;
    }

    (this._apsides ??= new ApsisTrack(center)).observe(tip, this._trajectory.state);
    this.checkSurfaceReach(tip, mid.collision);

    this.carriedSources = mid;
    return true;
  }

  // 刻み幅。消費される弧は実シミュレーションの刻み規則をそのまま採る — ある時間帯の状態を
  // 決める積分が同じ刻みで積まれるのが目的なので、所有者が毎フレーム書く simulationMaxStep を
  // 実シミュレーションと同じ再突入域の細分化(reentryAwareMaxStep)へ通した値と、接近項の
  // 小さい方を使う。周期・粗化項・下限は使わない。細分化が要るのは、大気の密度が 1 スケール
  // ハイト(約 7km)で桁が変わるためで、降下中に刻みを縮めないと抵抗の積分がその変化を跨ぐ。
  // 消費されない弧は、軌道項(周期基準)・粗化項(span を ARC_MAX_STEPS 等分)・接近項(動径
  // 接近率基準)のうち最も厳しいものを、下限 ARC_MIN_STEP_DT で頭打ちにする。接近項が相対速さで
  // なく動径接近率であることが要 — 円軌道では相対速さが軌道速度そのものになり、接近して
  // いなくても常に効いて粗化項を不当に上書きしてしまう。下限自体は接近項の幾何級数的な
  // 潰れ(Zeno)を断つためのもので、これがあるおかげで衝突コースは必ず有限歩で表面を跨ぎ、
  // 掃引判定(reachedBody)が交差点を補間で求められる。
  private stepDt(
    tip: KinematicState, span: number, period: number, collisionBodies: readonly Attractor[],
  ): number {
    let approachDt = Infinity;
    // 動径接近率が正(接近中)の天体だけを対象に、表面までの残距離ぶんの猶予を見る。
    for (const body of collisionBodies) {
      const relR = sub(tip.r, body.state.r);
      const dist = len(relR);
      const clearance = dist - body.radius;
      if (clearance <= 0) continue;
      const closingRate = -dot(relR, sub(tip.v, body.state.v)) / dist;
      if (closingRate <= 1e-9) continue;
      approachDt = Math.min(approachDt, (clearance / closingRate) * C.ARC_APPROACH_SAFETY);
    }
    if (this.consumable) {
      const maxStep = reentryAwareMaxStep([tip], collisionBodies, this.simulationMaxStep);
      return Math.min(approachDt, maxStep);
    }
    const naturalDt = period / C.ARC_STEPS_PER_REV;
    const coarseFloor = span / C.ARC_MAX_STEPS;
    return Math.max(C.ARC_MIN_STEP_DT, Math.min(span, approachDt, Math.max(naturalDt, coarseFloor)));
  }

  // 固体表面への到達の判定。掃引が交差点を見つければその状態を到達点として記録し、打ち切る。
  private checkSurfaceReach(prev: KinematicState, collision: readonly Attractor[]): void {
    const reached = reachedBody(prev, this._trajectory.state, collision);
    if (reached === null) return;
    this._impact = reached;
    this._truncated = true;
  }
}
