// 物体どうしの剛体接触の列挙・解決。交戦圏ごとに、その内側で collides を立てた参加者どうしの
// 接触を 1 substep ぶん TOI(接触時刻)昇順で解き、反発が起きた当事者へ collideWithEntity を呼ぶ。
import { type KinematicState, kinematicState } from '../../physics/kinematic-state';
import { type Vec3, add, distSq, scale, sameVec } from '../../math/vec3';
import { HierarchicalSpatialGrid } from '../../math/hierarchical-spatial-grid';
import type { DynamicReactionServices, EntityContactParticipant } from './dynamic-simulation-participant';
import type { EngagementZone } from './engagement-zone';
import type { CollisionResponse } from '../../physics/collision-response';
import { contactTime, isFiniteParticipant } from './contact-participant';
import { entityContactResponse } from './entity-contact-response';

// 1 substep のあいだに1つの交戦圏で解決する接触の上限。超えた分は次の substep で改めて候補になる。
const CONTACT_MAX_RESOLUTIONS_PER_SUBSTEP = 8;

// 接触の候補を引く階層グリッドの、最も細かい段の一辺 [m]。
const CONTACT_GRID_MIN_CELL_SIZE = 1;

// 薬莢の剛体接触を判定する艦(アンカー)からの最大距離 [m](SPEC/COMBAT.md「薬莢」)。
export const CASING_CONTACT_MAX_DISTANCE = 30;
const CASING_CONTACT_MAX_DISTANCE_SQ = CASING_CONTACT_MAX_DISTANCE ** 2;

// 薬莢同士の剛体接触を判定する艦(アンカー)からの最大距離 [m](SPEC/COMBAT.md「薬莢」)。
export const CASING_CASING_CONTACT_MAX_DISTANCE = 15;
const CASING_CASING_CONTACT_MAX_DISTANCE_SQ = CASING_CASING_CONTACT_MAX_DISTANCE ** 2;

// 密集時に1個の薬莢が同時に接触判定を行う最大相手数(過密時のペア爆発防止)。
export const CASING_MAX_PAIRS_PER_ENTITY = 4;

// 1 substep 分の接触候補1件。当事者は参加者列の添字 ai / bi で指す。
// evaluated は response の幾何計算を行ったかを表し、未評価の候補は earliestContact で遅延評価する。
// resolved を立てた候補は以後選ばれない。
interface Candidate {
  ai: number;
  bi: number;
  response: CollisionResponse | null;
  evaluated: boolean;
  resolved: boolean;
}

// 動いた当事者だけ working[i] を after へ差し替え、changed へ1度だけ積む。書き戻しは予測弧を
// 捨て、prevState を進めるので、動いていない当事者や同じ当事者を substep 内で2度書き戻してはならない。
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

// 薬莢が交戦圏のアンカー(艦)の近傍にいるか。薬莢以外の個体は常に true。
function isCasingInContactRange(
  entity: EntityContactParticipant, zone: EngagementZone<EntityContactParticipant>,
): boolean {
  if (entity.contactKind !== 'casing') return true;
  for (const anchor of zone.anchors) {
    if (distSq(anchor.state.r, entity.state.r) <= CASING_CONTACT_MAX_DISTANCE_SQ) return true;
  }
  return false;
}

// 2体の外接球が区間内で接触可能かどうかの高速幾何事前判定。
// 静止状態の中心間距離、または相対並進区間内の最短中心間距離が外接半径和以下かを調べる。
function canBoundingSpheresOverlap(
  a: EntityContactParticipant, aWork: KinematicState,
  b: EntityContactParticipant, bWork: KinematicState,
): boolean {
  const maxDist = a.radius + b.radius;
  const maxDistSq = maxDist * maxDist;

  const dx = bWork.r.x - aWork.r.x;
  const dy = bWork.r.y - aWork.r.y;
  const dz = bWork.r.z - aWork.r.z;
  const currDistSq = dx * dx + dy * dy + dz * dz;
  if (currDistSq <= maxDistSq) return true;

  const sweptValid = a.prevState.t < aWork.t && b.prevState.t < bWork.t
    && Math.abs(a.prevState.t - b.prevState.t) <= 1e-6;
  if (!sweptValid) return false;

  const prevDx = b.prevState.r.x - a.prevState.r.x;
  const prevDy = b.prevState.r.y - a.prevState.r.y;
  const prevDz = b.prevState.r.z - a.prevState.r.z;

  const vx = dx - prevDx;
  const vy = dy - prevDy;
  const vz = dz - prevDz;
  const vSq = vx * vx + vy * vy + vz * vz;
  if (vSq <= 1e-12) return false;

  const t = Math.max(0, Math.min(1, -(prevDx * vx + prevDy * vy + prevDz * vz) / vSq));
  const closestX = prevDx + vx * t;
  const closestY = prevDy + vy * t;
  const closestZ = prevDz + vz * t;
  return closestX * closestX + closestY * closestY + closestZ * closestZ <= maxDistSq;
}

