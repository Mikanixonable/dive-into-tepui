// 計画・予測の積分が引きうる天体の候補一覧と、そのうち1体を時刻ごとに解決する窓口。
// 世代値(revision)が、答える内容を変えうる入力(計画の編集・除外集合・各個体の予測の
// 届き具合)の変化を呼び出し側の再積分キャッシュへ伝える。
import type { Ephemeris } from '../../physics/ephemeris';
import type { Attractor, AttractorId } from '../../physics/attractor';
import type { EntityManager } from './entity-manager';
import type { GameEntity } from '../game-entity/game-entity';
import type { FutureAttractorProvider, FutureBodyCandidate } from './arc-bodies';

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

// 除外集合が前回と同じ顔ぶれか。
function sameIds(a: readonly AttractorId[], b: readonly AttractorId[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

export class FutureAttractors implements FutureAttractorProvider {
  private revisionValue = 0;
  private excluded: ReadonlySet<AttractorId> = new Set();
  // 候補一覧と、それを組んだときの顔ぶれ(EntityManager の世代・除外集合)。
  private candidateList: readonly FutureBodyCandidate[] = [];
  private candidateEntities: ReadonlyMap<AttractorId, GameEntity> = new Map();
  private candidateRevisionValue = 0;
  private candidateRoster = -1;
  private candidateExcluded: readonly AttractorId[] = [];

  constructor(
    private readonly ephemeris: Ephemeris,
    private readonly entities: EntityManager,
  ) {}

  get revision(): number { return this.revisionValue; }

  get candidateRevision(): number { return this.candidateRevisionValue; }

  candidates(): readonly FutureBodyCandidate[] { return this.candidateList; }

  // このフレームの入力を渡す。答える内容が変わっていれば revision を進める — 呼び出し側は
  // 入力を渡すだけで、何が答えを変えるかを知る必要はない。
  resolve(
    excludedEntityIds: readonly AttractorId[],
    planRevision: number,
    planEnd: number,
  ): void {
    this.refreshCandidates(excludedEntityIds);
    const next = futureSourceRevision(this.entities, excludedEntityIds, planRevision, planEnd);
    if (next === this.revisionValue) return;
    this.revisionValue = next;
  }

  // 候補1体の時刻 t での状態。動的個体がその時刻を答えられなければ null。
  bodyAt(id: AttractorId, t: number): Attractor | null {
    const entity = this.candidateEntities.get(id);
    if (entity === undefined) return this.ephemeris.attractorAt(id, t);
    if (!entity.alive) return null;
    const state = entity.displayState(t, this.ephemeris);
    if (state === null) return null;
    return {
      id, mu: entity.mu, radius: entity.radius,
      degree2: entity.degree2, isStar: entity.isStar, state,
    };
  }

  // 候補一覧を、レジストリの天体と生存する動的個体から組み直す。顔ぶれと除外集合が
  // 前回と同じなら何もしない。
  private refreshCandidates(excludedEntityIds: readonly AttractorId[]): void {
    if (this.candidateRoster === this.entities.collectionRevision
      && sameIds(this.candidateExcluded, excludedEntityIds)) return;
    this.candidateRoster = this.entities.collectionRevision;
    this.candidateExcluded = [...excludedEntityIds];
    this.excluded = new Set(excludedEntityIds);

    // 解析天体は mu=0 の表示天体も含めて全数が表面到達の相手。
    const list: FutureBodyCandidate[] = [];
    for (const def of Object.values(this.ephemeris.registry)) {
      list.push({ id: def.id, mu: def.mu, radius: def.radius, analytic: true, collision: true });
    }
    // 動的個体は、引力を持つものが重力源、predictedAsPlanCollider なものが表面到達の相手。
    const byEntity = new Map<AttractorId, GameEntity>();
    for (const e of this.entities.attractors()) {
      byEntity.set(e.id, e);
      list.push({
        id: e.id, mu: e.mu, radius: e.radius, analytic: false,
        collision: e.predictedAsPlanCollider && !this.excluded.has(e.id),
      });
    }
    for (const e of this.entities.all()) {
      if (!e.alive || !e.predictedAsPlanCollider || this.excluded.has(e.id) || byEntity.has(e.id)) continue;
      byEntity.set(e.id, e);
      list.push({ id: e.id, mu: e.mu, radius: e.radius, analytic: false, collision: true });
    }
    this.candidateList = list;
    this.candidateEntities = byEntity;
    this.candidateRevisionValue++;
  }
}
