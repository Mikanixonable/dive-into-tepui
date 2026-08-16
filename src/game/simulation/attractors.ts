// このステップぶんの重力源一覧 = 解析天体(Ephemeris の全天体窓) + 重力を持つ生存中の
// GameEntity。呼び出し側が「いつの瞬間か」を決めて1回だけ呼び、同じ配列をそのステップの
// 全エンティティに使い回す — 重力天体どうしの相互作用を処理順に依存させないため。
import type { Ephemeris } from '../../physics/ephemeris';
import type { Attractor, AttractorId } from '../../physics/attractor';
import { SpatialGrid } from '../../physics/spatial-grid';
import { Vec3 } from '../../physics/vec3';
import { GRAVITY_ALWAYS_COUNT, GRAVITY_NEGLIGIBLE_ACCEL } from '../const';
import type { EntityManager } from './entity-manager';

// Ephemeris のリングキャッシュは呼び出し側で破壊してはいけない共有参照を返すので、合流は
// 常に新しい配列への展開で行う。dynamic が空なら bodies をそのまま返す。
export function mergeAttractors(bodies: readonly Attractor[], dynamic: readonly Attractor[]): readonly Attractor[] {
  return dynamic.length === 0 ? bodies : [...bodies, ...dynamic];
}

// 時刻 t の解析天体のうち重力を及ぼすもの。重力源かどうかは解析天体・GameEntity の別なく
// mu !== 0 の一本で決まる — 表示だけの天体は寄与が恒等的にゼロなので加算の候補に載せない
// (遮蔽・表面接触・中心天体の解決は別の問いで、そちらは Ephemeris の窓をそのまま使う)。
function gravityBodiesAt(ephemeris: Ephemeris, t: number): readonly Attractor[] {
  return ephemeris.gravityAttractorsAt(t);
}

// 時刻 t におけるこのステップぶんの重力源一覧。
export function attractorsAt(ephemeris: Ephemeris, entities: EntityManager, t: number): readonly Attractor[] {
  return mergeAttractors(gravityBodiesAt(ephemeris, t), entities.attractors());
}

// 時刻 t での重力源一覧(予測用)。動的重力天体も t の状態で組む — 現在位置で凍結すると
// 「その時刻に居ない場所」から引くことになる。予測列で答えられない天体は先端からの
// ケプラー外挿(GameEntity.displayState)で継ぎ、それでも答えられない天体だけ落ちる。
export function predictedAttractorsAt(ephemeris: Ephemeris, entities: EntityManager, t: number): readonly Attractor[] {
  // 先に解析天体の窓を引いておくと、外挿が問い合わせる中心天体の stateOf がそのキャッシュへ当たる。
  const bodies = gravityBodiesAt(ephemeris, t);
  const dynamic: Attractor[] = [];
  for (const e of entities.attractors()) {
    const s = e.displayState(t, ephemeris);
    if (s !== null) dynamic.push({ id: e.id, mu: e.mu, radius: e.radius, degree2: e.degree2, isStar: e.isStar, state: s });
  }
  return mergeAttractors(bodies, dynamic);
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
  muScratch.length = 0;
  for (const a of attractors) muScratch.push(a.mu);
  muScratch.sort((x, y) => y - x);
  return muScratch[GRAVITY_ALWAYS_COUNT - 1] ?? 0;
}

// alwaysThresholdMu 専用の作業領域。値はこの関数の外へ出ない。
const muScratch: number[] = [];

// classifyAttractors 専用の作業領域。grid へ挿入し終えた時点で不要になり、外へ出ない。
const griddedScratch: Attractor[] = [];

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
  const gridded = griddedScratch;
  gridded.length = 0;
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
// excludeId を渡すと、その id の天体をまるごと一覧から除く — pos を持つ本人が重力源
// (Asteroid など)のとき、自分自身を引く項ができるのを防ぐ。まるごと落とすので
// ECI 原点補正項(attractorAccel の第2項、問い合わせ位置に依存しない)も一緒に失うが、
// GameEntity が取りうる質量では無視できる大きさ(1e12 kg の小惑星が2 AUにあるとき
// 7e-25 m/s² 程度)にとどまる。
export function attractorsNear(pos: Vec3, classified: ClassifiedAttractors, excludeId?: AttractorId): readonly Attractor[] {
  const nearby = classified.grid.neighbors(pos);
  const merged = nearby.length === 0 ? classified.always : [...classified.always, ...nearby];
  return excludeId === undefined ? merged : merged.filter((a) => a.id !== excludeId);
}

// attractorsNear と同じ順序の一覧を out へ書き込む再利用版。out は呼び出し側が所有し、
// この呼び出しの完了後に保持してはいけない。返した配列を保持したい呼び出し側は
// attractorsNear を使う。excludeId は attractorsNear と同じ。
export function attractorsNearInto(
  pos: Vec3,
  classified: ClassifiedAttractors,
  out: Attractor[],
  excludeId?: AttractorId,
): Attractor[] {
  out.length = 0;
  for (const a of classified.always) out.push(a);
  classified.grid.appendNeighborsInto(pos, out);
  if (excludeId === undefined) return out;
  // excludeId に一致する要素を、確保を増やさずその場で詰め直して落とす。
  let w = 0;
  for (const a of out) {
    if (a.id !== excludeId) out[w++] = a;
  }
  out.length = w;
  return out;
}
