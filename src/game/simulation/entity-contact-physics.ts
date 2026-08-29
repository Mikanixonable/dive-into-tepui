// 物体どうしの剛体接触の列挙・解決。collides を立てた DynamicEntity どうしを参加者とし、反発が
// 起きた当事者へ collideWithEntity を呼ぶ。ダメージ・音・エフェクトはそれぞれの DynamicEntity
// 自身の責務。1 substep 内の接触は TOI(接触時刻)昇順で解決する — 参加者は互いの状態を
// 書き換えるので、天体との接触(surface-contact-physics.ts)と違って作業マップと解決回数の
// 上限が要る。
import * as C from '../const';
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { Vec3, add, scale, sameVec } from '../../math/vec3';
import { SpatialGrid } from '../../math/spatial-grid';
import { DynamicEntity } from '../dynamic/dynamic-entity/dynamic-entity';
import type { Player } from '../player/player';
import type { CollisionResponse } from '../../physics/collision-response';
import { contactTime, isFiniteParticipant } from './contact-participant';
import { entityContactResponse } from './entity-contact-response';
import type { Stage } from '../stages/stage';

// 1 substep あたりに解決する接触の上限。TOI(接触時刻)昇順で解決し、これを超えた分は
// 次の substep へ持ち越す(次回呼び出し時に空間グリッドから改めて列挙し直されるので、
// 明示的な繰越処理は不要)。
const CONTACT_MAX_RESOLUTIONS_PER_SUBSTEP = 8;

// 1 substep 分の接触候補1件。response が null なのは現在の状態では接触しないという意味で、
// 当事者の状態が変われば非 null になりうる。resolved を立てた候補は以後選ばれない。
interface Candidate {
  a: DynamicEntity;
  b: DynamicEntity;
  response: CollisionResponse | null;
  resolved: boolean;
}

// 位置と速度がどちらも動いていない当事者は、working も changed も触らない。書き戻しは
// 予測弧を捨てるので、質量 0 の相手に触れられただけの艦がそれで作り直しになるのを防ぐ。
function replaceIfMoved(
  e: DynamicEntity,
  before: KinematicState,
  after: { readonly r: Vec3; readonly v: Vec3 },
  working: Map<DynamicEntity, KinematicState>,
  changed: Set<DynamicEntity>,
): void {
  if (sameVec(before.r, after.r) && sameVec(before.v, after.v)) return;
  working.set(e, kinematicState(e.state.t, after.r, after.v));
  changed.add(e);
}

// 27近傍グリッドのセル一辺。接触の成否を決めるのは参加者どうしの相対変位なので、参加者集合に
// 共通する変位(平均 Δ̄)を差し引いた量で測る。ペア (a,b) が区間内で接触するなら、区間終端の
// 距離は 半径和 + |Δa−Δ̄| + |Δb−Δ̄| 以下 — つまり各参加者の到達量 半径+|Δ−Δ̄| の最大値の2倍を
// 一辺に取れば、27近傍の外のペアはどちらの判定式でも接触しえない。
function contactCellSize(all: readonly DynamicEntity[], working: ReadonlyMap<DynamicEntity, KinematicState>): number {
  let mx = 0, my = 0, mz = 0;
  for (const e of all) {
    const w = working.get(e)!.r, p = e.prevState.r;
    mx += w.x - p.x; my += w.y - p.y; mz += w.z - p.z;
  }
  const n = all.length;
  mx /= n; my /= n; mz /= n;

  let maxReach = 0;
  for (const e of all) {
    const w = working.get(e)!.r, p = e.prevState.r;
    const dx = w.x - p.x - mx, dy = w.y - p.y - my, dz = w.z - p.z - mz;
    const reach = e.radius + Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (reach > maxReach) maxReach = reach;
  }
  return 2 * maxReach || C.CONTACT_GRID_CELL_SIZE_FLOOR;
}

