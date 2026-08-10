// 計画軌道の1区間(arc)。起点状態から終端時刻までを DynamicTrajectory で数値積分し、その保持
// サンプル列を1本の折れ線として描く。マニューバノードによる区間分割は知らない — 呼び出し側
// (PlanPath)が arc ごとにこれを持つ。
import type * as THREE from 'three/webgpu';
import { KinematicState, hermiteInterpolate } from '../../physics/kinematic-state';
import { DynamicTrajectory } from '../../physics/dynamic-trajectory';
import { ReferenceFrame } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';
import { Attractor, localOrbitPeriod } from '../../physics/attractor';
import { containingBody, sweptSphereToi } from '../../physics/sphere-contact';
import { apsisCrossing } from '../../physics/trajectory-features';
import { isBurnedUp } from '../../physics/atmosphere';
import { attractorsNear, classifyAttractors, gravityBodiesAt, mergeAttractors } from '../simulation/attractors';
import { addScaled, len, sub, Vec3 } from '../../physics/vec3';
import { FloatingOrigin } from '../floating-origin';
import { SampledLine } from '../../render/sampled-line';
import { ScaleFn } from '../camera/camera-system';
import * as C from '../const';

// 積分の終端は要求時刻に対して丸め誤差ぶん手前に落ちうる。この幅までは終端そのものとみなす。
const EPOCH_EPS = 1e-6;

// 天体接近時、1ステップで表面までの距離を跨いでしまわないための安全率
// (表面までの距離 ÷ 相対速度 に掛ける上限係数)。
const APPROACH_STEP_SAFETY = 0.5;

// 衝突判定の交差点探索の反復回数。固定回数にしているのは、収束判定にすると反復回数が
// フレームごとに変動し、その分だけ結果が揺れるため(trajectory-features.ts と同じ作法)。
const IMPACT_REFINE_ITERATIONS = 20;

type ComputeKey = { state0: KinematicState; end: number; };

export interface PlanImpact {
  readonly state: KinematicState;
  readonly body: Attractor;
}

// 刻み幅。その場で最も強く引く天体を中心とする軌道運動の時間スケール(低軌道では細かく、
// 遠地点では粗くなる)を PLAN_ARC_STEPS_PER_REV 等分した値と、最も近い天体の表面までの
// 距離をその天体への相対速度で割った接近時間の小さい方。後者が無ければ1ステップで
// 影響圏を跨いで天体をすり抜けかねない — 月の影響圏外(最強天体が地球)では前者だけで
// 数万秒のステップになり、その間に自機も月も数万km動くため。
function stepDt(state: KinematicState, attractors: readonly Attractor[]): number {
  const orbitDt = localOrbitPeriod(state.r, attractors) / C.PLAN_ARC_STEPS_PER_REV;
  let approachDt = Infinity;
  for (const body of attractors) {
    const clearance = len(sub(state.r, body.state.r)) - body.radius;
    if (clearance <= 0) continue;
    const closingSpeed = len(sub(state.v, body.state.v));
    if (closingSpeed <= 1e-9) continue;
    approachDt = Math.min(approachDt, (clearance / closingSpeed) * APPROACH_STEP_SAFETY);
  }
  return Math.min(orbitDt, approachDt);
}

// prev→next の間で body の表面へ実際に到達した状態。区間両端の天体位置(bodyStart/bodyEnd)
// を使った掃引球TOI(直線弦の解)を初期ブラケットとし、エルミート曲線上で「中心距離 - 半径」
// の符号が変わる点を固定回数の二分探索で詰め直す — 天体自身も区間内で動くため、直線弦の
// 比率をそのままエルミート補間へ渡すと交差点がずれる。直線弦モデルでは符号反転していても、
// エルミート曲線+線形天体位置のモデルでは区間終端まで表面外に留まることがあるため、
// 二分探索の前に区間終端での符号反転を確認し、無ければ交差なしとして null を返す。
function refineSurfaceCrossing(
  prev: KinematicState, next: KinematicState, bodyStart: Vec3, bodyEnd: Vec3, radius: number,
): KinematicState | null {
  const clearanceAt = (u: number): number => {
    const s = hermiteInterpolate(prev, next, prev.t + (next.t - prev.t) * u);
    const bodyPos = addScaled(bodyStart, sub(bodyEnd, bodyStart), u);
    return len(sub(s.r, bodyPos)) - radius;
  };
  const signLo = clearanceAt(0) >= 0;
  const signHi = clearanceAt(1) >= 0;
  if (signLo === signHi) return null;
  let lo = 0, hi = 1;
  for (let i = 0; i < IMPACT_REFINE_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    if ((clearanceAt(mid) >= 0) === signLo) lo = mid; else hi = mid;
  }
  const u = (lo + hi) / 2;
  return hermiteInterpolate(prev, next, prev.t + (next.t - prev.t) * u);
}

