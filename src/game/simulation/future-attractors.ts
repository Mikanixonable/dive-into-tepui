// 計画・予測の積分が時刻ごとに参照する重力源・衝突体と、その解決。世代値(revision)が、
// 答える内容を変えうる入力(計画の編集・除外集合・各個体の予測の届き具合)の変化を
// 呼び出し側の再積分キャッシュへ伝える。
import type { Ephemeris } from '../../physics/ephemeris';
import type { Attractor, AttractorId } from '../../physics/attractor';
import { classifyAttractors, ClassifiedAttractors, mergeAttractors } from './attractors';
import type { EntityManager } from './entity-manager';
import type { GameEntity } from '../game-entity/game-entity';

// ある時刻の、積分1ステップが必要とする対象一式。collision は mu=0 の表示天体も含む全解析天体に
// 未来状態を引ける predictedAsPlanCollider な entity を加えたもの、gravity はそのうち引力を
// 持つものと動的重力源。
export type FutureSourcesAt = {
  readonly t: number;
  readonly gravity: readonly Attractor[];
  // gravity のうち解析天体だけの部分集合。ケプラー外挿・近地点/遠地点の中心天体は天体暦で
  // 位置を引ける相手でなければならないので、動的重力源を含む gravity ではなくこちらを使う。
  readonly analyticGravity: readonly Attractor[];
  readonly collision: readonly Attractor[];
  readonly collisionById: ReadonlyMap<AttractorId, Attractor>;
  readonly classified: ClassifiedAttractors;
};

// 積分は現在状態の配列を凍結せず、各積分時刻に同じ provider を呼ぶ。revision は provider が
// 答える内容が変わったことを呼び出し側の再積分キャッシュへ伝える。
export type FutureAttractorProvider = {
  readonly revision: number;
  readonly at: (t: number) => FutureSourcesAt;
};

const REVISION_MIX_PRIME = 16777619;
const REVISION_SEED = 2166136261 | 0;
// 予測列の届き具合の4値。「持たない」「打ち切られた」を「届いていない」と混ぜないための区別。
const NO_PREDICTION = -1;
const PREDICTION_SHORT = 0;
const PREDICTION_COVERS_PLAN = 1;
const PREDICTION_TRUNCATED = 2;

// 計画の終端がまだ求まっていないフレームで、毎回異なる revision を作るための連番。
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
// 何フレームもかかる長い表示期間で計画の再積分が毎フレーム走り続ける。届いていない間は
// 打ち切りの有無で分ける — 打ち切られた列は先端から先を外挿できず、その個体が重力源・
// 衝突体の一覧から丸ごと落ちる。
function predictionCoverage(entity: GameEntity, planEnd: number): number {
  const tip = entity.predicted?.state.t;
  if (tip === undefined) return NO_PREDICTION;
  if (tip >= planEnd) return PREDICTION_COVERS_PLAN;
  return entity.predictionTruncated ? PREDICTION_TRUNCATED : PREDICTION_SHORT;
}

// provider が返す内容を変えうる入力だけを畳み込んだ世代値。planEnd は計画区間列自身の
// 積分終端(表示窓でクリップしない)で、有限でなければ毎回異なる値を返す。
function futureSourceRevision(
  entities: EntityManager,
  excludedEntityIds: readonly AttractorId[],
  planRevision: number,
  planEnd: number,
): number {
  // 時刻に依らない入力 — 計画の編集と除外集合。
  let acc = mixNumber(REVISION_SEED, planRevision);
  for (const id of excludedEntityIds) acc = mixString(acc, id);
  if (!Number.isFinite(planEnd)) {
    return mixNumber(acc, ++unresolvedPlanEndTick);
  }
  // provider の出力に現れるのは、将来時刻の状態を答えられる個体 — 重力源として predictsFuture が
  // 真のもの、衝突体として predictedAsPlanCollider が真のもの — だけなので、その id と予測の
  // 届き具合を畳み込む。id が集合の顔ぶれの変化を、届き具合が各個体の引ける時刻範囲の変化を表す。
  const excluded = new Set(excludedEntityIds);
  for (const e of entities.attractors()) {
    if (!e.predictsFuture) continue;
    acc = mixString(acc, e.id);
    acc = mixNumber(acc, predictionCoverage(e, planEnd));
  }
  for (const e of entities.all()) {
    if (!e.alive || !e.predictedAsPlanCollider || excluded.has(e.id)) continue;
    acc = mixString(acc, e.id);
    acc = mixNumber(acc, predictionCoverage(e, planEnd));
  }
  return acc;
}

export class FutureAttractors implements FutureAttractorProvider {
  private revisionValue = 0;
  private excluded: ReadonlySet<AttractorId> = new Set();

  constructor(
    private readonly ephemeris: Ephemeris,
    private readonly entities: EntityManager,
  ) {}

  get revision(): number { return this.revisionValue; }

  // このフレームの入力を渡す。答える内容が変わっていれば revision を進める — 呼び出し側は
  // 入力を渡すだけで、何が答えを変えるかを知る必要はない。
  resolve(
    excludedEntityIds: readonly AttractorId[],
    planRevision: number,
    planEnd: number,
  ): void {
    const next = futureSourceRevision(this.entities, excludedEntityIds, planRevision, planEnd);
    if (next === this.revisionValue) return;
    this.revisionValue = next;
    this.excluded = new Set(excludedEntityIds);
  }

  // 時刻 t の対象一式。**返り値の配列と Map は呼び出し側が保持してよいが、書き換えては
  // ならない**(弧が中心窓として次の歩まで持ち越す)。
  at(t: number): FutureSourcesAt {
    return this.resolveAt(t);
  }

  // 解析天体の窓は1回だけ引き、衝突体と重力源の両方をそこから組む — 同じ時刻の重力源を
  // 別の窓として引き直すと、同じ天体の位置を二度計算することになる。この窓を動的重力源の
  // displayState 外挿より先に引くのも同じ理由で、外挿が問い合わせる中心天体の stateOf を
  // そのキャッシュへ当てる。
  private resolveAt(t: number): FutureSourcesAt {
    const collision: Attractor[] = [];
    const analyticGravity: Attractor[] = [];
    const collisionById = new Map<AttractorId, Attractor>();
    // 解析天体は mu=0 の表示天体も含めて全数が衝突対象で、そのうち引力を持つものが重力源。
    // 積分がこの経路で惑星や衛星に終端するのは entity 側の宣言とは関係しない。
    for (const body of this.ephemeris.attractorsAt(t)) {
      collision.push(body);
      if (!collisionById.has(body.id)) collisionById.set(body.id, body);
      if (body.mu !== 0) analyticGravity.push(body);
    }
    const dynamicGravity: Attractor[] = [];
    for (const e of this.entities.attractors()) {
      const state = e.displayState(t, this.ephemeris);
      if (state === null) continue;
      dynamicGravity.push({ id: e.id, mu: e.mu, radius: e.radius, degree2: e.degree2, isStar: e.isStar, state });
    }
    const gravity = mergeAttractors(analyticGravity, dynamicGravity);
    for (const e of this.entities.all()) {
      if (!e.alive || !e.predictedAsPlanCollider || this.excluded.has(e.id) || collisionById.has(e.id)) continue;
      const state = e.displayState(t, this.ephemeris);
      if (state === null) continue;
      const body = { id: e.id, mu: e.mu, radius: e.radius, degree2: e.degree2, isStar: e.isStar, state };
      collision.push(body);
      collisionById.set(e.id, body);
    }
    return { t, gravity, analyticGravity, collision, collisionById, classified: classifyAttractors(gravity) };
  }
}
