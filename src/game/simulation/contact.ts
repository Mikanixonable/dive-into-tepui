// 剛体球どうしの接触の列挙・解決。collides を立てた GameEntity と、逆質量0(無限質量)の
// 天体を参加者とし、双方へ collideWith を呼ぶ — ダメージ・音・エフェクトはここでは一切扱わない
// (それぞれの GameEntity 自身の責務)。1 substep 内の接触は TOI(接触時刻)昇順で解決し、
// 解決するたびに残りの候補の TOI を引き直す。
import * as C from '../const';
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { Vec3, add, len, scale, sub } from '../../physics/vec3';
import { SpatialGrid } from '../../physics/spatial-grid';
import { GameEntity } from '../game-entity/game-entity';
import type { Player } from '../player/player';
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

// 位置・速度・半径・質量がすべて有限で、質量が正であるか。1つでも欠けたエンティティを
// 空間グリッドへ入れる前に落とす — 非有限座標はセル添字自体を壊す。
function isFiniteParticipant(e: GameEntity): boolean {
  const { r, v } = e.state;
  return Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z)
    && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
    && Number.isFinite(e.radius) && Number.isFinite(e.mass) && e.mass > 0;
}

// 位置・速度・半径が有限か。
function isFiniteAttractor(a: Attractor): boolean {
  const { r, v } = a.state;
  return Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z)
    && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
    && Number.isFinite(a.radius);
}

interface Candidate {
  a: GameEntity;
  b: GameEntity | Attractor;
  response: CollisionResponse;
}

// TOI(response.toi、prevState→state 区間内の割合)を接触時刻へ変換する。重なりフォールバック
// では toi=1(区間終端)なので、その場合は state.t にそのまま一致する。
function contactTime(a: GameEntity, toi: number): number {
  return a.prevState.t + (a.state.t - a.prevState.t) * toi;
}

