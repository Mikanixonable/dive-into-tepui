// 物体どうしの剛体接触の列挙・解決。交戦圏ごとに、その内側で collides を立てた DynamicEntity
// どうしを参加者とし、反発が起きた当事者へ collideWithEntity を呼ぶ。ダメージ・音・エフェクトは
// それぞれの DynamicEntity 自身の責務。1 substep 内の接触は TOI(接触時刻)昇順で解決する —
// 参加者は互いの状態を書き換えるので、天体との接触(surface-contact-physics.ts)と違って作業列と
// 解決回数の上限が要る。
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { Vec3, add, scale, sameVec } from '../../math/vec3';
import { HierarchicalSpatialGrid } from '../../math/hierarchical-spatial-grid';
import { DynamicEntity } from './dynamic-entity/dynamic-entity';
import type { EngagementZone } from './engagement-zone';
import type { CollisionResponse } from '../../physics/collision-response';
import { contactTime, isFiniteParticipant } from './contact-participant';
import { entityContactResponse } from './entity-contact-response';
import type { StageOutcome } from '../stages/stage-outcome';
import type { EntityRegistry } from './entity-registry';

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

// 位置と速度がどちらも動いていない当事者は、working も changed も触らない。書き戻しは
// 予測弧を捨てるので、質量 0 の相手に触れられただけの艦がそれで作り直しになるのを防ぐ。
// changed へ重複を積まないのも同じ理由 — state セッタが prevState を進めるので、
// 1つの当事者への書き戻しは substep 内で1回に限る。
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
function contactReach(entity: DynamicEntity, working: KinematicState, reference: Vec3): number {
  const w = working.r, p = entity.prevState.r;
  const dx = w.x - p.x - reference.x, dy = w.y - p.y - reference.y, dz = w.z - p.z - reference.z;
  return entity.radius + Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export class EntityContactPhysics {
  // 接触解決は Simulator の substep ごとに同期的に完了するため、入力の抽出・作業集合を
  // インスタンス単位で再利用できる。配列の詰め直しは元の配列走査順をそのまま保つ。
  private readonly participantScratch: DynamicEntity[] = [];
  private readonly workingScratch: KinematicState[] = [];
  private readonly changedScratch: number[] = [];
  private readonly pairScratch: number[] = [];
  private readonly gridScratch = new HierarchicalSpatialGrid<number>(CONTACT_GRID_MIN_CELL_SIZE);
  private readonly candidateScratch: Candidate[] = [];
  // 負荷確認ウィンドウが読む、列挙した延べ候補ペア数。フレーム頭で Simulator が 0 へ戻す。
  public candidatePairs = 0;
  // 負荷確認ウィンドウが読む、交戦圏ごとの参加者数の延べ数。フレーム頭で Simulator が 0 へ戻す。
  public participants = 0;

  // 交戦圏ごとに、その内側にいる参加者どうしの 1 substep ぶんの接触を解く。交戦圏どうしは
  // 独立した系なので、解決回数の上限も交戦圏ごとに掛かる。
  public resolveEntityContacts(
    simTime: number, entities: readonly DynamicEntity[],
    zones: readonly EngagementZone<DynamicEntity>[], activeStage: StageOutcome, registry: EntityRegistry,
  ): void {
    for (const zone of zones) {
      this.collectParticipants(entities, zone, this.participantScratch);
      this.participants += this.participantScratch.length;
      this.resolveInOrder(
        this.participantScratch, simTime, zone.referenceDisplacement, activeStage, registry);
    }
  }

  // 交戦圏の内側にいて接触を解ける個体だけを out へ詰め直す。out の元の中身は捨てる。
  private collectParticipants(
    source: readonly DynamicEntity[], zone: EngagementZone<DynamicEntity>, out: DynamicEntity[],
  ): void {
    out.length = 0;
    for (const entity of source) {
      if (!entity.alive || !entity.collides || !isFiniteParticipant(entity)) continue;
      if (zone.contains(entity.state.r)) out.push(entity);
    }
  }

  // 参加者どうしの接触候補を1回だけ列挙し、TOI が最小のものから1件ずつ解決する。上限回数を
  // 超えた分は次の substep へ持ち越す。
  // DynamicEntity.state への書き戻しは全解決が終わってから一括で行う — ループの途中で書き戻すと
  // state セッタ自身が prevState を書き換えてしまい、以降の反復が区間の始点を失う。
  private resolveInOrder(
    all: readonly DynamicEntity[],
    simTime: number,
    reference: Vec3,
    activeStage: StageOutcome,
    registry: EntityRegistry,
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
      this.applyCandidate(best, all, working, changed, activeStage, registry);
      best.resolved = true;
      dirtyA = best.ai;
      dirtyB = best.bi;
    }
    for (const i of changed) all[i]!.state = working[i]!;
    // 使わなかった末尾を落とす — 候補は反発の計算結果を抱えるので、残すと使われない
    // CollisionResponse が候補列の中だけ生き続ける。
    this.candidateScratch.length = count;
  }

  // 参加者を到達量つきでグリッドへ登録し直す。接触の成否を決めるのは参加者どうしの相対変位なので、
  // 到達量は交戦圏の基準変位 reference を差し引いた量で測る。
  private insertParticipants(
    all: readonly DynamicEntity[], working: readonly KinematicState[], reference: Vec3,
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
    all: readonly DynamicEntity[],
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

  // 未解決の候補のうち TOI が最小のものを返す(接触するものが無ければ null)。dirtyA/dirtyB を
  // 当事者に含む候補は、走査のついでに現在の working 上の値で response を引き直す。
  private earliestContact(
    count: number,
    dirtyA: number,
    dirtyB: number,
    all: readonly DynamicEntity[],
    working: readonly KinematicState[],
  ): Candidate | null {
    let best: Candidate | null = null;
    for (let i = 0; i < count; i++) {
      const candidate = this.candidateScratch[i]!;
      if (candidate.resolved) continue;
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
    all: readonly DynamicEntity[],
    working: KinematicState[],
    changed: number[],
    activeStage: StageOutcome,
    registry: EntityRegistry,
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
    }, activeStage, registry);
    b.collideWithEntity(a, {
      t, point, normal: scale(response.normal, -1), selfState: bBefore, otherState: aBefore,
    }, activeStage, registry);
  }
}
