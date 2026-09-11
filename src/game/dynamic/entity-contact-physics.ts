// 物体どうしの剛体接触の列挙・解決。交戦圏ごとに、その内側で collides を立てた参加者どうしの
// 接触を 1 substep ぶん TOI(接触時刻)昇順で解き、反発が起きた当事者へ collideWithEntity を呼ぶ。
// 参加者は互いの状態を書き換えるので、1 substep に解く件数に上限を置く。
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { Vec3, add, scale, sameVec } from '../../math/vec3';
import { HierarchicalSpatialGrid } from '../../math/hierarchical-spatial-grid';
import type { DynamicReactionServices, EntityContactParticipant } from './dynamic-simulation-participant';
import type { EngagementZone } from './engagement-zone';
import type { CollisionResponse } from '../../physics/collision-response';
import { contactTime, isFiniteParticipant } from './contact-participant';
import { entityContactResponse } from './entity-contact-response';

// 1 substep のあいだに1つの交戦圏で解決する接触の上限。TOI(接触時刻)昇順で解決し、これを
// 超えた分は次の substep でグリッドから列挙し直されて改めて候補になる。
const CONTACT_MAX_RESOLUTIONS_PER_SUBSTEP = 8;

// 接触の候補を引く階層グリッドの、最も細かい段の一辺 [m]。
const CONTACT_GRID_MIN_CELL_SIZE = 1;

// 1 substep 分の接触候補1件。当事者は参加者列の添字 ai / bi で指す。response が null なのは
// 現在の状態では接触しないという意味で、当事者の状態が変われば非 null になりうる。
// resolved を立てた候補は以後選ばれない。
interface Candidate {
  ai: number;
  bi: number;
  response: CollisionResponse | null;
  resolved: boolean;
}

// 動いた当事者だけ working[i] を after へ差し替え、changed へ1度だけ積む。書き戻しは予測弧を
// 捨て、state セッタは prevState を進めるので、動いていない当事者を書き戻したり、同じ当事者を
// substep 内で2度書き戻したりしてはならない。
function replaceIfMoved(
  i: number,
  after: { readonly r: Vec3; readonly v: Vec3 },
  working: KinematicState[],
  changed: number[],
): void {
  const before = working[i]!;
  if (sameVec(before.r, after.r) && sameVec(before.v, after.v)) return;
  working[i] = kinematicState<'eci'>(before.t, after.r, after.v);
  if (!changed.includes(i)) changed.push(i);
}

