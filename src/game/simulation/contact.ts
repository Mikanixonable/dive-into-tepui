// 剛体球どうしの接触の列挙・解決。collides を立てた GameEntity と、逆質量0(無限質量)の
// 天体を参加者とし、双方へ collideWith を呼ぶ — ダメージ・音・エフェクトはここでは一切扱わない
// (それぞれの GameEntity 自身の責務)。1 substep 内の接触は TOI(接触時刻)昇順で解決する。
import * as C from '../const';
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { Vec3, add, sub, scale, dot, len } from '../../physics/vec3';
import { SpatialGrid } from '../../physics/spatial-grid';
import { GameEntity } from '../game-entity/game-entity';
import { Vessel } from '../vessel/vessel';
import { CollisionResponse, resolveSphereCollision } from '../../physics/collision-response';
import type { Attractor } from '../../physics/attractor';
import type { Stage } from '../stages/stage';

// 1回の接触を、受け手から見た形で記述する。self/other は受け手ごとに入れ替えて組み直す
// (normal も向きが反転する)ので、同じ解決結果から自分用と相手用の2つを作る。
export interface Contact {
  readonly t: number; // 接触時刻 [sim s]
  readonly point: Vec3; // 接触点(ECI)
  readonly normal: Vec3; // self → other 向きの単位法線
  readonly selfState: KinematicState; // 接触直前(反応前)の自分
  readonly otherState: KinematicState; // 接触直前(反応前)の相手
  readonly impulse: number; // 剛体解決で生じた力積の大きさ [N·s]。離反中なら 0
}

const RESTITUTION = 0.4;

// 区間の両端の位置・速度と半径・質量がすべて有限で、質量が正であるか。1つでも欠けた
// エンティティを空間グリッドへ入れる前に落とす — 非有限座標はセル添字を壊し、区間変位は
// セル一辺の算出を通じて全参加者へ伝播する。
function isFiniteParticipant(e: GameEntity): boolean {
  const { r, v } = e.state;
  const p = e.prevState.r;
  return Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z)
    && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
    && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)
    && Number.isFinite(e.radius) && Number.isFinite(e.mass) && e.mass > 0;
}

// 位置・速度・半径が有限か。
function isFiniteAttractor(a: Attractor): boolean {
  const { r, v } = a.state;
  return Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z)
    && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
    && Number.isFinite(a.radius);
}

// 1 substep 分の接触候補1件。response が null なのは現在の状態では接触しないという意味で、
// 当事者の状態が変われば非 null になりうる。resolved を立てた候補は以後選ばれない。
interface Candidate {
  a: GameEntity;
  b: GameEntity | Attractor;
  response: CollisionResponse | null;
  resolved: boolean;
}

// TOI(response.toi、prevState→state 区間内の割合)を接触時刻へ変換する。重なりフォールバック
// では toi=1(区間終端)なので、その場合は state.t にそのまま一致する。
function contactTime(a: GameEntity, toi: number): number {
  return a.prevState.t + (a.state.t - a.prevState.t) * toi;
}

// working 上の現在位置どうしの剛体接触を解決する。
function computeEntityResponse(
  a: GameEntity, b: GameEntity, working: ReadonlyMap<GameEntity, KinematicState>, warpLevel = 1,
): CollisionResponse | null {
  // 接触形状を持つ機体(基地モジュールを積んだもの)だけが、球ではなく自前の形状で判定される。
  const base = a instanceof Vessel && a.collisionGeom ? a : (b instanceof Vessel && b.collisionGeom ? b : null);
  if (base) {
    const other = a === base ? b : a;
    const isA = a === base;
    const baseWork = working.get(base)!;
    const otherWork = working.get(other)!;

    const dist = len(sub(otherWork.r, baseWork.r));
    if (dist > base.radius + other.radius) return null;

    const hit = base.testSphereCollision(otherWork.r, other.radius, warpLevel);
    if (!hit) return null;

    const normal = isA ? hit.normal : scale(hit.normal, -1);
    const relV = sub(otherWork.v, baseWork.v);
    const vn = dot(relV, hit.normal);

    const invM = 1 / other.mass;
    let impulse = 0;
    let newOtherV = otherWork.v;

    if (vn < 0) {
      impulse = -(1 + RESTITUTION) * vn / invM;
      const impulseVec = scale(hit.normal, impulse);
      newOtherV = add(otherWork.v, scale(impulseVec, invM));
    }

    const pushOut = scale(hit.normal, hit.depth);
    const newOtherR = add(otherWork.r, pushOut);

    return {
      rA: isA ? baseWork.r : newOtherR,
      rB: isA ? newOtherR : baseWork.r,
      vA: isA ? baseWork.v : newOtherV,
      vB: isA ? newOtherV : baseWork.v,
      normal,
      impulse,
      toi: 1,
    };
  }

  const aWork = working.get(a)!, bWork = working.get(b)!;
  // 両者の prevState→state が同じ区間(時刻がほぼ一致)を成すときだけ掃引TOIを試す —
  // ずれていれば異なる瞬間の直前位置を結ぶ線分になり、掃引の意味を失う。
  const sweptValid = a.prevState.t < a.state.t && b.prevState.t < b.state.t
    && Math.abs(a.prevState.t - b.prevState.t) <= 1e-6 && Math.abs(a.state.t - b.state.t) <= 1e-6;
  return resolveSphereCollision(
    { r: aWork.r, v: aWork.v, radius: a.radius, invMass: 1 / a.mass },
    { r: bWork.r, v: bWork.v, radius: b.radius, invMass: 1 / b.mass },
    RESTITUTION,
    sweptValid ? a.prevState.r : undefined,
    sweptValid ? b.prevState.r : undefined,
  );
}

