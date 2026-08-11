// 計画軌道の1区間(arc)。起点状態から終端時刻までを DynamicTrajectory で数値積分し、その保持
// サンプル列を1本の折れ線として描く。マニューバノードによる区間分割は知らない — 呼び出し側
// (PlanPath)が arc ごとにこれを持つ。
import type * as THREE from 'three/webgpu';
import { KinematicState, hermiteInterpolate, kinematicState } from '../../physics/kinematic-state';
import { DynamicTrajectory } from '../../physics/dynamic-trajectory';
import { ReferenceFrame } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';
import { Attractor, localOrbitPeriod } from '../../physics/attractor';
import { containingBody, sweptHermiteSphereToi } from '../../physics/sphere-contact';
import { apsisCrossing } from '../../physics/trajectory-features';
import { isBurnedUp } from '../../physics/atmosphere';
import { attractorsNearInto, classifyAttractors } from '../simulation/attractors';
import type { ClassifiedAttractors, PlanAttractorProvider, PlanAttractorSources } from '../simulation/attractors';
import { addScaled, len, scale, sub, Vec3 } from '../../physics/vec3';
import { FloatingOrigin } from '../floating-origin';
import { SampledLine } from '../../render/sampled-line';
import { ScaleFn } from '../camera/camera-system';
import * as C from '../const';

// 積分の終端は要求時刻に対して丸め誤差ぶん手前に落ちうる。この幅までは終端そのものとみなす。
const EPOCH_EPS = 1e-6;

// 天体接近時、1ステップで表面までの距離を跨いでしまわないための安全率
// (表面までの距離 ÷ 相対速度 に掛ける上限係数)。
const APPROACH_STEP_SAFETY = 0.5;

type ComputeKey = {
  state0: KinematicState;
  end: number;
  sourceRevision: number;
  apsisCenterId: string | null;
};

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

export interface PlanImpact {
  readonly state: KinematicState;
  readonly body: Attractor;
}

type ImpactCandidate = { body: Attractor; toi: number };

// ある時刻の重力源・衝突体と、そこから導かれる空間分類・衝突体の id 索引。
type HeldSources = {
  readonly t: number;
  readonly sources: PlanAttractorSources;
  readonly collisionById: ReadonlyMap<string, Attractor>;
  readonly classified: ClassifiedAttractors;
};