// working 上の現在位置どうしの剛体接触を解決する。
function computeEntityResponse(
  a: GameEntity, b: GameEntity, working: ReadonlyMap<GameEntity, KinematicState>,
): CollisionResponse | null {
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

// エンティティ↔エンティティ・エンティティ↔天体どちらのペアも表せる、順序に依らないキー。
function pairKey(a: GameEntity, b: GameEntity | Attractor): string {
  return a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
}

// 27近傍グリッドのセル一辺。重なり判定(半径和)と区間移動量、双方が拾いうる最大距離の
// 2倍ずつを足した値にする — これ以上離れた27近傍の外のペアは、どちらの判定式でも接触しえない。
function contactCellSize(all: readonly GameEntity[], working: ReadonlyMap<GameEntity, KinematicState>): number {
  let maxRadius = 0;
  let maxMove = 0;
  for (const e of all) {
    if (e.radius > maxRadius) maxRadius = e.radius;
    const move = len(sub(working.get(e)!.r, e.prevState.r));
    if (move > maxMove) maxMove = move;
  }
  return 2 * (maxRadius + maxMove) || C.CONTACT_GRID_CELL_SIZE_FLOOR;
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
  private readonly resolvedPairsScratch = new Set<string>();
  private readonly neighborScratch: number[] = [];
  private readonly gridScratch = new SpatialGrid<number>(1);
  private candidateScratch: Candidate | null = null;

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
    player: Player,
    entities: GameEntity[],
    attractors: readonly Attractor[],
    activeStage: Stage,
  ): void {
    if (!player.alive || dt <= 1e-6) return;
    this.beltParticipantScratch.length = 0;
    for (const section of player.belt.collisionSections(dt, player.state.r, player.state.v, player.att)) {
      if (isFiniteParticipant(section)) this.beltParticipantScratch.push(section);
    }
    this.collectParticipants(entities, this.otherScratch);
    this.collectAttractors(attractors, this.bodyScratch);
    this.resolveInOrder(this.beltParticipantScratch, this.otherScratch, this.bodyScratch, simTime, activeStage);
    player.belt.applyCollisionSections(dt, player.state.r, player.state.v, player.att);
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

  // attackers 同士・attackers×others・attackers×bodies の接触候補から TOI が最小のものを
  // 1つずつ解決する。解決するたびに、まだ解決していない候補だけを対象に TOI を引き直すので、
  // 順序は接触の発生時刻どおりになり、解決済みのペアが再選択されて反復を浪費することもない。
  // 上限回数を超えた分は次回の呼び出し(次の substep / 次のフレーム)へ持ち越す。
  // グリッドは反復間で使い回す — 1件の解決で動く距離はセルサイズの余裕(半径和+区間移動量)
  // 以下なので、初回に組んだグリッドのまま近傍探索を続けてよい。
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
    const resolvedPairs = this.resolvedPairsScratch;
    resolvedPairs.clear();

    const cellSize = contactCellSize(all, working);
    const grid = this.gridScratch;
    grid.reset(cellSize);
    for (let k = 0; k < all.length; k++) grid.insert(k, working.get(all[k]!)!.r);

    for (let i = 0; i < C.CONTACT_MAX_RESOLUTIONS_PER_SUBSTEP; i++) {
      const best = this.earliestContact(all, attackerSet, attackers, bodies, simTime, working, grid, resolvedPairs);
      if (best === null) break;
      this.applyCandidate(best, working, changed, activeStage);
      resolvedPairs.add(pairKey(best.a, best.b));
    }
    for (const e of changed) e.state = working.get(e)!;
    working.clear();
    changed.clear();
    resolvedPairs.clear();
    attackerSet.clear();
  }

  // grid の27近傍から、少なくとも一方が attackerSet に属し、まだ resolvedPairs に無いペアと
  // attackers×bodies の接触候補を集め、TOI が最小のものを返す(無ければ null)。
  private earliestContact(
    all: readonly GameEntity[],
    attackerSet: ReadonlySet<GameEntity>,
    attackers: readonly GameEntity[],
    bodies: readonly Attractor[],
    simTime: number,
    working: ReadonlyMap<GameEntity, KinematicState>,
    grid: SpatialGrid<number>,
    resolvedPairs: ReadonlySet<string>,
  ): Candidate | null {
    let best: Candidate | null = null;

    const n = all.length;
    for (let i = 0; i < n; i++) {
      const a = all[i]!;
      for (const j of grid.neighborsInto(working.get(a)!.r, this.neighborScratch)) {
        // j<=i は、(j,i) 側の反復で同じペアを二重に検討しないためのガード(自分自身も除く)。
        if (j <= i) continue;
        const b = all[j]!;
        if (!attackerSet.has(a) && !attackerSet.has(b)) continue;
        if (resolvedPairs.has(pairKey(a, b))) continue;
        if (!a.contactsWith(b, simTime) || !b.contactsWith(a, simTime)) continue;
        const response = computeEntityResponse(a, b, working);
        if (response !== null && (best === null || response.toi < best.response.toi)) {
          best = this.setCandidate(a, b, response);
        }
      }
    }

    for (const a of attackers) {
      for (const body of bodies) {
        if (resolvedPairs.has(pairKey(a, body))) continue;
        if (!a.contactsWith(body, simTime)) continue;
        const response = computeAttractorResponse(a, body, working);
        if (response !== null && (best === null || response.toi < best.response.toi)) {
          best = this.setCandidate(a, body, response);
        }
      }
    }
    return best;
  }

  private setCandidate(a: GameEntity, b: GameEntity | Attractor, response: CollisionResponse): Candidate {
    if (this.candidateScratch === null) this.candidateScratch = { a, b, response };
    else {
      this.candidateScratch.a = a;
      this.candidateScratch.b = b;
      this.candidateScratch.response = response;
    }
    return this.candidateScratch;
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
    const { a, b, response } = candidate;
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
