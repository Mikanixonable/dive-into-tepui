// 凍結した起点状態(state0)から要求終端(requiredEnd)へ向けて、step() を呼ぶたびに RK4 で
// 1歩だけ伸びる積分弧と、その経路の表面到達・近地点/遠地点。作り直すときは、持ち主が
// インスタンスを差し替える。
// 弧が答えるのは自由落下の経路が固体表面へ届くかまでで、大気による焼失は姿勢と熱を運ぶ実体の
// 側が決める(弧で近似すると、その近似を実体と揃え続けることになる)。
import { hermiteInterpolate, type KinematicState } from '../../physics/kinematic-state';
import { DynamicTrajectory } from '../../physics/dynamic-trajectory';
import { nearestAtmosphereBody, strongestAttractor } from '../../physics/attractor';
import { firstSurfaceContact } from '../../physics/surface-contact';
import { keplerPeriod } from '../../physics/elements';
import { ApsisTrack } from '../../physics/trajectory-features';
import { dot, len, sub } from '../../math/vec3';
import { ArcCelestialBodies, type ArcCelestialBodyWindow } from './arc-celestial-bodies';
import { atmosphericMaxStep, SUBSTEP_MAX_DT, ARC_MIN_STEP_DT } from './time-step';
import type { CelestialBody } from '../../physics/celestial-body';

// 積分済みのサンプル列が、要求区間の求める間引き間隔に対して何倍まで粗くてよいか。表示期間を
// 縮めると答える範囲だけを狭めるので、残るサンプルが数点まで減ると折れ線のクリック候補が
// 飛び飛びになる。これを超えて粗ければ弧を作り直す。
const ARC_MAX_SAMPLE_COARSENING = 8;

// 天体接近時、1ステップで表面までの残距離を跨がないための安全率。動径接近率(表面までの
// 距離の減り方)に掛かる上限係数で、相対速さそのものではなく接近している成分だけを見る
// — でないと円軌道でも常に効いて粗化項(ARC_MAX_STEPS)を不当に上書きしてしまう。
const ARC_APPROACH_SAFETY = 0.5;

// 消費される弧が、消費前線の近くで毎歩サンプルを残す歩数。この範囲では at() の補間誤差が
// 1歩ぶん(20s 刻みで 4.5mm)まで落ちる。前線がここを抜けると周期基準の間引きへ移り、
// 補間誤差は LEO で 20〜26m になる。512 は ×1 で 512×20s = 2.8 時間ぶん、最高ワープで
// 512×34.1s = 8フレームぶんの前線をこの精度で覆う。
const ARC_FINE_STEPS = 512;

export const TRAJECTORY_SAMPLES_PER_REV = 32; // 1周回あたりの保持サンプル数(補間誤差 30m 程度に収まる実測値)
export const DEFAULT_HISTORY_DURATION = 10 * 86400; // 過去列を残す種別の既定保持時間 [s]
// 1周回あたりの予測列の積分ステップ数。刻み幅をその場の周期に比例させ、低軌道でも遠方の
// 長周期軌道でも精度を揃えつつ、遅い軌道の費用を抑える。300 での形状誤差は GEO 28日 0.14km・
// モルニヤ1日 0.08km(実測)で、どのズームでもマップ 1px 未満。LEO と低月周回では
// period/300 が ARC_MIN_STEP_DT を割り、そちらが採られる。
export const ARC_STEPS_PER_REV = 300;
// 消費されない弧(計画の区間)の積分ステップ数・保持サンプル数の上限。弧の長さは表示期間(最大
// 1年)に追従するので、長い期間ではこれらが刻み幅と間引き間隔を決め、軌道の形の精度と引き換えに
// 費用を頭打ちにする。刻み幅に効くのは span > ARC_MAX_STEPS × ARC_MIN_STEP_DT(≒4.6日)のとき。
export const ARC_MAX_STEPS = 20000;
export const ARC_MAX_SAMPLES = 10000;

// keepDuration ぶんを保持する列へ積む最小間隔 [s]。軌道周期 period を TRAJECTORY_SAMPLES_PER_REV
// 等分した値と、保持窓を ARC_MAX_SAMPLES 等分した値の大きい方(period が非有限なら
// DEFAULT_HISTORY_DURATION で代用)。
export function trajectorySampleInterval(period: number, keepDuration: number): number {
  const span = isFinite(period) && period > 0 ? period : DEFAULT_HISTORY_DURATION;
  return Math.max(span / TRAJECTORY_SAMPLES_PER_REV, keepDuration / ARC_MAX_SAMPLES);
}

// 弧が打ち切られた、天体表面への到達。到達した瞬間の状態は経路を補間して求める。
export interface BodyImpact {
  readonly body: CelestialBody;
  readonly state: KinematicState;
}

