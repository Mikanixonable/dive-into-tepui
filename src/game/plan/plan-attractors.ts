// 計画軌道の積分が時刻ごとに参照する重力源・衝突体と、その解決。積分は時刻を単調に進めながら
// 1ステップにつき複数の時刻を引くので、同じ時刻への問い合わせだけを保持し、世代値が動いたら
// まとめて捨てる。保持の要否はこのモジュールの中だけで決まり、外から捨てさせることはない。
import type { Ephemeris } from '../../physics/ephemeris';
import type { Attractor, AttractorId } from '../../physics/attractor';
import { classifyAttractors } from '../simulation/attractors';
import type { ClassifiedAttractors } from '../simulation/attractors';
import type { EntityManager } from '../simulation/entity-manager';
import type { GameEntity } from '../game-entity/game-entity';

// ある時刻の、積分1ステップが必要とする対象一式。collision は mu=0 の表示天体も含む全天体に
// 未来状態を引ける collides entity を加えたもの、gravity はそのうち引力を持つものと動的重力源。
export type PlanSourcesAt = {
  readonly t: number;
  readonly gravity: readonly Attractor[];
  readonly collision: readonly Attractor[];
  readonly collisionById: ReadonlyMap<AttractorId, Attractor>;
  readonly classified: ClassifiedAttractors;
};

// PlanArc は現在状態の配列を凍結せず、各積分時刻に同じ provider を呼ぶ。revision は provider が
// 答える内容が変わったことを PlanArc の再積分キャッシュへ伝える。
export type PlanAttractorProvider = {
  readonly revision: number;
  readonly at: (t: number) => PlanSourcesAt;
};

const REVISION_MIX_PRIME = 16777619;
const REVISION_SEED = 2166136261 | 0;
// 予測列の届き具合の3値。「持たない」を「届いていない」と混ぜないための区別。
const NO_PREDICTION = -1;
const PREDICTION_SHORT = 0;
const PREDICTION_COVERS_PLAN = 1;

// 保持する時刻の数。1ステップが引くのは開始・中点・終了の3時刻で、ある歩の終了は次の歩の開始と
// 一致する。その一致だけを拾えばよいので、少数で足りる。
const HELD_SLOTS = 4;

// 計画の終端が未確定なフレームで、毎回異なる revision を作るための連番。
let unresolvedPlanEndTick = 0;

// 32bit 整数への畳み込み。非有限な value は 0 として畳み込まれ、結果は常に有限。
function mixNumber(acc: number, value: number): number {
  return Math.imul(acc ^ (value | 0), REVISION_MIX_PRIME) | 0;
}

// 文字列を文字コード列として畳み込む。
function mixString(acc: number, value: string): number {
  let out = acc;
  for (let i = 0; i < value.length; i++) out = mixNumber(out, value.charCodeAt(i));
  return out;
}

// その個体の予測列が計画の終端 planEnd まで届いているか。伸長の途中では値が動かず、
// 届いた瞬間に一度だけ変わる — 伸びている間の変化を revision に載せると、覆い切りに
// 何フレームもかかる長い表示期間で計画の再積分が毎フレーム走り続ける。
function predictionCoverage(entity: GameEntity, planEnd: number): number {
  const tip = entity.predicted?.state.t;
  if (tip === undefined) return NO_PREDICTION;
  return tip >= planEnd ? PREDICTION_COVERS_PLAN : PREDICTION_SHORT;
}