// prev→next の1ステップの間に表面へ到達した候補天体のうち、最も早く(掃引球TOIが小さい)
// 到達したものを選ぶ。掃引球TOIは直線弦モデルの目安に過ぎないため、TOI昇順に
// refineSurfaceCrossing で検証し、実際にエルミート曲線上でも交差が確認できた最初の候補を
// 採用する。candidates は判定対象の天体一覧、startBodies/endBodies はそれぞれ prev.t/next.t
// 時点の天体一覧(id で対応付ける — candidates 自体は1つの評価時刻のみのスナップショットで、
// 動く天体の始終点はここでしか引けない)。
function findImpact(
  prev: KinematicState, next: KinematicState, candidates: readonly Attractor[],
  startBodies: readonly Attractor[], endBodies: readonly Attractor[],
): PlanImpact | null {
  const hits: { body: Attractor; toi: number }[] = [];
  for (const body of candidates) {
    const bStart = startBodies.find((a) => a.id === body.id);
    const bEnd = endBodies.find((a) => a.id === body.id);
    if (!bStart || !bEnd) continue;
    const hit = sweptSphereToi(prev.r, next.r, bStart.state.r, bEnd.state.r, body.radius);
    if (hit) hits.push({ body, toi: hit.toi });
  }
  hits.sort((a, b) => a.toi - b.toi);
  for (const { body } of hits) {
    const bStart = startBodies.find((a) => a.id === body.id)!;
    const bEnd = endBodies.find((a) => a.id === body.id)!;
    const state = refineSurfaceCrossing(prev, next, bStart.state.r, bEnd.state.r, body.radius);
    if (state) return { body, state };
  }
  return null;
}

// pos に対して表面まで最も近い天体(clearance = 中心距離 - 半径 が最小のもの)。
function nearestByClearance(pos: Vec3, bodies: readonly Attractor[]): Attractor | null {
  let best: Attractor | null = null;
  let bestClearance = Infinity;
  for (const body of bodies) {
    const clearance = len(sub(pos, body.state.r)) - body.radius;
    if (clearance < bestClearance) { bestClearance = clearance; best = body; }
  }
  return best;
}

export class PlanArc {
  private readonly line: SampledLine;
  private trajectory: DynamicTrajectory | null = null;
  private _samples: readonly KinematicState[] = [];
  // 積分中に最初に天体表面へ達した状態とその天体。到達しなければ null。
  private impact: PlanImpact | null = null;
  // 積分中に最初に見つかった近地点・遠地点。apsisCenter が null、またはその極値へ
  // 区間が届かなければ null のまま。
  private periapsisState: KinematicState | null = null;
  private apoapsisState: KinematicState | null = null;
  // 非有限・天体衝突・ステップ数上限で積分を打ち切ったか。
  private truncated = false;
  private key: ComputeKey | null = null;
  private recomputed = false;

  // 描画色・不透明度・renderOrder を指定して線を用意する。折れ線は常に破線で描く
  // (実際のパターンは sync() が毎フレーム上書きするので、ここでの初期値に意味は無い)。
  constructor(color: number, opacity = 0.85, renderOrder = 4) {
    this.line = new SampledLine(color, opacity, renderOrder,
      { dashSize: C.PLAN_ARC_DASH_PX, gapSize: C.PLAN_ARC_GAP_PX });
  }

  // シーンに追加する描画対象。
  get object3d(): THREE.Object3D {
    return this.line.line;
  }

  // 積分中に最初に天体表面へ達した状態と、その天体。到達しなければ null。
  impactPoint(): PlanImpact | null {
    return this.impact;
  }

  // 積分中に最初に見つかった近地点。中心天体へ接近し続けたまま表面へ達する
  // (衝突軌道で近地点が存在しない)場合は null。
  periapsisPoint(): KinematicState | null {
    return this.periapsisState;
  }

  // 積分中に最初に見つかった遠地点。楕円でない、または区間がそこまで届かなければ null。
  apoapsisPoint(): KinematicState | null {
    return this.apoapsisState;
  }

