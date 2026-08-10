// このステップぶんの重力源一覧 = 解析天体(Ephemeris の全天体窓) + 重力を持つ生存中の
// GameEntity。呼び出し側が「いつの瞬間か」を決めて1回だけ呼び、同じ配列をそのステップの
// 全エンティティに使い回す — 重力天体どうしの相互作用を処理順に依存させないため。
import type { Ephemeris } from '../../physics/ephemeris';
import type { Attractor, AttractorId } from '../../physics/attractor';
import { SpatialGrid } from '../../physics/spatial-grid';
import { Vec3 } from '../../physics/vec3';
import { GRAVITY_ALWAYS_COUNT, GRAVITY_NEGLIGIBLE_ACCEL } from '../const';
import type { EntityManager } from './entity-manager';

// 計画軌道が時刻ごとに参照する二種類の対象。重力積分は従来どおり近傍へ絞れるが、表面衝突は
// mu=0 の表示天体や、重力を持たない動的 entity も含めた別集合で判定する。
export type PlanAttractorSources = {
  readonly gravity: readonly Attractor[];
  readonly collision: readonly Attractor[];
};

// PlanArc は現在状態の配列を凍結せず、各積分時刻に同じ provider を呼ぶ。revision は provider
// 内の予測列が変化したことを PlanArc の再積分キャッシュへ伝える。
export type PlanAttractorProvider = {
  readonly revision: number;
  readonly at: (t: number) => PlanAttractorSources;
};

// Ephemeris のリングキャッシュは呼び出し側で破壊してはいけない共有参照を返すので、合流は
// 常に新しい配列への展開で行う。dynamic が空なら bodies をそのまま返す。
export function mergeAttractors(bodies: readonly Attractor[], dynamic: readonly Attractor[]): readonly Attractor[] {
  return dynamic.length === 0 ? bodies : [...bodies, ...dynamic];
}

// 時刻 t の解析天体のうち重力を及ぼすもの。重力源かどうかは解析天体・GameEntity の別なく
// mu !== 0 の一本で決まる — 表示だけの天体は寄与が恒等的にゼロなので加算の候補に載せない
// (遮蔽・表面接触・中心天体の解決は別の問いで、そちらは Ephemeris の窓をそのまま使う)。
export function gravityBodiesAt(ephemeris: Ephemeris, t: number): readonly Attractor[] {
  return ephemeris.attractorsAt(t).filter((a) => a.mu !== 0);
}

// 時刻 t におけるこのステップぶんの重力源一覧。
export function attractorsAt(ephemeris: Ephemeris, entities: EntityManager, t: number): readonly Attractor[] {
  return mergeAttractors(gravityBodiesAt(ephemeris, t), entities.attractors());
}

// 時刻 t での重力源一覧(予測用)。動的重力天体も t の状態で組み、t の状態が得られない
// 天体は落とす — 現在位置で凍結すると「その時刻に居ない場所」から引くことになる。
export function predictedAttractorsAt(ephemeris: Ephemeris, entities: EntityManager, t: number): readonly Attractor[] {
  const dynamic: Attractor[] = [];
  for (const e of entities.attractors()) {
    const s = e.displayState(t);
    if (s !== null) dynamic.push({ id: e.id, mu: e.mu, radius: e.radius, degree2: e.degree2, isStar: e.isStar, state: s });
  }
  return mergeAttractors(gravityBodiesAt(ephemeris, t), dynamic);
}