// 起点状態と天体から積分し直せるキャッシュ。
export class PredictedArc {
  private readonly _trajectory: DynamicTrajectory;
  private _truncated = false;
  private _impact: BodyImpact | null = null;
  private _apsides: ApsisTrack | null = null;
  // この弧が引く天体の一覧。
  private readonly bodies: ArcCelestialBodies;
  // 前歩の中点で解決した窓の持ち越し。刻み幅と外挿・極値の中心天体の解決だけに使うので、
  // 半歩〜1フレーム古い内容で構わない(RK4 は鈍感、外挿中心は元から1歩古い)。
  private carriedSources: ArcCelestialBodyWindow | null = null;
  // 要求された間引き下限(span / ARC_MAX_SAMPLES)の最も粗い値。周期由来の間隔は含めない —
  // 含めると、作り直しても同じ値になる粗さを理由に represents が毎フレーム作り直しを命じる。
  private _decimation = 0;

  // 需要が決める、積分先端が到達すべき絶対時刻と、保持窓の左端。
  private requiredEnd: number;
  private retainFrom: number;
  // 実シミュレーションのサブステップ幅の上限 [s]。消費される弧はこれに刻みを揃える。
  private simulationMaxStep = SUBSTEP_MAX_DT;

  // state0 を起点に組む。要求終端と保持窓の左端は state0.t から始まり、demand で受けるまで
  // 伸びない。radius は表面到達の判定に使う物体の接触半径。keplerTail は先端の先を二体ケプラー
  // 外挿で継ぐか(計画の区間は継がない — 外挿の上に次のノードを置くと、積分し直した結果と
  // 繋がらない)。consumable は実シミュレーションがこの弧から状態を引くかで、引く弧は刻みと
  // 間引きを実シミュレーションに揃える。
  public constructor(
    public readonly state0: KinematicState,
    sources: readonly CelestialBody[],
    private readonly radius: number,
    private readonly bcInv: number,
    private readonly srpCoeff: number,
    private readonly keplerTail: boolean,
    private readonly consumable: boolean,
  ) {
    this._trajectory = new DynamicTrajectory(state0);
    this.requiredEnd = state0.t;
    this.retainFrom = state0.t;
    this.bodies = new ArcCelestialBodies(sources);
  }

  // 直近の1歩が解決した天体の数と、そのうち期限到来で訪問したものの数。
  public get lastResolvedBodies(): number { return this.bodies.lastResolved; }
  public get lastRevisitedBodies(): number { return this.bodies.lastRevisited; }

  public get trajectory(): DynamicTrajectory { return this._trajectory; }
  public get truncated(): boolean { return this._truncated; }
  public get impact(): BodyImpact | null { return this._impact; }
  public get apsides(): ApsisTrack | null { return this._apsides; }
  // 打ち切られておらず、先端がまだ requiredEnd に届いていないか。
  public get needsGrowth(): boolean { return !this._truncated && this._trajectory.state.t < this.requiredEnd; }
  public get decimation(): number { return this._decimation; }

  // 積分先端が到達すべき絶対時刻 requiredEnd と、保持窓の左端 retainFrom を受ける。伸ばす前に毎フレーム
  // 渡す。
  public demand(requiredEnd: number, retainFrom: number): void {
    this.requiredEnd = requiredEnd;
    this.retainFrom = retainFrom;
  }

  // 実シミュレーションのサブステップ幅の上限 maxStep [s] を受ける。消費される弧はこれに刻みを揃える。
  public alignSimulationStep(maxStep: number): void {
    this.simulationMaxStep = maxStep;
  }

  // この弧が (state0, end) の区間を作り直さずに表せるか。起点は同一参照で比べる(計画のノードは
  // 不変で、編集は別オブジェクトへの差し替えになる)。間引き下限が区間の求める下限の
  // ARC_MAX_SAMPLE_COARSENING 倍より粗ければ表せない。実際のサンプル間隔は刻み幅でも決まり、
  // 作り直しても縮まないので、比べるのは間引き下限どうしにする。
  public represents(state0: KinematicState, end: number): boolean {
    const sampleInterval = (end - this.state0.t) / ARC_MAX_SAMPLES;
    if (this._decimation > sampleInterval * ARC_MAX_SAMPLE_COARSENING) return false;
    return state0 === this.state0;
  }