export class EntityContactPhysics {
  // 作業用の配列。解決は1回の呼び出しの内で完結するので使い回せる。詰め直しは元の走査順を保つ。
  private readonly participantScratch: EntityContactParticipant[] = [];
  private readonly workingScratch: KinematicState[] = [];
  private readonly changedScratch: number[] = [];
  private readonly pairScratch: number[] = [];
  private readonly casingPairCountScratch: number[] = [];
  private readonly gridScratch = new HierarchicalSpatialGrid<number>(CONTACT_GRID_MIN_CELL_SIZE);
  private readonly candidateScratch: Candidate[] = [];
  // 列挙した延べ候補ペア数と、交戦圏ごとの参加者数の延べ数。resetCounts で 0 へ戻す。
  private _candidatePairs = 0;
  private _participants = 0;

  public get candidatePairs(): number { return this._candidatePairs; }
  public get participants(): number { return this._participants; }

  // 延べの計数を 0 へ戻す。
  public resetCounts(): void {
    this._candidatePairs = 0;
    this._participants = 0;
  }

  // 交戦圏ごとに、その内側にいる参加者どうしの 1 substep ぶんの接触判定・衝突応答を処理する。交戦圏どうしは
  // 独立した系なので、解決回数の上限も交戦圏ごとに掛かる。
  public resolveEntityContacts(
    simTime: number, entities: readonly EntityContactParticipant[],
    zones: readonly EngagementZone<EntityContactParticipant>[], services: DynamicReactionServices,
  ): void {
    for (const zone of zones) {
      this.collectParticipants(entities, zone, this.participantScratch);
      this._participants += this.participantScratch.length;
      this.resolveInOrder(this.participantScratch, simTime, zone, services);
    }
  }

  // 交戦圏の内側にいて接触判定の対象となる個体だけを out へ詰め直す。out の元の中身は捨てる。
  // 薬莢は艦の近傍(30m以内)にいる個体に限る(SPEC/COMBAT.md「薬莢」)。
  private collectParticipants(
    source: readonly EntityContactParticipant[], zone: EngagementZone<EntityContactParticipant>,
    out: EntityContactParticipant[],
  ): void {
    out.length = 0;
    for (const entity of source) {
      if (!entity.alive || !entity.collides || !isFiniteParticipant(entity)) continue;
      if (!zone.contains(entity.state.r)) continue;
      if (!isCasingInContactRange(entity, zone)) continue;
      out.push(entity);
    }
  }