  // 起点・終端の変化を検出して再積分する。tracksLiveAnchor(計画が空の間の唯一の区間)では
  // state0 が自機を毎フレーム追従して end も連動して動く。'orbit' プリセットでは区間長
  // (= 起点の接触周期)自体も J2・大気抵抗で毎フレーム連続的に変化するため、区間長・
  // state0.t のどちらも厳密一致では判定できない。そこで両者とも同じ基準
  // ——直近の再積分結果からの変化が描画解像度のサンプル間隔(区間長 / PLAN_ARC_MAX_SAMPLES)
  // 未満かどうか——で揃えて判定する: それ未満なら折れ線の見た目は変わらないので再積分を
  // スキップする。ただし起点の同一性が変わっていて、かつ時刻が前進していない場合(別艦への
  // 切り替え・ドック発進・衝突による状態上書きなど、同じ時刻での非連続な差し替え)は、
  // 差分がどれだけ小さくても即座に再積分する — そうしないと切り替え直後の1フレームが
  // 前の起点と時刻的に近いというだけで、無関係な軌道をサンプル間隔ぶん描き続けてしまう。
  // tracksLiveAnchor でなければ state0/end の同一性・値の変化で即座に再積分する
  // (ノードの Δv 編集は state0 の同一性変化で必ず拾われる)。apsisCenter は
  // periapsisPoint/apoapsisPoint を検出する基準天体 — null なら検出自体を行わない。
  update(
    state0: KinematicState, end: number, ephemeris: Ephemeris,
    dynamicAttractors: readonly Attractor[], tracksLiveAnchor: boolean,
    apsisCenter: Attractor | null,
  ): void {
    if (tracksLiveAnchor) {
      // 同一性が変わっても時刻が前進していれば通常の追従とみなし、下のサンプル間隔判定に委ねる。
      const anchorSwapped = this.key !== null && state0 !== this.key.state0 && state0.t <= this.key.state0.t;
      const duration = end - state0.t;
      const keyDuration = this.key ? this.key.end - this.key.state0.t : NaN;
      const sampleInterval = this.key ? keyDuration / C.PLAN_ARC_MAX_SAMPLES : 0;
      const durationChanged = this.key === null || Math.abs(duration - keyDuration) >= sampleInterval;
      const anchorDrifted = this.key !== null && Math.abs(state0.t - this.key.state0.t) >= sampleInterval;
      this.recomputed = anchorSwapped || durationChanged || anchorDrifted;
    } else {
      this.recomputed = this.key === null || state0 !== this.key.state0 || end !== this.key.end;
    }
    if (this.recomputed) {
      this.integrate(state0, end, ephemeris, dynamicAttractors, apsisCenter);
      this.key = { state0, end };
    }
  }

  // 直近に積分したサンプル列を折れ線メッシュへ反映する。
  sync(ephemeris: Ephemeris, frame: ReferenceFrame, currentTime: number, fo: FloatingOrigin,
    dashSize: number, gapSize: number, scale: ScaleFn, attractors: readonly Attractor[]): void {
    this.line.setDash(dashSize, gapSize);
    this.line.syncGeometry(this._samples, frame, ephemeris, scale, attractors);
    this.line.syncTransform(frame, currentTime, ephemeris, fo, attractors);
  }

  // 時刻 t の状態。保持区間外は null。
  at(t: number): KinematicState | null {
    if (this.trajectory === null) {
      for (let i = 1; i < this._samples.length; i++) {
        const a = this._samples[i - 1]!, b = this._samples[i]!;
        if (t >= a.t && t <= b.t) return hermiteInterpolate(a, b, t);
      }
      return this._samples.length && t === this._samples[this._samples.length - 1]!.t ? this._samples[this._samples.length - 1]! : null;
    }
    if (this.trajectory === null) return null;
    const tip = this.trajectory.state;
    if (t > tip.t) return t - tip.t <= EPOCH_EPS ? tip : null;
    return this.trajectory.at(t);
  }

  // 終端(= 次のノードの噴射直前)の状態。終端まで到達できなかった区間は null。
  endState(): KinematicState | null {
    return this.truncated || this.trajectory === null ? null : this.trajectory.state;
  }

  // 直近に積分したサンプル列。
  get samples(): readonly KinematicState[] {
    return this._samples;
  }

  // 線の表示/非表示を切り替える。
  setVisible(v: boolean): void {
    this.line.setVisible(v);
  }

  // 保持している描画リソースを破棄する。
  dispose(): void {
    this.line.dispose();
  }