// 天体はこの関数の呼び出し区間の間ほぼ静止しているとみなす(軌道運動は1 substep で
// たかだか数十m)ので、掃引の直前位置には現在位置をそのまま使う。
function computeAttractorResponse(
  e: GameEntity, body: Attractor, working: ReadonlyMap<GameEntity, KinematicState>,
): CollisionResponse | null {
  const eWork = working.get(e)!;
  const sweptValid = e.prevState.t < e.state.t;
  return resolveSphereCollision(
    { r: eWork.r, v: eWork.v, radius: e.radius, invMass: 1 / e.mass },
    { r: body.state.r, v: body.state.v, radius: body.radius, invMass: 0 },
    RESTITUTION,
    sweptValid ? e.prevState.r : undefined,
    sweptValid ? body.state.r : undefined,
  );
}

// 27近傍グリッドのセル一辺。接触の成否を決めるのは参加者どうしの相対変位なので、参加者集合に
// 共通する変位(平均 Δ̄)を差し引いた量で測る。ペア (a,b) が区間内で接触するなら、区間終端の
// 距離は 半径和 + |Δa−Δ̄| + |Δb−Δ̄| 以下 — つまり各参加者の到達量 半径+|Δ−Δ̄| の最大値の2倍を
// 一辺に取れば、27近傍の外のペアはどちらの判定式でも接触しえない。
function contactCellSize(all: readonly GameEntity[], working: ReadonlyMap<GameEntity, KinematicState>): number {
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

export class ContactPhysics {
  // 接触解決は Simulator の substep ごとに同期的に完了するため、入力の抽出・作業集合を
  // ContactPhysics 単位で再利用できる。配列の詰め直しは元の配列走査順をそのまま保つ。
  private readonly participantScratch: GameEntity[] = [];
  private readonly beltParticipantScratch: GameEntity[] = [];
  private readonly otherScratch: GameEntity[] = [];
  private readonly bodyScratch: Attractor[] = [];
  private readonly allScratch: GameEntity[] = [];
  private readonly attackerSetScratch = new Set<GameEntity>();
  private readonly workingScratch = new Map<GameEntity, KinematicState>();
  private readonly changedScratch = new Set<GameEntity>();
  private readonly neighborScratch: number[] = [];
  private readonly gridScratch = new SpatialGrid<number>(1);
  private readonly candidateScratch: Candidate[] = [];

  // 1 substep ぶんの接触解決。ワープゲート(canResolvePhysicalCollisions)は呼び出し側
  // (Simulator.advance)が判断してから呼ぶ。
  resolveSubstep(
    simTime: number,
    entities: GameEntity[],
    attractors: readonly Attractor[],
    activeStage: Stage,
  ): void {
    this.collectParticipants(entities, this.participantScratch);
    this.collectAttractors(attractors, this.bodyScratch);
    this.resolveInOrder(this.participantScratch, [], this.bodyScratch, simTime, activeStage);
  }

  // ベルトは実dtで解く艦にくっついた局所シミュレーションなので、substepループの外で
  // フレームに1回だけ解決する。
  resolveBelt(
    dt: number,
    simTime: number,
    player: Vessel,
    entities: GameEntity[],
    attractors: readonly Attractor[],
    activeStage: Stage,
  ): void {
    if (!player.alive || dt <= 1e-6) return;
    this.beltParticipantScratch.length = 0;
    for (const section of player.belt!.collisionSections(dt, player.state.r, player.state.v, player.att)) {
      if (isFiniteParticipant(section)) this.beltParticipantScratch.push(section);
    }
    this.collectParticipants(entities, this.otherScratch);
    this.collectAttractors(attractors, this.bodyScratch);
    this.resolveInOrder(this.beltParticipantScratch, this.otherScratch, this.bodyScratch, simTime, activeStage);
    player.belt!.applyCollisionSections(dt, player.state.r, player.state.v, player.att);
  }

  private collectParticipants(source: readonly GameEntity[], out: GameEntity[]): void {
    out.length = 0;
    for (const entity of source) {
      if (entity.alive && entity.collides && isFiniteParticipant(entity)) out.push(entity);
    }
  }

  private collectAttractors(source: readonly Attractor[], out: Attractor[]): void {
    out.length = 0;
    for (const attractor of source) {
      if (isFiniteAttractor(attractor)) out.push(attractor);
    }
  }

  // attackers 同士・attackers×others・attackers×bodies の接触候補を1回だけ列挙し、TOI が
  // 最小のものから1件ずつ解決する。上限回数を超えた分は次回の呼び出し(次の substep /
  // 次のフレーム)へ持ち越す。
  // GameEntity.state への書き戻しは全解決が終わってから一括で行う — ループの途中で書き戻すと
  // state セッタ自身が prevState を書き換えてしまい、以降の反復が区間の始点を失う。
  private resolveInOrder(
    attackers: readonly GameEntity[],
    others: readonly GameEntity[],
    bodies: readonly Attractor[],
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

    const count = this.collectCandidates(all, attackerSet, attackers, bodies, simTime, working, grid);
    // 直前の解決で状態が変わった当事者。これを含まない候補の response は引き直しても同じ値に
    // なるので、含む候補だけを引き直す。
    let dirtyA: GameEntity | null = null;
    let dirtyB: GameEntity | null = null;
    for (let i = 0; i < C.CONTACT_MAX_RESOLUTIONS_PER_SUBSTEP; i++) {
      const best = this.earliestContact(count, dirtyA, dirtyB, working);
      if (best === null) break;
      this.applyCandidate(best, working, changed, activeStage);
      best.resolved = true;
      dirtyA = best.a;
      dirtyB = best.b instanceof GameEntity ? best.b : null;
    }
    for (const e of changed) e.state = working.get(e)!;
    working.clear();
    changed.clear();
    attackerSet.clear();
    // 使わなかった末尾を落とす — 候補は当事者を参照で抱えるので、残すと消えたエンティティが
    // 候補列の中だけ生き続ける。
    this.candidateScratch.length = count;
  }

  // grid の27近傍から、少なくとも一方が attackerSet に属するペアと attackers×bodies のペアを
  // 集め、contactsWith を通ったものだけを候補列へ詰め直して件数を返す。接触しない組み合わせも
  // response=null の候補として残す — 当事者の状態が変われば接触しうるため。
  private collectCandidates(
    all: readonly GameEntity[],
    attackerSet: ReadonlySet<GameEntity>,
    attackers: readonly GameEntity[],
    bodies: readonly Attractor[],
    simTime: number,
    working: ReadonlyMap<GameEntity, KinematicState>,
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
        this.pushCandidate(count++, a, b, computeEntityResponse(a, b, working));
      }
    }

    for (const a of attackers) {
      for (const body of bodies) {
        if (!a.contactsWith(body, simTime)) continue;
        this.pushCandidate(count++, a, body, computeAttractorResponse(a, body, working));
      }
    }
    return count;
  }

  // 候補列の index 番目を書き直す。既にあるスロットはオブジェクトごと使い回す。
  private pushCandidate(
    index: number, a: GameEntity, b: GameEntity | Attractor, response: CollisionResponse | null,
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
    dirtyA: GameEntity | null,
    dirtyB: GameEntity | null,
    working: ReadonlyMap<GameEntity, KinematicState>,
  ): Candidate | null {
    let best: Candidate | null = null;
    for (let i = 0; i < count; i++) {
      const candidate = this.candidateScratch[i]!;
      if (candidate.resolved) continue;
      const { a, b } = candidate;
      if (a === dirtyA || a === dirtyB || b === dirtyA || b === dirtyB) {
        candidate.response = b instanceof GameEntity
          ? computeEntityResponse(a, b, working)
          : computeAttractorResponse(a, b, working);
      }
      const response = candidate.response;
      if (response !== null && (best === null || response.toi < best.response!.toi)) best = candidate;
    }
    return best;
  }

  // 候補を1件解決する: working 上の状態を補正後の値へ差し替え、反発が起きたときだけ両者へ
  // collideWith を順不同で呼ぶ(接触時点の値は working から取った Contact に持たせてあるので、
  // 呼び出し順に結果は依存しない)。
  private applyCandidate(
    candidate: Candidate,
    working: Map<GameEntity, KinematicState>,
    changed: Set<GameEntity>,
    activeStage: Stage,
  ): void {
    const { a, b } = candidate;
    const response = candidate.response!;
    const aBefore = working.get(a)!;
    working.set(a, kinematicState(a.state.t, response.rA, response.vA));
    changed.add(a);

    const point = add(response.rA, scale(response.normal, a.radius));
    const t = contactTime(a, response.toi);

    if (b instanceof GameEntity) {
      // 天体側(else 節)は不動なので working への書き戻し対象に含めない。
      const bBefore = working.get(b)!;
      working.set(b, kinematicState(b.state.t, response.rB, response.vB));
      changed.add(b);
      if (response.impulse === 0) return;
      a.collideWith(b, {
        t, point, normal: response.normal, selfState: aBefore, otherState: bBefore, impulse: response.impulse,
      }, activeStage);
      b.collideWith(a, {
        t, point, normal: scale(response.normal, -1), selfState: bBefore, otherState: aBefore, impulse: response.impulse,
      }, activeStage);
    } else {
      if (response.impulse === 0) return;
      a.collideWith(b, {
        t, point, normal: response.normal, selfState: aBefore, otherState: b.state, impulse: response.impulse,
      }, activeStage);
    }
  }
}
