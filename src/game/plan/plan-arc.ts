// 計画軌道の1区間(arc)の積分結果。起点状態から終端時刻までを DynamicTrajectory で数値積分し、
// その保持サンプル列を答える。マニューバノードによる区間分割も描画も知らない — 呼び出し側
// (PlanPath)が区間ごとにこれを持ち、生成・終端の伸縮・破棄を判断する。
import { KinematicState, hermiteInterpolate, kinematicState } from '../../physics/kinematic-state';
import { DynamicTrajectory } from '../../physics/dynamic-trajectory';
import { Attractor, BodyImpact, localOrbitPeriod } from '../../physics/attractor';
import { containingBody, sweptHermiteSphereToi } from '../../physics/sphere-contact';
import { ApsisTrack } from '../../physics/trajectory-features';
import { burnUpBody } from '../../physics/atmosphere';
import { attractorsNearInto } from '../simulation/attractors';
import type { PlanAttractorProvider } from './plan-attractors';
import { addScaled, len, scale, sub, Vec3 } from '../../physics/vec3';
import { EPOCH_EPS, clipSamplesTo, stateAt, withinEnd } from './arc-range';
import * as C from '../const';

// 天体接近時、1ステップで表面までの距離を跨いでしまわないための安全率
// (表面までの距離 ÷ 相対速度 に掛ける上限係数)。
const APPROACH_STEP_SAFETY = 0.5;

// 起点が別の軌道へ飛んだと認めるための余裕係数と、時間差ゼロでも認める位置差の下限[m]。
// 同じ軌道が dt だけ進んだだけなら位置差は高々「速度 × dt」に収まるので、その
// ANCHOR_JUMP_SPEED_MARGIN 倍を超える差は連続な伝播では説明が付かない。
const ANCHOR_JUMP_SPEED_MARGIN = 2;
const ANCHOR_JUMP_MIN_DIST = 1;

// 起点の差し替えが連続な伝播で説明できない(= 別の軌道へ飛んだ)か。時刻の前後関係は
// 代理指標として成立しない — 別艦への切り替えやドック発進では新しい起点が普通に前回より
// 後の時刻を持つので、状態そのものの差を見る。
function anchorJumped(prev: KinematicState, next: KinematicState): boolean {
  const dt = Math.abs(next.t - prev.t);
  const speed = Math.max(len(prev.v), len(next.v));
  const reachable = speed * dt * ANCHOR_JUMP_SPEED_MARGIN + ANCHOR_JUMP_MIN_DIST;
  return len(sub(next.r, prev.r)) > reachable;
}

type ImpactCandidate = { body: Attractor; toi: number };

// 刻み幅。その場で最も強く引く天体を中心とする軌道運動の時間スケール(低軌道では細かく、
// 遠地点では粗くなる)を PLAN_ARC_STEPS_PER_REV 等分した値と、最も近い天体の表面までの
// 距離をその天体への相対速度で割った接近時間の小さい方。後者が無ければ1ステップで
// 影響圏を跨いで天体をすり抜けかねない — 月の影響圏外(最強天体が地球)では前者だけで
// 数万秒のステップになり、その間に自機も月も数万km動くため。
function stepDt(
  state: KinematicState,
  gravityAttractors: readonly Attractor[],
  collisionBodies: readonly Attractor[],
): number {
  const orbitDt = localOrbitPeriod(state.r, gravityAttractors) / C.PLAN_ARC_STEPS_PER_REV;
  let approachDt = Infinity;
  for (const body of collisionBodies) {
    const clearance = len(sub(state.r, body.state.r)) - body.radius;
    if (clearance <= 0) continue;
    const closingSpeed = len(sub(state.v, body.state.v));
    if (closingSpeed <= 1e-9) continue;
    approachDt = Math.min(approachDt, (clearance / closingSpeed) * APPROACH_STEP_SAFETY);
  }
  return Math.min(orbitDt, approachDt);
}