  // 1歩伸ばす。伸ばせなければ(既に requiredEnd に達している/打ち切り済みなら)false。
  public step(): boolean {
    if (!this.needsGrowth) return false;
    const tip = this._trajectory.state;
    const span = Math.max(0, this.requiredEnd - this.retainFrom);
    this._decimation = Math.max(this._decimation, span / ARC_MAX_SAMPLES);

    // 中心窓は最初の1歩だけ先端時刻で解決し、以後は前歩の中点で解決した窓を持ち越す。
    const held = this.carriedSources ?? this.bodies.resolve(tip.t, tip, 0);
    const center = strongestAttractor(tip.r, held.gravity, held.pivot);

    // その場の軌道周期が刻み幅とサンプル間隔の両方の基準になる。
    const period = keplerPeriod(len(sub(tip.r, center.positionAt(held.pivot))), center.def.mu);
    const dt = this.stepDt(tip, span, period, held.collision, held.pivot);
    // 消費される弧の間引きは表示期間(span)由来の項を使わない — 使うと PREDICT パネルの
    // 選択が実体の状態を変えてしまう。消費前線の近く(ARC_FINE_STEPS 歩ぶん)は毎歩保持し、
    // それより遠くは周期基準の間引きへ落とす。
    const sampleInterval = this.consumable
      ? (tip.t - this.retainFrom <= ARC_FINE_STEPS * dt ? 0 : trajectorySampleInterval(period, 0))
      : trajectorySampleInterval(period, span);

    // RK4 の各ステップにはその中点時刻の重力源を渡す。実シミュレーションも各サブステップの
    // 中点で重力源を解決しており、弧だけ過去の天体位置を据え置かないようにする。
    const mid = this.bodies.resolve(tip.t + dt / 2, tip, dt);
    // 遮蔽体には mid.collision を渡す — 弧が幾何の相手として追っている窓であり、重力を
    // 及ぼすかとは無関係に成員が決まる。登録天体の全数を毎歩解決することはできない。
    this._trajectory.step(
      dt, mid.gravity, mid.collision, nearestAtmosphereBody(tip.r, mid.collision, mid.pivot), mid.pivot,
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

    (this._apsides ??= new ApsisTrack()).observe(center, held.pivot, tip, this._trajectory.state);
    this.checkSurfaceReach(tip, mid.collision, mid.pivot);

    this.carriedSources = mid;
    return true;
  }

  // 刻み幅。消費される弧は、実シミュレーションと同じ刻みで積むために simulationMaxStep・大気の
  // 上限・接近項の最小を採る。消費されない弧は、軌道項(周期基準)・粗化項(span を ARC_MAX_STEPS
  // 等分)・接近項(動径接近率基準)のうち最も厳しいものを下限 ARC_MIN_STEP_DT で頭打ちにする。
  // 下限は接近項の潰れ(Zeno)を断ち、衝突コースを有限歩で表面へ跨がせる。
  private stepDt(
    tip: KinematicState, span: number, period: number,
    collisionBodies: readonly CelestialBody[], pivot: number,
  ): number {
    let approachDt = Infinity;
    // 動径接近率が正(接近中)の天体だけを対象に、表面までの残距離ぶんの猶予を見る。
    for (const body of collisionBodies) {
      const bodyState = body.stateAt(pivot);
      const relR = sub(tip.r, bodyState.r);
      const dist = len(relR);
      const clearance = dist - body.def.radius;
      if (clearance <= 0) continue;
      const closingRate = -dot(relR, sub(tip.v, bodyState.v)) / dist;
      if (closingRate <= 1e-9) continue;
      approachDt = Math.min(approachDt, (clearance / closingRate) * ARC_APPROACH_SAFETY);
    }
    // 大気が要求する上限は下限 ARC_MIN_STEP_DT より優先される。下限は接近項の Zeno を断つため
    // のもので、抗力を積めない幅まで刻みを広げる権利は持たない。
    const atmosphericDt = atmosphericMaxStep(tip, this.bcInv, collisionBodies, pivot);
    if (this.consumable) {
      return Math.min(approachDt, atmosphericDt, this.simulationMaxStep);
    }
    const naturalDt = period / ARC_STEPS_PER_REV;
    const coarseFloor = span / ARC_MAX_STEPS;
    return Math.min(
      atmosphericDt,
      Math.max(ARC_MIN_STEP_DT, Math.min(span, approachDt, Math.max(naturalDt, coarseFloor))));
  }

  // 固体表面への到達の判定。触れた天体があれば、その接触時刻へ経路を補間した状態を到達点
  // として記録し、打ち切る。
  private checkSurfaceReach(
    prev: KinematicState, collision: readonly CelestialBody[], pivot: number,
  ): void {
    const next = this._trajectory.state;
    const hit = firstSurfaceContact(prev, next, this.radius, collision, pivot);
    if (hit === null) return;
    this._impact = {
      body: hit.body,
      state: hermiteInterpolate(prev, next, prev.t + (next.t - prev.t) * hit.geometry.toi),
    };
    this._truncated = true;
  }
}
