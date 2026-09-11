// 天体の表面との剛体接触。個体1つにつき、区間内で最も早く触れる天体を1体だけ解いて反発を
// 当て、当事者へ collideWithCelestialBody を呼ぶ。天体の状態は書き換わらないので、個体ごとに
// 独立に解ける。
import { distributeFixedContact } from '../../physics/collision-response';
import { firstSurfaceContact } from '../../physics/surface-contact';
import { kinematicState } from '../../physics/kinematic-state';
import { add, sameVec, scale } from '../../math/vec3';
import type { DynamicReactionServices, SurfaceContactParticipant } from './dynamic-simulation-participant';
import { contactTime, isFiniteSurfaceParticipant } from './contact-participant';
import { SurfaceCandidates } from './surface-candidates';
import { CONTACT_RESTITUTION } from './entity-contact-response';
import type { CelestialBody } from '../../physics/celestial-body';

// フレームの区間で取る到達範囲の倍率。1 は掃引そのもの。サブステップ中点から引いた天体位置の
// ずれ(掃引の (n·h)²/6 倍以下、最高段の月で 9%)を掃引ぶんの余裕で覆う。絞り込みは通す側へ
// 外れてよく、落としてはいけない。
const SPAN_REACH_MARGIN = 2;

// 天体との接触に参加するか。取り付いた付属物は本体が代表する。
function isParticipant(e: SurfaceContactParticipant): boolean {
  return e.alive && e.attachedTo === null && isFiniteSurfaceParticipant(e);
}

// 位置・速度・半径が有限か。
function isFiniteCelestialBody(a: CelestialBody, pivot: number): boolean {
  const { r, v } = a.stateAt(pivot);
  return Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z)
    && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
    && Number.isFinite(a.def.radius);
}

export class SurfaceContactPhysics {
  // 解決は区間ごとに同期的に完了するので、作業配列を使い回せる。
  private readonly participantScratch: SurfaceContactParticipant[] = [];
  private readonly bodyScratch: CelestialBody[] = [];
  private readonly candidates = new SurfaceCandidates();
  private readonly nearbyScratch: CelestialBody[] = [];
  // 天体の位置を厳密に引く時刻。beginSubstep が受け取り、そのサブステップの解決すべてで使う。
  private pivot = 0;
  // 絞り込みを通した延べ候補天体数。解決のたびに積み増す。
  public candidateBodies = 0;

  // フレームの区間 [tStart, tEnd] で触れうる天体の下ごしらえ。判定できる天体を選び、各天体の
  // 表面がその区間のあいだに届きうる範囲を求める。フレームに1度、サブステップより先に呼ぶ。
  public beginFrame(
    celestialBodies: readonly CelestialBody[], framePivot: number, tStart: number, tEnd: number,
  ): void {
    this.collectCelestialBodies(celestialBodies, framePivot, this.bodyScratch);
    this.candidates.resetSpan(this.bodyScratch, framePivot, tStart, tEnd, SPAN_REACH_MARGIN);
  }

  // このサブステップで天体の位置を厳密に引く時刻を受け取る。接触の幾何はこの時刻から解く。
  // 参加者の位置で狭めた選び先は、参加者が進んだこの時点で捨てる。
  public beginSubstep(pivot: number): void {
    this.pivot = pivot;
    this.candidates.resetNarrow();
  }

  // 個体1つの天体との接触。区間は beginSubstep へ渡した区間の内側であればよい。
  public resolveOne(e: SurfaceContactParticipant, services: DynamicReactionServices): void {
    if (!isParticipant(e)) return;
    this.resolveAgainstCandidates(e, services);
  }

  // 区間を共有する個体をまとめて解く。顔ぶれで先に絞り込むぶん1体あたりが安くなるので、
  // **同じ区間を1歩で渡った個体をここへまとめる。** 絞り込みは次の beginSubstep まで残る。
  public resolveShared(entities: readonly SurfaceContactParticipant[], services: DynamicReactionServices): void {
    this.collectParticipants(entities, this.participantScratch);
    if (this.participantScratch.length === 0) return;
    this.candidates.narrow(this.participantScratch);
    for (const e of this.participantScratch) this.resolveAgainstCandidates(e, services);
  }

  // 個体1つが区間内で最も早く触れる天体を1体だけ解き、反発を当ててから
  // collideWithCelestialBody を呼ぶ。
  private resolveAgainstCandidates(e: SurfaceContactParticipant, services: DynamicReactionServices): void {
    const candidates = this.candidates.into(e, this.nearbyScratch);
    this.candidateBodies += candidates.length;
    const hit = firstSurfaceContact(e.prevState, e.state, e.radius, candidates, this.pivot);
    if (hit === null) return;

    // 天体の状態は個体の区間終端の時刻へ外挿してから渡す — pivot は区間に1つなので、
    // そのままでは接触の瞬間と別の時刻の値になる。
    const response = distributeFixedContact(
      { state: e.state, radius: e.radius },
      { state: hit.body.stateAt(this.pivot, e.state.t), radius: hit.body.def.radius },
      CONTACT_RESTITUTION, hit.geometry);

    const before = e.state;
    // 位置も速度も動いていなければ書き戻さない — 書き戻しは予測弧を捨てる。
    if (!sameVec(before.r, response.r) || !sameVec(before.v, response.v)) {
      e.state = kinematicState<'eci'>(before.t, response.r, response.v);
    }
    if (!response.bounced) return;
    // 反発で失われた力学エネルギーは熱になる。当事者の判断ではなく物理なので、失われるかどうか
    // を委ねる前にここで当てる。
    e.absorbHeat(response.specificEnergyLoss);
    e.collideWithCelestialBody(hit.body, {
      t: contactTime(e, response.toi),
      point: add(response.r, scale(response.normal, e.radius)),
      normal: response.normal,
      selfState: before,
      otherState: hit.body.stateAt(this.pivot),
    }, services);
  }

  // 参加者だけを out へ写す。out は呼び出し側が所有する。
  private collectParticipants(
    source: readonly SurfaceContactParticipant[], out: SurfaceContactParticipant[],
  ): void {
    out.length = 0;
    for (const entity of source) if (isParticipant(entity)) out.push(entity);
  }

  // 判定できる天体だけを out へ写す。out は呼び出し側が所有する。
  private collectCelestialBodies(
    source: readonly CelestialBody[], pivot: number, out: CelestialBody[],
  ): void {
    out.length = 0;
    for (const celestialBody of source) {
      if (isFiniteCelestialBody(celestialBody, pivot)) out.push(celestialBody);
    }
  }
}