export class EntityContactPhysics {
  // 接触解決は Simulator の substep ごとに同期的に完了するため、入力の抽出・作業集合を
  // インスタンス単位で再利用できる。配列の詰め直しは元の配列走査順をそのまま保つ。
  private readonly participantScratch: DynamicEntity[] = [];
  private readonly beltParticipantScratch: DynamicEntity[] = [];
  private readonly otherScratch: DynamicEntity[] = [];
  private readonly allScratch: DynamicEntity[] = [];
  private readonly attackerSetScratch = new Set<DynamicEntity>();
  private readonly workingScratch = new Map<DynamicEntity, KinematicState>();
  private readonly changedScratch = new Set<DynamicEntity>();
  private readonly neighborScratch: number[] = [];
  private readonly gridScratch = new SpatialGrid<number>(1);
  private readonly candidateScratch: Candidate[] = [];

  // 1 substep ぶんの物体どうしの接触解決。ワープ倍率によるゲートは呼び出し側の判断で、
  // ここには倍率を見る条件を持たない。
  resolveEntityContacts(simTime: number, entities: DynamicEntity[], activeStage: Stage): void {
    this.collectParticipants(entities, this.participantScratch);
    this.resolveInOrder(this.participantScratch, [], simTime, activeStage);
  }

  // ベルトは実dtで解く艦にくっついた局所シミュレーションなので、substepループの外で
  // フレームに1回だけ解決する。
  resolveBelt(
    dt: number,
    simTime: number,
    player: Player,
    entities: DynamicEntity[],
    activeStage: Stage,
  ): void {
    if (!player.alive || dt <= 1e-6) return;
    this.beltParticipantScratch.length = 0;
    for (const section of player.belt.collisionSections(dt, player.state.r, player.state.v, player.att)) {
      if (isFiniteParticipant(section)) this.beltParticipantScratch.push(section);
    }
    this.collectParticipants(entities, this.otherScratch);
    this.resolveInOrder(this.beltParticipantScratch, this.otherScratch, simTime, activeStage);
    player.belt.applyCollisionSections(dt, player.state.r, player.state.v, player.att);
  }

  private collectParticipants(source: readonly DynamicEntity[], out: DynamicEntity[]): void {
    out.length = 0;
    for (const entity of source) {
      if (entity.alive && entity.collides && isFiniteParticipant(entity)) out.push(entity);
    }
  }

  // attackers 同士・attackers×others の接触候補を1回だけ列挙し、TOI が最小のものから1件ずつ
  // 解決する。上限回数を超えた分は次回の呼び出し(次の substep / 次のフレーム)へ持ち越す。
  // DynamicEntity.state への書き戻しは全解決が終わってから一括で行う — ループの途中で書き戻すと
  // state セッタ自身が prevState を書き換えてしまい、以降の反復が区間の始点を失う。
  private resolveInOrder(
    attackers: readonly DynamicEntity[],
    others: readonly DynamicEntity[],
    simTime: number,
    activeStage: Stage,
  ): void {
    if (attackers.length === 0) return;
    // ベルト解決のように others がある場合だけ結合配列を使う。通常の substep では
    // attackers 自身をそのまま使い、余分なコピーと走査を発生させない。
    const all = others.length === 0 ? attackers : this.allScratch;
    if (others.length !== 0) {
      this.allScratch.length = 0;
      this.allScratch.push(...attackers, ...others);
    }
    const attackerSet = this.attackerSetScratch;
    attackerSet.clear();
    for (const attacker of attackers) attackerSet.add(attacker);
    const working = this.workingScratch;
    working.clear();
    for (const e of all) working.set(e, e.state);
    const changed = this.changedScratch;
    changed.clear();

    const cellSize = contactCellSize(all, working);
    const grid = this.gridScratch;
    grid.reset(cellSize);
    for (let k = 0; k < all.length; k++) grid.insert(k, working.get(all[k]!)!.r);

    const count = this.collectCandidates(all, attackerSet, simTime, working, grid);
    // 直前の解決で状態が変わった当事者。これを含まない候補の response は引き直しても同じ値に
    // なるので、含む候補だけを引き直す。
    let dirtyA: DynamicEntity | null = null;
    let dirtyB: DynamicEntity | null = null;
    for (let i = 0; i < CONTACT_MAX_RESOLUTIONS_PER_SUBSTEP; i++) {
      const best = this.earliestContact(count, dirtyA, dirtyB, working);
      if (best === null) break;
      this.applyCandidate(best, working, changed, activeStage);
      best.resolved = true;
      dirtyA = best.a;
      dirtyB = best.b;
    }
    for (const e of changed) e.state = working.get(e)!;
    working.clear();
    changed.clear();
    attackerSet.clear();
    // 使わなかった末尾を落とす — 候補は当事者を参照で抱えるので、残すと消えたエンティティが
    // 候補列の中だけ生き続ける。
    this.candidateScratch.length = count;
  }