// 参加者 1 体の到達量 [m]。半径に、区間 prevState→working の変位から基準変位 reference を引いた
// 大きさを足したもの。ペア (a,b) が区間内で接触するなら、区間終端の中心距離は両者の到達量の和
// 以下になる。
function contactReach(entity: EntityContactParticipant, working: KinematicState, reference: Vec3): number {
  const w = working.r, p = entity.prevState.r;
  const dx = w.x - p.x - reference.x, dy = w.y - p.y - reference.y, dz = w.z - p.z - reference.z;
  return entity.radius + Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export class EntityContactPhysics {
  // 作業用の配列。解決は1回の呼び出しの内で完結するので使い回せる。詰め直しは元の走査順を保つ。
  private readonly participantScratch: EntityContactParticipant[] = [];
  private readonly workingScratch: KinematicState[] = [];
  private readonly changedScratch: number[] = [];
  private readonly pairScratch: number[] = [];
  private readonly gridScratch = new HierarchicalSpatialGrid<number>(CONTACT_GRID_MIN_CELL_SIZE);
  private readonly candidateScratch: Candidate[] = [];
  // 列挙した延べ候補ペア数。解決のたびに積み増す。
  public candidatePairs = 0;
  // 交戦圏ごとの参加者数の延べ数。解決のたびに積み増す。
  public participants = 0;

  // 交戦圏ごとに、その内側にいる参加者どうしの 1 substep ぶんの接触を解く。交戦圏どうしは
  // 独立した系なので、解決回数の上限も交戦圏ごとに掛かる。
  public resolveEntityContacts(
    simTime: number, entities: readonly EntityContactParticipant[],
    zones: readonly EngagementZone<EntityContactParticipant>[], services: DynamicReactionServices,
  ): void {
    for (const zone of zones) {
      this.collectParticipants(entities, zone, this.participantScratch);
      this.participants += this.participantScratch.length;
      this.resolveInOrder(this.participantScratch, simTime, zone.referenceDisplacement, services);
    }
  }

  // 交戦圏の内側にいて接触を解ける個体だけを out へ詰め直す。out の元の中身は捨てる。
  private collectParticipants(
    source: readonly EntityContactParticipant[], zone: EngagementZone<EntityContactParticipant>,
    out: EntityContactParticipant[],
  ): void {
    out.length = 0;
    for (const entity of source) {
      if (!entity.alive || !entity.collides || !isFiniteParticipant(entity)) continue;
      if (zone.contains(entity.state.r)) out.push(entity);
    }
  }

  // 参加者どうしの接触候補を1回だけ列挙し、TOI が最小のものから1件ずつ解決する。上限回数を
  // 超えた分は次の substep へ持ち越す。
  private resolveInOrder(
    all: readonly EntityContactParticipant[],
    simTime: number,
    reference: Vec3,
    services: DynamicReactionServices,
  ): void {
    if (all.length === 0) return;
    const working = this.workingScratch;
    working.length = 0;
    for (const e of all) working.push(e.state);
    const changed = this.changedScratch;
    changed.length = 0;

    this.insertParticipants(all, working, reference);
    const count = this.collectCandidates(all, simTime, working);
    this.candidatePairs += count;
    // 直前の解決で状態が変わった当事者。これを含まない候補の response は引き直しても同じ値に
    // なるので、含む候補だけを引き直す。-1 は「まだ無い」。
    let dirtyA = -1;
    let dirtyB = -1;
    for (let i = 0; i < CONTACT_MAX_RESOLUTIONS_PER_SUBSTEP; i++) {
      const best = this.earliestContact(count, dirtyA, dirtyB, all, working);
      if (best === null) break;
      this.applyCandidate(best, all, working, changed, services);
      best.resolved = true;
      dirtyA = best.ai;
      dirtyB = best.bi;
    }
    // 書き戻しは全解決の後に一括で — 途中で書くと state セッタが prevState を進め、区間の始点を失う。
    for (const i of changed) all[i]!.state = working[i]!;
    // 使わなかった末尾を落とす — 候補は反発の計算結果を抱えるので、残すと使われない
    // CollisionResponse が候補列の中だけ生き続ける。
    this.candidateScratch.length = count;
  }

  // 参加者を到達量つきでグリッドへ登録し直す。接触の成否を決めるのは参加者どうしの相対変位なので、
  // 到達量は交戦圏の基準変位 reference を差し引いた量で測る。
  private insertParticipants(
    all: readonly EntityContactParticipant[], working: readonly KinematicState[], reference: Vec3,
  ): void {
    this.gridScratch.reset();
    for (let i = 0; i < all.length; i++) {
      this.gridScratch.insert(i, working[i]!.r, contactReach(all[i]!, working[i]!, reference));
    }
  }

  // グリッドが返すペアのうち、contactsWith を両向きに通ったものだけを候補列へ詰め直して件数を
  // 返す。接触しない組み合わせも response=null の候補として残す — 当事者の状態が変われば
  // 接触しうるため。
  private collectCandidates(
    all: readonly EntityContactParticipant[],
    simTime: number,
    working: readonly KinematicState[],
  ): number {
    const pairs = this.gridScratch.pairsInto(this.pairScratch);
    let count = 0;
    for (let k = 0; k < pairs.length; k += 2) {
      // グリッドの返す順は不定で、a と b の役は対称でないので、a 側を参加者の並びで固定する。
      const ai = Math.min(pairs[k]!, pairs[k + 1]!), bi = Math.max(pairs[k]!, pairs[k + 1]!);
      const a = all[ai]!, b = all[bi]!;
      if (!a.contactsWith(b, simTime) || !b.contactsWith(a, simTime)) continue;
      this.pushCandidate(count++, ai, bi, entityContactResponse(a, working[ai]!, b, working[bi]!));
    }

    return count;
  }

  // 候補列の index 番目を書き直す。既にあるスロットはオブジェクトごと使い回す。
  private pushCandidate(
    index: number, ai: number, bi: number, response: CollisionResponse | null,
  ): void {
    const slot = this.candidateScratch[index];
    if (slot === undefined) this.candidateScratch.push({ ai, bi, response, resolved: false });
    else {
      slot.ai = ai;
      slot.bi = bi;
      slot.response = response;
      slot.resolved = false;
    }
  }

  // 未解決の候補のうち TOI が最小のものを返す(接触するものが無ければ null)。
  private earliestContact(
    count: number,
    dirtyA: number,
    dirtyB: number,
    all: readonly EntityContactParticipant[],
    working: readonly KinematicState[],
  ): Candidate | null {
    let best: Candidate | null = null;
    for (let i = 0; i < count; i++) {
      const candidate = this.candidateScratch[i]!;
      if (candidate.resolved) continue;
      // dirtyA/dirtyB を当事者に含む候補は、いまの working 上の値で response を引き直す。
      const { ai, bi } = candidate;
      if (ai === dirtyA || ai === dirtyB || bi === dirtyA || bi === dirtyB) {
        candidate.response = entityContactResponse(all[ai]!, working[ai]!, all[bi]!, working[bi]!);
      }
      const response = candidate.response;
      if (response !== null && (best === null || response.toi < best.response!.toi)) best = candidate;
    }
    return best;
  }

  // 候補を1件解決する: working 上の状態を補正後の値へ差し替え、反発が起きたときだけ両者へ
  // collideWithEntity を順不同で呼ぶ(接触時点の値は working から取った Contact に持たせて
  // あるので、呼び出し順に結果は依存しない)。
  private applyCandidate(
    candidate: Candidate,
    all: readonly EntityContactParticipant[],
    working: KinematicState[],
    changed: number[],
    services: DynamicReactionServices,
  ): void {
    const { ai, bi } = candidate;
    const a = all[ai]!, b = all[bi]!;
    const response = candidate.response!;
    const aBefore = working[ai]!;
    const bBefore = working[bi]!;
    replaceIfMoved(ai, { r: response.rA, v: response.vA }, working, changed);
    replaceIfMoved(bi, { r: response.rB, v: response.vB }, working, changed);
    if (!response.bounced) return;

    // 反発で失われた力学エネルギーは熱になる。当事者の判断ではなく物理なので、ダメージや
    // 効果音を委ねる前にここで当てる。
    a.absorbHeat(response.specificEnergyLossA);
    b.absorbHeat(response.specificEnergyLossB);

    const point = response.contactPoint ?? add(response.rA, scale(response.normal, a.radius));
    const t = contactTime(a, response.toi);
    a.collideWithEntity(b, {
      t, point, normal: response.normal, selfState: aBefore, otherState: bBefore,
    }, services);
    b.collideWithEntity(a, {
      t, point, normal: scale(response.normal, -1), selfState: bBefore, otherState: aBefore,
    }, services);
  }
}