  // state0 から end まで自機と同じ弾道係数で自由伝播し、サンプル列を作り直す。保持間隔は
  // 区間長を上限サンプル数で割った値、保持窓は区間長そのものなので、区間全体が間引かれた
  // 解像度で残る。いずれかの天体の表面へ接触するか、地球大気で焼失(REENTRY_ALT)したら、
  // その時点で打ち切る(非有限・ステップ数上限に達した場合も同様)。
  // dynamicAttractors は呼び出し元がこのフレームで一度だけ求めた値を全ステップで使い回す —
  // 区間長は最大1年に及び、そのあいだの位置を EntityManager には問えないため。
  private integrate(
    state0: KinematicState, end: number, ephemeris: Ephemeris, dynamicAttractors: readonly Attractor[],
    apsisCenter: Attractor | null,
  ): void {
    const duration = Math.max(0, end - state0.t);
    const trajectory = new DynamicTrajectory(state0);
    const sampleInterval = duration / C.PLAN_ARC_MAX_SAMPLES;
    this.truncated = false;
    this.impact = null;
    this.periapsisState = null;
    this.apoapsisState = null;

    let steps = 0;
    // ステップ開始時点(= 前ステップの終端)の重力源一覧。前ステップの終端時刻と今ステップの
    // 開始時刻は常に一致するため、次ステップの開始側としてそのまま持ち越して
    // gravityBodiesAt の呼び出しとアロケーションを1回分減らす。
    let startBodies = mergeAttractors(gravityBodiesAt(ephemeris, trajectory.state.t), dynamicAttractors);
    while (trajectory.state.t < end - EPOCH_EPS) {
      const sizingClassified = classifyAttractors(startBodies);
      const sizingAttractors = attractorsNear(trajectory.state.r, sizingClassified);

      // sweptSphereToi は開始時点で既にoverlapしている場合は離散判定へ委譲する契約なので、
      // ここでその離散判定を満たす。
      const containing = containingBody(trajectory.state.r, sizingAttractors, 0);
      if (containing) {
        this.impact = { state: trajectory.state, body: containing };
        this.truncated = true;
        break;
      }

      // 最後の1歩は end にちょうど着地させる — 終端がそのままノードの到達状態になる。
      const dt = Math.min(stepDt(trajectory.state, sizingAttractors), end - trajectory.state.t);
      if (dt <= 1e-9) {
        // ループ条件が残り時間 > EPOCH_EPS を保証するため、ここに来るのは天体接近で
        // stepDt の接近項が幾何級数的に潰れた場合のみ(clearance がステップごとに
        // 一定比率で縮み続け、符号は反転しないまま dt だけが 0 に収束する)。打ち切りが
        // truncated を立てないと、実際には衝突コースの区間が正常終端として扱われてしまう
        // ので、最寄り天体への衝突として記録する。
        const nearest = nearestByClearance(trajectory.state.r, sizingAttractors);
        if (nearest) this.impact = { state: trajectory.state, body: nearest };
        this.truncated = true;
        break;
      }
      // 積分そのものはステップ中点(t + dt/2)の重力源で評価する。
      const stepClassified = classifyAttractors(
        mergeAttractors(gravityBodiesAt(ephemeris, trajectory.state.t + dt / 2), dynamicAttractors));
      const stepAttractors = attractorsNear(trajectory.state.r, stepClassified);
      const prev = trajectory.state;
      trajectory.step(dt, stepAttractors, C.SHIP_BCINV, C.SHIP_SRP_COEFF, C.SHADOW_PENUMBRA, null, sampleInterval, duration);

      const { r, v } = trajectory.state;
      const finite = Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z)
        && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
      if (!finite) {
        this.truncated = true;
        break;
      }
      if (apsisCenter && (this.periapsisState === null || this.apoapsisState === null)) {
        const crossing = apsisCrossing(apsisCenter, prev, trajectory.state);
        if (crossing?.kind === 'periapsis' && this.periapsisState === null) this.periapsisState = crossing.state;
        if (crossing?.kind === 'apoapsis' && this.apoapsisState === null) this.apoapsisState = crossing.state;
      }
      // 区間を跨いだ天体表面接触は区間掃引で判定する — 終端1点だけを見ると、1ステップで
      // 天体を跨いだ通過を見逃す。天体位置はステップ両端それぞれの時刻で引き直す(積分に
      // 使った中点時刻の位置は接触判定には使わない)。
      const endBodies = mergeAttractors(gravityBodiesAt(ephemeris, trajectory.state.t), dynamicAttractors);
      const impact = findImpact(prev, trajectory.state, stepAttractors, startBodies, endBodies);
      if (impact) {
        this.impact = impact;
        this.truncated = true;
        break;
      }
      if (isBurnedUp(r, stepAttractors, C.REENTRY_ALT)) {
        const earth = stepAttractors.find((a) => a.id === 'earth');
        if (earth) this.impact = { state: trajectory.state, body: earth };
        this.truncated = true;
        break;
      }
      if (++steps >= C.PLAN_ARC_MAX_STEPS) {
        this.truncated = true;
        break;
      }
      startBodies = endBodies;
    }

    this.trajectory = trajectory;
    this._samples = trajectory.samplesOldestFirst();
  }
}