  // grid の27近傍から、少なくとも一方が attackerSet に属するペアを集め、contactsWith を
  // 通ったものだけを候補列へ詰め直して件数を返す。接触しない組み合わせも response=null の
  // 候補として残す — 当事者の状態が変われば接触しうるため。
  private collectCandidates(
    all: readonly DynamicEntity[],
    attackerSet: ReadonlySet<DynamicEntity>,
    simTime: number,
    working: ReadonlyMap<DynamicEntity, KinematicState>,
    grid: SpatialGrid<number>,
  ): number {
    let count = 0;
    const n = all.length;
    for (let i = 0; i < n; i++) {
      const a = all[i]!;
      for (const j of grid.neighborsInto(working.get(a)!.r, this.neighborScratch)) {
        // j<=i は、(j,i) 側の反復で同じペアを二重に検討しないためのガード(自分自身も除く)。
        if (j <= i) continue;
        const b = all[j]!;
        if (!attackerSet.has(a) && !attackerSet.has(b)) continue;
        if (!a.contactsWith(b, simTime) || !b.contactsWith(a, simTime)) continue;
        this.pushCandidate(
          count++, a, b, entityContactResponse(a, working.get(a)!, b, working.get(b)!));
      }
    }

    return count;
  }

  // 候補列の index 番目を書き直す。既にあるスロットはオブジェクトごと使い回す。
  private pushCandidate(
    index: number, a: DynamicEntity, b: DynamicEntity, response: CollisionResponse | null,
  ): void {
    const slot = this.candidateScratch[index];
    if (slot === undefined) this.candidateScratch.push({ a, b, response, resolved: false });
    else {
      slot.a = a;
      slot.b = b;
      slot.response = response;
      slot.resolved = false;
    }
  }

  // 未解決の候補のうち TOI が最小のものを返す(接触するものが無ければ null)。dirtyA/dirtyB を
  // 当事者に含む候補は、走査のついでに現在の working 上の値で response を引き直す。
  private earliestContact(
    count: number,
    dirtyA: DynamicEntity | null,
    dirtyB: DynamicEntity | null,
    working: ReadonlyMap<DynamicEntity, KinematicState>,
  ): Candidate | null {
    let best: Candidate | null = null;
    for (let i = 0; i < count; i++) {
      const candidate = this.candidateScratch[i]!;
      if (candidate.resolved) continue;
      const { a, b } = candidate;
      if (a === dirtyA || a === dirtyB || b === dirtyA || b === dirtyB) {
        candidate.response = entityContactResponse(a, working.get(a)!, b, working.get(b)!);
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
    working: Map<DynamicEntity, KinematicState>,
    changed: Set<DynamicEntity>,
    activeStage: Stage,
  ): void {
    const { a, b } = candidate;
    const response = candidate.response!;
    const aBefore = working.get(a)!;
    const bBefore = working.get(b)!;
    replaceIfMoved(a, aBefore, { r: response.rA, v: response.vA }, working, changed);
    replaceIfMoved(b, bBefore, { r: response.rB, v: response.vB }, working, changed);
    if (!response.bounced) return;

    // 反発で失われた力学エネルギーは熱になる。当事者の判断ではなく物理なので、ダメージや
    // 効果音を委ねる前にここで当てる。
    a.absorbHeat(response.specificEnergyLossA);
    b.absorbHeat(response.specificEnergyLossB);

    const point = response.contactPoint ?? add(response.rA, scale(response.normal, a.radius));
    const t = contactTime(a, response.toi);
    a.collideWithEntity(b, {
      t, point, normal: response.normal, selfState: aBefore, otherState: bBefore,
    }, activeStage);
    b.collideWithEntity(a, {
      t, point, normal: scale(response.normal, -1), selfState: bBefore, otherState: aBefore,
    }, activeStage);
  }
}