// 時刻 t の対象一式を一度に解決する。
function holdSources(provider: PlanAttractorProvider, t: number): HeldSources {
  const sources = provider.at(t);
  const collisionById = new Map<string, Attractor>();
  for (const body of sources.collision) {
    if (!collisionById.has(body.id)) collisionById.set(body.id, body);
  }
  return { t, sources, collisionById, classified: classifyAttractors(sources.gravity) };
}

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
): PlanImpact | null {
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
  private readonly line: SampledLine;
  // integrate() は同期的に完了し、これらの配列・Mapを外へ返さない。したがって区間の再積分
  // ごとに同じ一時領域を再利用できる。Mapの挿入順と候補配列の順序は従来の spread と同じ。
  private readonly collisionCandidatesById = new Map<string, Attractor>();
  private readonly collisionCandidates: Attractor[] = [];
  private readonly impactCandidates: ImpactCandidate[] = [];
  private readonly stepAttractorsScratch: Attractor[] = [];
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
  // 直近の再積分で回した積分step数。
  lastSteps = 0;

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
  // スキップする。この閾値判定は「同じ軌道が時間方向に進んだだけ」という前提の上でだけ
  // 正しいので、起点が別の軌道へ飛んだ場合(別艦への切り替え・ドック発進・衝突による
  // 状態上書き)は anchorJumped で先に拾い、差分の大小に関わらず即座に再積分する。
  // tracksLiveAnchor でなければ state0/end の同一性・値の変化で即座に再積分する
  // (ノードの Δv 編集は state0 の同一性変化で必ず拾われる)。apsisCenter は
  // periapsisPoint/apoapsisPoint を検出する基準天体 — null なら検出自体を行わない。
  // 返り値は再積分したかどうか。
  update(
    state0: KinematicState, end: number, attractorProvider: PlanAttractorProvider,
    tracksLiveAnchor: boolean,
    apsisCenter: Attractor | null,
  ): boolean {
    const apsisCenterId = apsisCenter?.id ?? null;
    const inputChanged = this.key === null
      || this.key.sourceRevision !== attractorProvider.revision
      || this.key.apsisCenterId !== apsisCenterId;
    let recompute: boolean;
    if (tracksLiveAnchor) {
      const anchorSwapped = this.key !== null && state0 !== this.key.state0
        && anchorJumped(this.key.state0, state0);
      const duration = end - state0.t;
      const keyDuration = this.key ? this.key.end - this.key.state0.t : NaN;
      const sampleInterval = this.key ? keyDuration / C.PLAN_ARC_MAX_SAMPLES : 0;
      const durationChanged = this.key === null || Math.abs(duration - keyDuration) >= sampleInterval;
      const anchorDrifted = this.key !== null && Math.abs(state0.t - this.key.state0.t) >= sampleInterval;
      recompute = inputChanged || anchorSwapped || durationChanged || anchorDrifted;
    } else {
      recompute = inputChanged || this.key === null || state0 !== this.key.state0 || end !== this.key.end;
    }
    if (recompute) {
      this.integrate(state0, end, attractorProvider, apsisCenter);
      this.key = { state0, end, sourceRevision: attractorProvider.revision, apsisCenterId };
    }
    return recompute;
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
  // provider は積分中の時刻ごとに重力源と衝突体を答える。動的 entity の現在位置を区間全体へ
  // 凍結せず、予測列が存在しない entity は provider 側で明示的に除外する。
  private integrate(
    state0: KinematicState, end: number, attractorProvider: PlanAttractorProvider,
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
    // 重力源と衝突体は、積分先端が ATTRACTOR_REBUILD_SEC 進むごとに1回だけ組み直し、その間は
    // 据え置く — 据え置いた時間ぶんの天体位置のズレは、この区間の刻み幅そのものが持つ RK4 の
    // 誤差より小さい。provider は毎回一意な時刻を要求されると暦のキャッシュに当たらないので、
    // 1ステップごとに引くと区間全体の費用がこの1点で決まってしまう。
    let held = holdSources(attractorProvider, trajectory.state.t);
    while (trajectory.state.t < end - EPOCH_EPS) {
      const startSources = held.sources;
      // sweptHermiteSphereToi は開始時点で既に overlap している場合は null を返し、離散判定へ
      // 委譲する契約なので、衝突体全体に対してここでその離散判定を満たす。
      const containing = containingBody(trajectory.state.r, startSources.collision, 0);
      if (containing) {
        this.impact = { state: trajectory.state, body: containing };
        this.truncated = true;
        break;
      }

      // 最後の1歩は end にちょうど着地させる — 終端がそのままノードの到達状態になる。
      const dt = Math.min(
        stepDt(trajectory.state, startSources.gravity, startSources.collision),
        end - trajectory.state.t,
      );
      if (dt <= 1e-9) {
        // ループ条件が残り時間 > EPOCH_EPS を保証するため、ここに来るのは天体接近で
        // stepDt の接近項が幾何級数的に潰れた場合のみ(clearance がステップごとに
        // 一定比率で縮み続け、符号は反転しないまま dt だけが 0 に収束する)。打ち切りが
        // truncated を立てないと、実際には衝突コースの区間が正常終端として扱われてしまう
        // ので、最寄り天体への衝突として記録する。
        const nearest = nearestByClearance(trajectory.state.r, startSources.collision);
        if (nearest) this.impact = { state: trajectory.state, body: nearest };
        this.truncated = true;
        break;
      }
      const stepAttractors = attractorsNearInto(
        trajectory.state.r, held.classified, this.stepAttractorsScratch,
      );
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
      // 据え置き期間を跨いだステップだけ、対象を組み直して始終点の顔ぶれが変わる。
      const startHeld = held;
      if (trajectory.state.t - held.t >= C.ATTRACTOR_REBUILD_SEC) {
        held = holdSources(attractorProvider, trajectory.state.t);
      }
      // 区間を跨いだ表面接触は、開始/終了時刻の全 collision body を候補にして掃引判定する。
      let candidates: readonly Attractor[] = held.sources.collision;
      if (held !== startHeld) {
        this.collisionCandidatesById.clear();
        this.collisionCandidates.length = 0;
        for (const body of startHeld.sources.collision) {
          if (this.collisionCandidatesById.has(body.id)) continue;
          this.collisionCandidatesById.set(body.id, body);
          this.collisionCandidates.push(body);
        }
        for (const body of held.sources.collision) {
          if (this.collisionCandidatesById.has(body.id)) continue;
          this.collisionCandidatesById.set(body.id, body);
          this.collisionCandidates.push(body);
        }
        candidates = this.collisionCandidates;
      }
      const impact = findImpact(
        prev, trajectory.state, candidates,
        startHeld.collisionById, held.collisionById, this.impactCandidates,
      );
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
    }

    this.lastSteps = steps;
    this.trajectory = trajectory;
    this._samples = trajectory.samplesOldestFirst();
  }
}