// 計画軌道用の時刻 t の対象。重力側は予測列が存在する動的重力源だけを返す。衝突側は
// Ephemeris の全天体( mu=0 を含む)に、未来状態を取得できる collides entity を加える。
// 未来状態が無い entity を現在位置へ凍結しないのが重要で、予測不能な対象は明示的に除外する。
export function planAttractorsAt(
  ephemeris: Ephemeris,
  entities: EntityManager,
  t: number,
  excludedEntityIds: ReadonlySet<AttractorId> = new Set(),
): PlanAttractorSources {
  const gravity = predictedAttractorsAt(ephemeris, entities, t);
  const collision: Attractor[] = [...ephemeris.attractorsAt(t)];
  const seen = new Set(collision.map((a) => a.id));
  for (const e of entities.all()) {
    if (!e.alive || !e.collides || !(e.radius > 0) || excludedEntityIds.has(e.id) || seen.has(e.id)) continue;
    const state = e.displayState(t);
    if (state === null) continue;
    collision.push({
      id: e.id,
      mu: e.mu,
      radius: e.radius,
      degree2: e.degree2,
      isStar: e.isStar,
      state,
    });
    seen.add(e.id);
  }
  return { gravity, collision };
}

// active player のように計画軌道の起点そのものになっている entity を、計画の衝突対象から
// 外すための provider。除外集合は呼び出し間で不変なので、毎ステップ再生成しない。
export function planAttractorProvider(
  ephemeris: Ephemeris,
  entities: EntityManager,
  excludedEntityIds: readonly AttractorId[] = [],
  revision = 0,
): PlanAttractorProvider {
  const excluded = new Set(excludedEntityIds);
  return { revision, at: (t) => planAttractorsAt(ephemeris, entities, t, excluded) };
}

// 重力源一覧を、常に含める天体(always)と空間グリッドに載せる天体(grid)へ分けたもの。
export type ClassifiedAttractors = {
  readonly always: readonly Attractor[];
  readonly grid: SpatialGrid<Attractor>;
};

// mu の重い順 GRAVITY_ALWAYS_COUNT 本目の値。同値の天体をまとめて always 側へ入れるため、
// 順位ではなく mu の値を返す。
function alwaysThresholdMu(attractors: readonly Attractor[]): number {
  if (attractors.length <= GRAVITY_ALWAYS_COUNT) return 0;
  const mus = attractors.map((a) => a.mu).sort((x, y) => y - x);
  return mus[GRAVITY_ALWAYS_COUNT - 1] ?? 0;
}

// グリッドへ載せた天体のうち最も重いものの引力が GRAVITY_NEGLIGIBLE_ACCEL まで落ちる距離。
// gridded が空のときのセル一辺は結果に影響しないので任意の正数でよい。
function gridCellSize(gridded: readonly Attractor[]): number {
  let heaviestMu = 0;
  for (const a of gridded) heaviestMu = Math.max(heaviestMu, a.mu);
  return heaviestMu > 0 ? Math.sqrt(heaviestMu / GRAVITY_NEGLIGIBLE_ACCEL) : 1;
}

// 重力源一覧を、mu の重い順 GRAVITY_ALWAYS_COUNT 本(always)と残り(grid)へ分類する。しきい値
// もセル一辺も一覧全体から導くので、ある天体がどちらへ入るかは他の天体しだいで決まる。grid の
// 天体はセルの27近傍からしか加算されない — 遠い問い合わせ位置で落とす直達項 mu/d² はセル一辺で
// GRAVITY_NEGLIGIBLE_ACCEL 以下、同時に落ちる ECI 原点補正項 mu/D² は D > d の間これより小さい。
export function classifyAttractors(attractors: readonly Attractor[]): ClassifiedAttractors {
  const thresholdMu = alwaysThresholdMu(attractors);
  const always: Attractor[] = [];
  const gridded: Attractor[] = [];
  for (const a of attractors) {
    if (a.mu >= thresholdMu) always.push(a);
    else gridded.push(a);
  }
  // セル一辺が grid 側の顔ぶれで決まるため、集め終えてからグリッドを作る。
  const grid = new SpatialGrid<Attractor>(gridCellSize(gridded));
  for (const a of gridded) grid.insert(a, a.state.r);
  return { always, grid };
}

// 位置 pos から見た重力源一覧 = 常に含める天体 + pos の27近傍グリッドに載っている天体。
export function attractorsNear(pos: Vec3, classified: ClassifiedAttractors): readonly Attractor[] {
  const nearby = classified.grid.neighbors(pos);
  return nearby.length === 0 ? classified.always : [...classified.always, ...nearby];
}
