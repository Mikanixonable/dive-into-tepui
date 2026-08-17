// 凍結した起点状態(state0)から要求終端(requiredEnd)へ向けて、step() を呼ぶたびに RK4 で
// 1歩だけ伸びる積分弧。刻み幅の決定・重力源/衝突体の窓解決・表面到達と焼失の判定・
// 近地点/遠地点の蓄積を1歩の中で行う。作り直し(無効化)は持ち主がインスタンスを
// 差し替えることで行う。
import { KinematicState } from '../../physics/kinematic-state';
import { DynamicTrajectory } from '../../physics/dynamic-trajectory';
import { Attractor, AttractorId, BodyImpact, reachedBody, strongestAttractor } from '../../physics/attractor';
import { keplerPeriod } from '../../physics/elements';
import { ApsisTrack } from '../../physics/trajectory-features';
import { burnUpBody } from '../../physics/atmosphere';
import { dot, len, sub } from '../../physics/vec3';
import { attractorsNearInto } from './attractors';
import type { FutureAttractorProvider, FutureSourcesAt } from './future-attractors';
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
  // 前歩の中点で解決した窓の持ち越し。刻み幅と外挿・極値の中心天体の解決だけに使うので、
  // 半歩〜1フレーム古い内容で構わない(RK4 は鈍感、外挿中心は元から1歩古い)。
  private carriedSources: FutureSourcesAt | null = null;
  private readonly stepAttractorsScratch: Attractor[] = [];
  private readonly collisionScratch: Attractor[] = [];
  // 要求された間引き下限(span / ARC_MAX_SAMPLES)の最も粗い値。周期由来の間隔は含めない —
  // 含めると、作り直しても同じ値になる粗さを理由に represents が毎フレーム作り直しを命じる。
  private _decimation = 0;

  // 所有者が毎フレーム書く。積分先端が到達すべき絶対時刻と、保持窓の左端。
  requiredEnd: number;
  retainFrom: number;
  // 生成時の sources.revision。represents が完全一致を要求する。
  readonly sourceRevision: number;

  // state0 を起点に先端を構築する。requiredEnd/retainFrom は state0.t で初期化され、
  // 所有者が書き換えるまで needsGrowth は偽のまま。keplerTail は先端の先を二体ケプラー外挿で
  // 継ぐか — 実体の予測列は継ぐ(true)、計画の区間は継がない(false: 外挿の暫定値の上に
  // 次のノードを置くと、実際に積分し直した結果と繋がらなくなるため)。
  constructor(
    readonly state0: KinematicState,
    private readonly sources: FutureAttractorProvider,
    private readonly bcInv: number,
    private readonly srpCoeff: number,
    private readonly keplerTail: boolean,
    // 重力源・衝突体から自分自身を除く id(mu≠0 の重力源 entity のときだけ渡す)。
    private readonly excludeId?: AttractorId,
  ) {
    this._trajectory = new DynamicTrajectory(state0);
    this.requiredEnd = state0.t;
    this.retainFrom = state0.t;
    this.sourceRevision = sources.revision;
  }

  get trajectory(): DynamicTrajectory { return this._trajectory; }
  get truncated(): boolean { return this._truncated; }
  get impact(): BodyImpact | null { return this._impact; }
  get apsides(): ApsisTrack | null { return this._apsides; }
  // 打ち切られておらず、先端がまだ requiredEnd に届いていないか。
  get needsGrowth(): boolean { return !this._truncated && this._trajectory.state.t < this.requiredEnd; }
  get decimation(): number { return this._decimation; }

  // この弧が (state0, end) を持つ区間をそのまま表せるか(= 作り直さずに使い回せるか)。
  // sourceRevision は完全一致を要求する。積分済みの間引き下限が、要求区間(end で決まる)の
  // 求める下限の ARC_MAX_SAMPLE_COARSENING 倍を超えて粗ければ、区間を狭めるだけでは折れ線の
  // クリック候補が飛び飛びの点になってしまうので表せないと答える。比べるのは間引き下限どうしで、
  // 実際のサンプル間隔ではない — 間隔は刻み幅(ARC_STEPS_PER_REV)でも決まり、そちらは作り直しても
  // 同じ値になるので、間隔を下限と比べると縮めようのない粗さを理由に毎フレーム作り直すことになる。
  // 起点は state0 が同一参照かどうかで判定する。
  represents(state0: KinematicState, end: number, sourceRevision: number): boolean {
    if (sourceRevision !== this.sourceRevision) return false;
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
    const held = this.carriedSources ?? this.sources.at(tip.t);
    const rawCenter = strongestAttractor(tip.r, held.gravity, this.excludeId);
    // 外挿・近地点/遠地点の中心は解析天体に限る(動的重力源は天体暦で位置を引けない)。
    const analyticCenter = strongestAttractor(tip.r, held.analyticGravity);

    // その場の軌道周期が刻み幅とサンプル間隔の両方の基準になる。
    const period = keplerPeriod(len(sub(tip.r, rawCenter.state.r)), rawCenter.mu);
    const dt = this.stepDt(tip, span, period, held.collision);
    const sampleInterval = trajectorySampleInterval(period, span);

    // RK4 の各ステップにはその中点時刻の重力源を渡す。実シミュレーションも各サブステップの
    // 中点で重力源を解決しており、弧だけ過去の天体位置を据え置かないようにする。
    const mid = this.sources.at(tip.t + dt / 2);
    const stepAttractors = attractorsNearInto(tip.r, mid.classified, this.stepAttractorsScratch, this.excludeId);
    this._trajectory.step(
      dt, stepAttractors, this.bcInv, this.srpCoeff, null, sampleInterval, span,
      this.keplerTail ? analyticCenter : null,
    );

    const { r, v } = this._trajectory.state;
    const finite = Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z)
      && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
    if (!finite) {
      this._truncated = true;
      return true;
    }

    (this._apsides ??= new ApsisTrack(analyticCenter)).observe(tip, this._trajectory.state);
    this.checkImpact(tip, mid.collision);

    this.carriedSources = mid;
    return true;
  }

  // 刻み幅。軌道項(周期基準)・粗化項(span を ARC_MAX_STEPS 等分)・接近項(動径接近率基準)の
  // うち最も厳しいものを、下限 ARC_MIN_STEP_DT で頭打ちにする。接近項が相対速さでなく動径
  // 接近率であることが要 — 円軌道では相対速さが軌道速度そのものになり、接近していなくても
  // 常に効いて粗化項を不当に上書きしてしまう。下限自体は接近項の幾何級数的な潰れ(Zeno)を
  // 断つためのもので、これがあるおかげで衝突コースは必ず有限歩で表面を跨ぎ、掃引判定
  // (reachedBody)が交差点を補間で求められる。
  private stepDt(
    tip: KinematicState, span: number, period: number, collisionBodies: readonly Attractor[],
  ): number {
    const naturalDt = period / C.ARC_STEPS_PER_REV;
    const coarseFloor = span / C.ARC_MAX_STEPS;
    let approachDt = Infinity;
    // 動径接近率が正(接近中)の天体だけを対象に、表面までの残距離ぶんの猶予を見る。
    for (const body of collisionBodies) {
      if (body.id === this.excludeId) continue;
      const relR = sub(tip.r, body.state.r);
      const dist = len(relR);
      const clearance = dist - body.radius;
      if (clearance <= 0) continue;
      const closingRate = -dot(relR, sub(tip.v, body.state.v)) / dist;
      if (closingRate <= 1e-9) continue;
      approachDt = Math.min(approachDt, (clearance / closingRate) * C.ARC_APPROACH_SAFETY);
    }
    return Math.max(C.ARC_MIN_STEP_DT, Math.min(span, approachDt, Math.max(naturalDt, coarseFloor)));
  }

  // 表面到達・焼失の判定。掃引が交差点を見つければそれを、そうでなく大気で焼失していれば
  // その状態を到達点として記録し、どちらかが立てば打ち切る。候補は自分自身を除いた衝突体
  // 全体 — 自分が predictedAsPlanCollider な重力源(小惑星)のとき、自分の外挿位置への
  // 自己衝突を防ぐ。
  private checkImpact(prev: KinematicState, collision: readonly Attractor[]): void {
    const candidates = this.excludeId === undefined ? collision : this.withoutSelf(collision);
    const reached = reachedBody(prev, this._trajectory.state, candidates, 0);
    const burnedUpAt = reached === null ? burnUpBody(this._trajectory.state.r, candidates, C.REENTRY_ALT) : null;
    if (reached !== null) this._impact = reached;
    else if (burnedUpAt !== null) this._impact = { body: burnedUpAt, state: this._trajectory.state };
    if (reached !== null || burnedUpAt !== null) this._truncated = true;
  }

  // collision から自分自身(excludeId)を除いた配列を collisionScratch へ書き戻す。
  private withoutSelf(collision: readonly Attractor[]): readonly Attractor[] {
    this.collisionScratch.length = 0;
    for (const body of collision) {
      if (body.id !== this.excludeId) this.collisionScratch.push(body);
    }
    return this.collisionScratch;
  }
}
