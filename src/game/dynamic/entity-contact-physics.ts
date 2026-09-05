// 物体どうしの剛体接触の列挙・解決。collides を立てた DynamicEntity どうしを参加者とし、反発が
// 起きた当事者へ collideWithEntity を呼ぶ。ダメージ・音・エフェクトはそれぞれの DynamicEntity
// 自身の責務。1 substep 内の接触は TOI(接触時刻)昇順で解決する — 参加者は互いの状態を
// 書き換えるので、天体との接触(surface-contact-physics.ts)と違って作業列と解決回数の
// 上限が要る。
// 参加者は一貫して参加者列の添字で指す — 空間グリッドも候補もこの添字だけを持ち回る。
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { Vec3, add, scale, sameVec } from '../../math/vec3';
import { SpatialGrid } from '../../math/spatial-grid';
import { DynamicEntity } from './dynamic-entity/dynamic-entity';
import type { CollisionResponse } from '../../physics/collision-response';
import { contactTime, isFiniteParticipant } from './contact-participant';
import { entityContactResponse } from './entity-contact-response';
import type { Stage } from '../stages/stage';

// 1 substep あたりに解決する接触の上限。TOI(接触時刻)昇順で解決し、これを超えた分は
// 次の substep へ持ち越す(次回呼び出し時に空間グリッドから改めて列挙し直されるので、
// 明示的な繰越処理は不要)。
const CONTACT_MAX_RESOLUTIONS_PER_SUBSTEP = 8;

// 27近傍グリッドのセル一辺の下限 [m]。全参加者の半径も相対変位も 0 という退化ケースで
// 一辺が 0 になるのを避けるためだけの値で、そのとき接触しうる距離自体が 0 なのでどんな正数でも
// 判定は正しい。セルを細かく取っても空セルは持たない構造なので、最小の実用値として 1m を取る。
const CONTACT_GRID_CELL_SIZE_FLOOR = 1;

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
// 1つの当事者は substep 内で何度でも動きうるが、書き戻しは1回でなければならない
// (state セッタが prevState を進めるため)ので、changed には重複を入れない。
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

// 27近傍グリッドのセル一辺。接触の成否を決めるのは参加者どうしの相対変位なので、参加者集合に
// 共通する変位(平均 Δ̄)を差し引いた量で測る。ペア (a,b) が区間内で接触するなら、区間終端の
// 距離は 半径和 + |Δa−Δ̄| + |Δb−Δ̄| 以下 — つまり各参加者の到達量 半径+|Δ−Δ̄| の最大値の2倍を
// 一辺に取れば、27近傍の外のペアはどちらの判定式でも接触しえない。
function contactCellSize(all: readonly DynamicEntity[], working: readonly KinematicState[]): number {
  const n = all.length;
  let mx = 0, my = 0, mz = 0;
  for (let i = 0; i < n; i++) {
    const w = working[i]!.r, p = all[i]!.prevState.r;
    mx += w.x - p.x; my += w.y - p.y; mz += w.z - p.z;
  }
  mx /= n; my /= n; mz /= n;

  let maxReach = 0;
  for (let i = 0; i < n; i++) {
    const w = working[i]!.r, p = all[i]!.prevState.r;
    const dx = w.x - p.x - mx, dy = w.y - p.y - my, dz = w.z - p.z - mz;
    const reach = all[i]!.radius + Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (reach > maxReach) maxReach = reach;
  }
  return 2 * maxReach || CONTACT_GRID_CELL_SIZE_FLOOR;
}

export class EntityContactPhysics {
  // 接触解決は Simulator の substep ごとに同期的に完了するため、入力の抽出・作業集合を
  // インスタンス単位で再利用できる。配列の詰め直しは元の配列走査順をそのまま保つ。
  private readonly participantScratch: DynamicEntity[] = [];
  private readonly workingScratch: KinematicState[] = [];
  private readonly changedScratch: number[] = [];
  private readonly neighborScratch: number[] = [];
  private readonly gridScratch = new SpatialGrid<number>(1);
  private readonly candidateScratch: Candidate[] = [];
  // 負荷確認ウィンドウが読む、列挙した延べ候補ペア数。フレーム頭で Simulator が 0 へ戻す。
  candidatePairs = 0;