// prev→next の1ステップの間に表面へ到達した collision body のうち、最も早いものを選ぶ。
// candidates は start/end の和集合なので、空間グリッドの現在点近傍に候補を限定しない。
// body の中心は provider が返した始終点を線形補間し、自機側は Hermite 曲線として判定する。
function findImpact(
  prev: KinematicState, next: KinematicState, candidates: readonly Attractor[],
  startBodies: ReadonlyMap<string, Attractor>, endBodies: ReadonlyMap<string, Attractor>,
  hits: ImpactCandidate[],
): BodyImpact | null {
  let hitCount = 0;
  for (const body of candidates) {
    const bStart = startBodies.get(body.id);
    const bEnd = endBodies.get(body.id);
    if (!bStart || !bEnd) continue;
    const toi = sweptHermiteSphereToi(prev, next, bStart.state.r, bEnd.state.r,
      Math.max(bStart.radius, bEnd.radius));
    if (toi !== null) {
      // hits は直前呼び出しのレコードを保持し、現在の件数ぶんだけ上書きする。
      // sort 後もこの配列の外へレコードを返さないので、次のステップで再利用できる。
      const hit = hits[hitCount] ?? { body: bStart, toi };
      hit.body = bStart;
      hit.toi = toi;
      hits[hitCount] = hit;
      hitCount++;
    }
  }
  hits.length = hitCount;
  hits.sort((a, b) => a.toi - b.toi);
  for (const { body, toi } of hits) {
    const state = hermiteInterpolate(prev, next, prev.t + (next.t - prev.t) * toi);
    const endBody = endBodies.get(body.id)!;
    const bodyDt = endBody.state.t - body.state.t;
    const bodyVelocity = bodyDt > 0
      ? scale(sub(endBody.state.r, body.state.r), 1 / bodyDt)
      : body.state.v;
    const bodyAtImpact = {
      ...body,
      radius: Math.max(body.radius, endBody.radius),
      state: kinematicState(
        state.t,
        addScaled(body.state.r, sub(endBody.state.r, body.state.r), toi),
        bodyVelocity,
      ),
    };
    return { body: bodyAtImpact, state };
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
  private readonly sourceRevision: number;
  private readonly apsisCenterId: string | null;
  // 直近の integrateTo で回した積分step数(生成時、または setRange による継ぎ足し時。
  // 継ぎ足さなかった呼び出しでは 0)。
  lastSteps = 0;

  private readonly provider: PlanAttractorProvider;
  private readonly _trajectory: DynamicTrajectory;
  // この区間が答える範囲 [_state0.t, _end]。両端とも setRange が動かす。
  private _state0: KinematicState;
  private _end: number;
  // 積分へ要求した間引き下限のうち最も粗い値。実際に記録されたサンプルの下限を決して下回らない
  // 側へ倒す — 下回ると、粗すぎる区間をそのまま使い回せると誤って答えることになる。
  private decimation = 0;
  // 非有限・天体衝突・刻み幅の潰れで積分を打ち切ったか。一度立てば以後 integrateTo は
  // 何もしない。
  private truncated = false;
  // 積分中に最初に天体表面へ達した状態とその天体。到達しなければ null。
  private impact: BodyImpact | null = null;
  private readonly apsisTrack: ApsisTrack | null;
  private samplesCache: {
    readonly source: readonly KinematicState[]; readonly end: number; readonly result: readonly KinematicState[];
  } | null = null;

  // integrateTo() は同期的に完了し、これらの配列・Mapを外へ返さない。したがって呼び出しの
  // たびに同じ一時領域を再利用できる。Mapの挿入順と候補配列の順序は従来の spread と同じ。
  private readonly collisionCandidatesById = new Map<string, Attractor>();
  private readonly collisionCandidates: Attractor[] = [];
  private readonly impactCandidates: ImpactCandidate[] = [];
  private readonly stepAttractorsScratch: Attractor[] = [];

  // state0 から end まで自機と同じ弾道係数で自由伝播し、区間を作る。provider は積分中の
  // 時刻ごとに重力源と衝突体を答える。apsisCenter は periapsisPoint/apoapsisPoint を検出する
  // 基準天体 — null なら検出自体を行わない。
  constructor(
    state0: KinematicState, end: number, provider: PlanAttractorProvider, apsisCenter: Attractor | null,
  ) {
    this._state0 = state0;
    this.sourceRevision = provider.revision;
    this.apsisCenterId = apsisCenter?.id ?? null;
    this.provider = provider;
    this.apsisTrack = apsisCenter ? new ApsisTrack(apsisCenter) : null;
    this._trajectory = new DynamicTrajectory(state0);
    this._end = end;
    this.integrateTo(end);
  }

  // この arc が引数の区間をそのまま表せるか(= 作り直さずに済むか)。sourceRevision/apsisCenterId
  // は完全一致を要求する。積分済みの間引き下限が、要求区間(end で決まる)の求める下限の
  // PLAN_ARC_MAX_SAMPLE_COARSENING 倍を超えて粗ければ、区間を狭めるだけでは折れ線のクリック
  // 候補が飛び飛びの点になってしまうので表せないと答える。比べるのは間引き下限どうしで、実際の
  // サンプル間隔ではない — 間隔は刻み幅(PLAN_ARC_STEPS_PER_REV)でも決まり、そちらは作り直しても
  // 同じ値になるので、間隔を下限と比べると縮めようのない粗さを理由に毎フレーム作り直すことになる。
  // state0 が同一参照なら、その粗さの判定を満たす限り常に表せる。
  // tracksLiveAnchor(計画が空の間の唯一の区間)では state0 が自機を毎フレーム追従するため
  // 厳密一致では判定できない — 新しい起点がこの arc の積分結果そのものの上に、折れ線1区間ぶんの
  // 長さ(速度 × サンプル間隔)より近く載っているなら、描く線は変わらないので表せると答える。
  // 自機が噴射すれば自由伝播したこの積分から離れていくので、この判定はそのとき自然に落ちる。
  // 起点の時刻が答える範囲を越えていれば at が null を返し、そこでも落ちる — 1フレームの
  // 時間送りが区間長を上回るワープでは、窓が丸ごと入れ替わるのでそれが正しい。
  // ただしこの判定は「同じ軌道が進んだだけ」という前提の上でだけ正しいので、起点が別の軌道へ
  // 飛んだ場合(別艦への切り替え・ドック発進・衝突による状態上書き)は anchorJumped で先に弾く。
  represents(
    state0: KinematicState, end: number, sourceRevision: number, apsisCenterId: string | null,
    tracksLiveAnchor: boolean,
  ): boolean {
    if (sourceRevision !== this.sourceRevision || apsisCenterId !== this.apsisCenterId) return false;
    const sampleInterval = (end - this._state0.t) / C.PLAN_ARC_MAX_SAMPLES;
    if (this.decimation > sampleInterval * C.PLAN_ARC_MAX_SAMPLE_COARSENING) return false;
    if (state0 === this._state0) return true;
    if (!tracksLiveAnchor) return false;
    if (anchorJumped(this._state0, state0)) return false;
    const onArc = this.at(state0.t);
    if (onArc === null) return false;
    return len(sub(state0.r, onArc.r)) < len(state0.v) * sampleInterval;
  }

  // 答える範囲を [start.t, end] へ動かす。先頭は自身の積分結果上の start.t の状態へ進め(積分は
  // し直さない)、終端は伸びたぶんを現在の積分先端から継ぎ足す。start は represents が真を
  // 返したときの起点でなければならない — 積分結果の外を指す start では先頭が動かない。
  setRange(start: KinematicState, end: number): void {
    if (start.t > this._state0.t) {
      const front = this.at(start.t);
      if (front !== null) this._state0 = front;
    }
    this._end = end;
    // 先端が要求終端に届かない差がサンプル間隔未満なら折れ線の見た目は変わらないので継ぎ足さ
    // ない。毎フレームわずかに伸びる終端(空の計画の末尾区間)に1歩ずつ着地させると、通常の
    // 刻み幅より遥かに細かいステップをフレーム数ぶん積むことになる。
    const threshold = (end - this._state0.t) / C.PLAN_ARC_MAX_SAMPLES;
    if (!this.truncated && end > this._trajectory.state.t + threshold) this.integrateTo(end);
    else this.lastSteps = 0;
    this.apsisTrack?.dropBefore(this._state0.t);
  }

  // この区間が答える範囲の先頭状態。
  get state0(): KinematicState {
    return this._state0;
  }

  // この区間が答える終端時刻。
  get end(): number {
    return this._end;
  }

  // この区間の積分結果そのもの。折れ線描画は PlanPath がこれを読んで行う。
  get trajectory(): DynamicTrajectory {
    return this._trajectory;
  }

  // end でクリップしたサンプル列。TrajectoryLine.syncGeometry の再 bake 抑制はこの配列の参照
  // 同一性で判定するため、(元配列, end) でメモ化し、切る必要が無ければ元配列をそのまま返す。
  get samples(): readonly KinematicState[] {
    const source = this._trajectory.samplesOldestFirst();
    if (this.samplesCache && this.samplesCache.source === source && this.samplesCache.end === this._end) {
      return this.samplesCache.result;
    }
    const result = clipSamplesTo(source, this._end);
    this.samplesCache = { source, end: this._end, result };
    return result;
  }

  // 時刻 t の状態。end を超える、または保持区間外なら null。
  at(t: number): KinematicState | null {
    return stateAt(this._trajectory, t, this._end);
  }

  // 終端(= 次のノードの噴射直前)の状態。終端まで到達できなかった区間は null。
  endState(): KinematicState | null {
    return this.at(this._end);
  }

  // 積分中に最初に天体表面へ達した状態と、その天体。end を超えていれば(区間が縮んで
  // その先で見つかったことになれば)null。到達しなければ null。
  impactPoint(): BodyImpact | null {
    return this.impact && withinEnd(this.impact.state.t, this._end) ? this.impact : null;
  }

  // 近地点・遠地点の検出に使っている中心天体。apsisCenter を持たずに生成された区間では null。
  get apsisCenter(): Attractor | null {
    return this.apsisTrack?.center ?? null;
  }

  // 答える範囲で最初の近地点。中心天体へ接近し続けたまま表面へ達する
  // (衝突軌道で近地点が存在しない)場合や、end を超えていれば null。
  periapsisPoint(): KinematicState | null {
    const first = this.apsisTrack?.periapsis ?? null;
    return first && withinEnd(first.t, this._end) ? first : null;
  }

  // 答える範囲で最初の遠地点。楕円でない、区間がそこまで届かない、または end を
  // 超えていれば null。
  apoapsisPoint(): KinematicState | null {
    const first = this.apsisTrack?.apoapsis ?? null;
    return first && withinEnd(first.t, this._end) ? first : null;
  }

  // end まで積分結果を伸ばす。呼び出し時点の積分先端から続きを刻むので、区間全体を作り直さ
  // ない。いずれかの天体の表面へ接触するか、地球大気で焼失(REENTRY_ALT)したら、その時点で
  // 打ち切る(非有限の場合も同様) — 一度打ち切ったら以後は何もしない。
  // PLAN_ARC_MAX_STEPS は1回の呼び出しに対する上限で、使い切っても打ち切りではない — 続きは
  // 次の呼び出しが刻む。区間が生きたまま何フレームも使い回されるので、生涯累計を上限にすると
  // 描く窓が先端を追い越しても伸びなくなり、線が縮んで戻らなくなる。
  private integrateTo(end: number): void {
    if (this.truncated) { this.lastSteps = 0; return; }

    const trajectory = this._trajectory;
    const tipAtStart = trajectory.state.t;
    const duration = Math.max(0, end - this._state0.t);
    const sampleInterval = duration / C.PLAN_ARC_MAX_SAMPLES;
    this.decimation = Math.max(this.decimation, sampleInterval);

    let steps = 0;
    // 重力源は各ステップの開始・中点・終了時刻で解決する。月のように速く動く天体を長時間
    // 据え置くと、月周回の予測が固定された月の重力場を積分してしまうため、天体暦の時刻依存性
    // を積分へ反映する。
    while (trajectory.state.t < end - EPOCH_EPS) {
      const startHeld = this.provider.at(trajectory.state.t);
      // sweptHermiteSphereToi は開始時点で既に overlap している場合は null を返し、離散判定へ
      // 委譲する契約なので、衝突体全体に対してここでその離散判定を満たす。
      const containing = containingBody(trajectory.state.r, startHeld.collision, 0);
      if (containing) {
        this.impact = { state: trajectory.state, body: containing };
        this.truncated = true;
        break;
      }

      // 最後の1歩は end にちょうど着地させる — 終端がそのままノードの到達状態になる。
      const dt = Math.min(
        stepDt(trajectory.state, startHeld.gravity, startHeld.collision),
        end - trajectory.state.t,
      );
      if (dt <= 1e-9) {
        // ループ条件が残り時間 > EPOCH_EPS を保証するため、ここに来るのは天体接近で
        // stepDt の接近項が幾何級数的に潰れた場合のみ(clearance がステップごとに
        // 一定比率で縮み続け、符号は反転しないまま dt だけが 0 に収束する)。打ち切りが
        // truncated を立てないと、実際には衝突コースの区間が正常終端として扱われてしまう
        // ので、最寄り天体への衝突として記録する。
        const nearest = nearestByClearance(trajectory.state.r, startHeld.collision);
        if (nearest) this.impact = { state: trajectory.state, body: nearest };
        this.truncated = true;
        break;
      }
      const midHeld = this.provider.at(trajectory.state.t + dt / 2);
      const stepAttractors = attractorsNearInto(
        trajectory.state.r, midHeld.classified, this.stepAttractorsScratch,
      );
      const prev = trajectory.state;
      trajectory.step(dt, stepAttractors, C.SHIP_BCINV, C.SHIP_SRP_COEFF, null, sampleInterval, duration);

      const { r, v } = trajectory.state;
      const finite = Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z)
        && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
      if (!finite) {
        this.truncated = true;
        break;
      }
      this.apsisTrack?.observe(prev, trajectory.state);
      const endHeld = this.provider.at(trajectory.state.t);
      // 区間を跨いだ表面接触は、開始/終了時刻の全 collision body を候補にして掃引判定する。
      this.collisionCandidatesById.clear();
      this.collisionCandidates.length = 0;
      for (const body of startHeld.collision) {
        if (this.collisionCandidatesById.has(body.id)) continue;
        this.collisionCandidatesById.set(body.id, body);
        this.collisionCandidates.push(body);
      }
      for (const body of endHeld.collision) {
        if (this.collisionCandidatesById.has(body.id)) continue;
        this.collisionCandidatesById.set(body.id, body);
        this.collisionCandidates.push(body);
      }
      const candidates: readonly Attractor[] = this.collisionCandidates;
      const impact = findImpact(
        prev, trajectory.state, candidates,
        startHeld.collisionById, endHeld.collisionById, this.impactCandidates,
      );
      if (impact) {
        this.impact = impact;
        this.truncated = true;
        break;
      }
      const burnedUpAt = burnUpBody(r, endHeld.collision, C.REENTRY_ALT);
      if (burnedUpAt !== null) {
        this.impact = { state: trajectory.state, body: burnedUpAt };
        this.truncated = true;
        break;
      }
      steps++;
      if (steps >= C.PLAN_ARC_MAX_STEPS) break;
    }

    // 予算を使い切ったのに先端がサンプル1つぶんも進まないのは、刻み幅が潰れて収束していない
    // 状態 — 次の呼び出しでも同じことになるので、ここで打ち切る。
    if (steps >= C.PLAN_ARC_MAX_STEPS && sampleInterval > 0
      && trajectory.state.t - tipAtStart < sampleInterval) {
      this.truncated = true;
    }
    this.lastSteps = steps;
  }
}
