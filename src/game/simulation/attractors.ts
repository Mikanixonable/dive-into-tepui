// このステップぶんの重力源一覧 = 解析天体(Ephemeris の全天体窓) + 重力を持つ生存中の
// GameEntity。呼び出し側が「いつの瞬間か」を決めて1回だけ呼び、同じ配列をそのステップの
// 全エンティティに使い回す — 重力天体どうしの相互作用を処理順に依存させないため。
import type { Ephemeris } from '../../physics/ephemeris';
import { Attractor } from '../../physics/attractor';
import { SpatialGrid } from '../../physics/spatial-grid';
import { Vec3 } from '../../physics/vec3';
import { GRAVITY_GRID_CELL_SIZE, GRAVITY_NEGLIGIBLE_ACCEL } from '../const';
import type { EntityManager } from './entity-manager';

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

// 重力源一覧を、常に含める天体(always)と空間グリッドに載せる天体(grid)へ分けたもの。
export type ClassifiedAttractors = {
  readonly always: readonly Attractor[];
  readonly grid: SpatialGrid<Attractor>;
};

// 重力源一覧を、セル一辺 GRAVITY_GRID_CELL_SIZE 離れた地点での引力 mu/R² が
// GRAVITY_NEGLIGIBLE_ACCEL 以上かどうかだけで分類する。判定は mu 一本で、天体の出自(解析天体か
// 重力を持つ GameEntity か)は見ない。off(グリッドに載せた)天体は、そのセルの27近傍にある
// 問い合わせ位置からしか加算されない — R より遠い問い合わせ位置には直達項 mu/d² を足さない
// 近似で、そちらが落とす分の ECI 原点補正項 mu/d²(d は当該天体の原点からの距離)は
// d > R である限りこれより小さい。
export function classifyAttractors(attractors: readonly Attractor[]): ClassifiedAttractors {
  const always: Attractor[] = [];
  const grid = new SpatialGrid<Attractor>(GRAVITY_GRID_CELL_SIZE);
  const thresholdMu = GRAVITY_NEGLIGIBLE_ACCEL * GRAVITY_GRID_CELL_SIZE * GRAVITY_GRID_CELL_SIZE;
  for (const a of attractors) {
    if (a.mu >= thresholdMu) always.push(a);
    else grid.insert(a, a.state.r);
  }
  return { always, grid };
}

// 位置 pos から見た重力源一覧 = 常に含める天体 + pos の27近傍グリッドに載っている天体。
export function attractorsNear(pos: Vec3, classified: ClassifiedAttractors): readonly Attractor[] {
  const nearby = classified.grid.neighbors(pos);
  return nearby.length === 0 ? classified.always : [...classified.always, ...nearby];
}