// provider が返す内容を変えうる入力だけを畳み込んだ世代値。planEnd は計画の折れ線が届いている
// 終端時刻で、simTime より後の有限値でなければ毎回異なる値を返す。
export function planSourceRevision(
  entities: EntityManager,
  excludedEntityIds: readonly AttractorId[],
  planRevision: number,
  planEnd: number,
  simTime: number,
): number {
  // 時刻に依らない入力 — 計画の編集と除外集合。
  let acc = mixNumber(REVISION_SEED, planRevision);
  for (const id of excludedEntityIds) acc = mixString(acc, id);
  if (!Number.isFinite(planEnd) || !(planEnd > simTime)) {
    return mixNumber(acc, ++unresolvedPlanEndTick);
  }
  // provider の出力に現れるのは、将来時刻の状態を答えられる個体 — predictsFuture が真のもの —
  // だけなので、その id と予測の届き具合を畳み込む。id が集合の顔ぶれの変化を、届き具合が
  // 各個体の引ける時刻範囲の変化を表す。
  const excluded = new Set(excludedEntityIds);
  for (const e of entities.attractors()) {
    if (!e.predictsFuture) continue;
    acc = mixString(acc, e.id);
    acc = mixNumber(acc, predictionCoverage(e, planEnd));
  }
  for (const e of entities.all()) {
    if (!e.alive || !e.predictsFuture || !e.collides || !(e.radius > 0) || excluded.has(e.id)) continue;
    acc = mixString(acc, e.id);
    acc = mixNumber(acc, predictionCoverage(e, planEnd));
  }
  return acc;
}

export class PlanAttractors implements PlanAttractorProvider {
  private revisionValue = 0;
  private excluded: ReadonlySet<AttractorId> = new Set();
  private readonly held: (PlanSourcesAt | null)[] = new Array(HELD_SLOTS).fill(null);
  private cursor = 0;

  constructor(
    private readonly ephemeris: Ephemeris,
    private readonly entities: EntityManager,
  ) {}

  get revision(): number { return this.revisionValue; }

  // このフレームの入力を渡す。答える内容が変わっていれば、保持していた解決結果もここで捨てる
  // — 呼び出し側は入力を渡すだけで、何を捨てるかを知る必要はない。
  resolve(
    excludedEntityIds: readonly AttractorId[],
    planRevision: number,
    planEnd: number,
    simTime: number,
  ): void {
    const next = planSourceRevision(this.entities, excludedEntityIds, planRevision, planEnd, simTime);
    if (next === this.revisionValue) return;
    this.revisionValue = next;
    this.excluded = new Set(excludedEntityIds);
    this.held.fill(null);
    this.cursor = 0;
  }

  // 時刻 t の対象一式。**返り値の配列と Map は保持され使い回されるので、呼び出し側で
  // 書き換えてはならない。**
  at(t: number): PlanSourcesAt {
    for (const entry of this.held) {
      if (entry !== null && entry.t === t) return entry;
    }
    const resolved = this.resolveAt(t);
    this.held[this.cursor] = resolved;
    this.cursor = (this.cursor + 1) % HELD_SLOTS;
    return resolved;
  }

  // 解析天体の窓は1回だけ引き、衝突体と重力源の両方をそこから組む — 同じ時刻の重力源を
  // 別の窓として引き直すと、同じ天体の位置を二度計算することになる。この窓を動的重力源の
  // displayState 外挿より先に引くのも同じ理由で、外挿が問い合わせる中心天体の stateOf を
  // そのキャッシュへ当てる。
  private resolveAt(t: number): PlanSourcesAt {
    const collision: Attractor[] = [];
    const gravity: Attractor[] = [];
    const collisionById = new Map<AttractorId, Attractor>();
    // 解析天体は mu=0 の表示天体も含めて全数が衝突対象で、そのうち引力を持つものが重力源。
    for (const body of this.ephemeris.attractorsAt(t)) {
      collision.push(body);
      if (!collisionById.has(body.id)) collisionById.set(body.id, body);
      if (body.mu !== 0) gravity.push(body);
    }
    for (const e of this.entities.attractors()) {
      const state = e.displayState(t, this.ephemeris);
      if (state === null) continue;
      gravity.push({ id: e.id, mu: e.mu, radius: e.radius, degree2: e.degree2, isStar: e.isStar, state });
    }
    for (const e of this.entities.all()) {
      if (!e.alive || !e.collides || !(e.radius > 0) || this.excluded.has(e.id) || collisionById.has(e.id)) continue;
      const state = e.displayState(t, this.ephemeris);
      if (state === null) continue;
      const body = { id: e.id, mu: e.mu, radius: e.radius, degree2: e.degree2, isStar: e.isStar, state };
      collision.push(body);
      collisionById.set(e.id, body);
    }
    return { t, gravity, collision, collisionById, classified: classifyAttractors(gravity) };
  }
}