  // 1 substep ぶんの物体どうしの接触解決。ワープ倍率によるゲートは呼び出し側の判断で、
  // ここには倍率を見る条件を持たない。
  resolveEntityContacts(
    simTime: number, entities: readonly DynamicEntity[], activeStage: Stage,
  ): void {
    this.collectParticipants(entities, this.participantScratch);
    this.resolveInOrder(this.participantScratch, simTime, activeStage);
  }

  private collectParticipants(source: readonly DynamicEntity[], out: DynamicEntity[]): void {
    out.length = 0;
    for (const entity of source) {
      if (entity.alive && entity.collides && isFiniteParticipant(entity)) out.push(entity);
    }
  }

  // 参加者どうしの接触候補を1回だけ列挙し、TOI が最小のものから1件ずつ解決する。上限回数を
  // 超えた分は次の substep へ持ち越す。
  // DynamicEntity.state への書き戻しは全解決が終わってから一括で行う — ループの途中で書き戻すと
  // state セッタ自身が prevState を書き換えてしまい、以降の反復が区間の始点を失う。
  private resolveInOrder(
    all: readonly DynamicEntity[],
    simTime: number,
    activeStage: Stage,
  ): void {
    const n = all.length;
    if (n === 0) return;
    const working = this.workingScratch;
    working.length = 0;
    for (const e of all) working.push(e.state);
    const changed = this.changedScratch;
    changed.length = 0;

    const grid = this.gridScratch;
    grid.reset(contactCellSize(all, working));
    for (let k = 0; k < n; k++) grid.insert(k, working[k]!.r);

    const count = this.collectCandidates(all, simTime, working, grid);
    this.candidatePairs += count;
    // 直前の解決で状態が変わった当事者。これを含まない候補の response は引き直しても同じ値に
    // なるので、含む候補だけを引き直す。-1 は「まだ無い」。
    let dirtyA = -1;
    let dirtyB = -1;
    for (let i = 0; i < CONTACT_MAX_RESOLUTIONS_PER_SUBSTEP; i++) {
      const best = this.earliestContact(count, dirtyA, dirtyB, all, working);
      if (best === null) break;
      this.applyCandidate(best, all, working, changed, activeStage);
      best.resolved = true;
      dirtyA = best.ai;
      dirtyB = best.bi;
    }
    for (const i of changed) all[i]!.state = working[i]!;
    // 使わなかった末尾を落とす — 候補は反発の計算結果を抱えるので、残すと使われない
    // CollisionResponse が候補列の中だけ生き続ける。
    this.candidateScratch.length = count;
  }

  // grid の27近傍からペアを集め、contactsWith を通ったものだけを候補列へ詰め直して件数を返す。
  // 接触しない組み合わせも response=null の候補として残す — 当事者の状態が変われば接触しうるため。
  private collectCandidates(
    all: readonly DynamicEntity[],
    simTime: number,
    working: readonly KinematicState[],
    grid: SpatialGrid<number>,
  ): number {
    let count = 0;
    const n = all.length;
    for (let i = 0; i < n; i++) {
      const a = all[i]!;
      for (const j of grid.neighborsInto(working[i]!.r, this.neighborScratch)) {
        // j<=i は、(j,i) 側の反復で同じペアを二重に検討しないためのガード(自分自身も除く)。
        if (j <= i) continue;
        const b = all[j]!;
        if (!a.contactsWith(b, simTime) || !b.contactsWith(a, simTime)) continue;
        this.pushCandidate(
          count++, i, j, entityContactResponse(a, working[i]!, b, working[j]!));
      }
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
    activeStage: Stage,
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
    }, activeStage);
    b.collideWithEntity(a, {
      t, point, normal: scale(response.normal, -1), selfState: bBefore, otherState: aBefore,
    }, activeStage);
  }
}