  // 参加者どうしの接触候補を1回だけ列挙し、TOI が最小のものから1件ずつ解決する。上限回数を
  // 超えた分は次の substep へ持ち越す。
  private resolveInOrder(
    all: readonly EntityContactParticipant[],
    simTime: number,
    zone: EngagementZone<EntityContactParticipant>,
    services: DynamicReactionServices,
  ): void {
    if (all.length === 0) return;
    const working = this.workingScratch;
    working.length = 0;
    for (const e of all) working.push(e.state);
    const changed = this.changedScratch;
    changed.length = 0;

    this.insertParticipants(all, working, zone.referenceDisplacement);
    const count = this.collectCandidates(all, simTime, working, zone);
    this._candidatePairs += count;
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
    // 書き戻しは全解決の後に一括で — 途中で置き換えると prevState が進み、区間の始点を失う。
    for (const i of changed) all[i]!.reset(working[i]!);
    // 未使用の末尾要素を切り捨て、保持していた CollisionResponse を解放する。
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

  // 薬莢同士の接触が LOD 範囲内(アンカーから15m以内)か判定する。
  private isCasingPairInLODRange(
    a: EntityContactParticipant, b: EntityContactParticipant, zone: EngagementZone<EntityContactParticipant>,
  ): boolean {
    let aNear = false;
    let bNear = false;
    for (const anchor of zone.anchors) {
      if (!aNear && distSq(anchor.state.r, a.state.r) <= CASING_CASING_CONTACT_MAX_DISTANCE_SQ) aNear = true;
      if (!bNear && distSq(anchor.state.r, b.state.r) <= CASING_CASING_CONTACT_MAX_DISTANCE_SQ) bNear = true;
      if (aNear && bNear) return true;
    }
    return false;
  }

  // グリッドが返すペアのうち、接触可能性がありフィルタを通ったものを候補列へ積む。
  // 詳細幾何判定(entityContactResponse)はここでは行わず、earliestContact で遅延評価する。
  private collectCandidates(
    all: readonly EntityContactParticipant[],
    simTime: number,
    working: readonly KinematicState[],
    zone: EngagementZone<EntityContactParticipant>,
  ): number {
    const pairs = this.gridScratch.pairsInto(this.pairScratch);
    let count = 0;

    // 薬莢あたりのペア採用数を追跡する作業配列を初期化
    const casingPairCounts = this.casingPairCountScratch;
    casingPairCounts.length = all.length;
    casingPairCounts.fill(0);

    for (let k = 0; k < pairs.length; k += 2) {
      // グリッドの返す順は不定で、a と b の役は対称でないので、a 側を参加者の並びで固定する。
      const ai = Math.min(pairs[k]!, pairs[k + 1]!), bi = Math.max(pairs[k]!, pairs[k + 1]!);
      const a = all[ai]!, b = all[bi]!;
      if (!a.contactsWith(b, simTime) || !b.contactsWith(a, simTime)) continue;

      // 薬莢同士の接触LOD: 艦から15m以遠のペアは除外する(SPEC/COMBAT.md「薬莢」)。
      const isCasingPair = a.contactKind === 'casing' && b.contactKind === 'casing';
      if (isCasingPair) {
        if (!this.isCasingPairInLODRange(a, b, zone)) continue;
        // 密集時の過密ペア数クリッピング: 個体あたりの接触相手上限を超えたら除外する
        if (casingPairCounts[ai]! >= CASING_MAX_PAIRS_PER_ENTITY || casingPairCounts[bi]! >= CASING_MAX_PAIRS_PER_ENTITY) {
          continue;
        }
      }

      // 外接球の事前バウンディング判定: 外接球が触れ得ないペアは幾何判定を行わず除外
      if (!canBoundingSpheresOverlap(a, working[ai]!, b, working[bi]!)) continue;

      if (isCasingPair) {
        casingPairCounts[ai] = casingPairCounts[ai]! + 1;
        casingPairCounts[bi] = casingPairCounts[bi]! + 1;
      }

      this.pushCandidate(count++, ai, bi);
    }

    return count;
  }

  // 候補列の index 番目を書き直す。既にあるスロットはオブジェクトごと使い回す。
  // response は未計算(null)、evaluated は false として登録し、解決時に遅延評価する。
  private pushCandidate(
    index: number, ai: number, bi: number,
  ): void {
    const slot = this.candidateScratch[index];
    if (slot === undefined) {
      this.candidateScratch.push({ ai, bi, response: null, evaluated: false, resolved: false });
    } else {
      slot.ai = ai;
      slot.bi = bi;
      slot.response = null;
      slot.evaluated = false;
      slot.resolved = false;
    }
  }

  // 未解決の候補のうち TOI が最小のものを返す(接触するものが無ければ null)。
  // 候補の response はここで初めて遅延評価(または状態変更時に再評価)する。
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
      const { ai, bi } = candidate;

      // まだ幾何評価を行っていないか、直前の解決で状態が変わった当事者を含む候補は計算する
      if (!candidate.evaluated || ai === dirtyA || ai === dirtyB || bi === dirtyA || bi === dirtyB) {
        candidate.response = entityContactResponse(all[ai]!, working[ai]!, all[bi]!, working[bi]!);
        candidate.evaluated = true;
      }

      const response = candidate.response;
      if (response !== null && (best === null || response.toi < best.response!.toi)) best = candidate;
    }
    return best;
  }

  // 候補を1件解決する。working 上の状態を補正後の値へ差し替え、反発が起きたら両者へ
  // collideWithEntity を呼ぶ。
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

    // 弾は物体へ命中した時点で消滅し、相手を押し出す剛体反発は起こさない(SPEC/COMBAT.md「弾の飛翔と寿命」)。
    // 相手艦の速度や位置は変更せず、当事者が dirty になって後続の全候補が再評価される連鎖を防ぐ。
    const isBullet = a.contactKind === 'bullet' || b.contactKind === 'bullet';
    if (isBullet) {
      const point = response.contactPoint ?? add(response.rA, scale(response.normal, a.radius));
      const t = contactTime(a, response.toi);
      a.collideWithEntity(b, {
        t, point, normal: response.normal, selfState: aBefore, otherState: bBefore,
        selfModuleId: response.moduleIdA, otherModuleId: response.moduleIdB,
      }, services);
      b.collideWithEntity(a, {
        t, point, normal: scale(response.normal, -1), selfState: bBefore, otherState: aBefore,
        selfModuleId: response.moduleIdB, otherModuleId: response.moduleIdA,
      }, services);
      return;
    }

    replaceIfMoved(ai, { r: response.rA, v: response.vA }, working, changed);
    replaceIfMoved(bi, { r: response.rB, v: response.vB }, working, changed);
    if (!response.bounced) return;

    // 反発で失われた力学エネルギーは熱になる。物理なので、当事者の反応より先にここで当てる。
    a.absorbHeat(response.specificEnergyLossA);
    b.absorbHeat(response.specificEnergyLossB);

    const point = response.contactPoint ?? add(response.rA, scale(response.normal, a.radius));
    const t = contactTime(a, response.toi);
    a.collideWithEntity(b, {
      t, point, normal: response.normal, selfState: aBefore, otherState: bBefore,
      selfModuleId: response.moduleIdA, otherModuleId: response.moduleIdB,
    }, services);
    b.collideWithEntity(a, {
      t, point, normal: scale(response.normal, -1), selfState: bBefore, otherState: aBefore,
      selfModuleId: response.moduleIdB, otherModuleId: response.moduleIdA,
    }, services);
  }
}
