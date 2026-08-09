// このステップぶんの重力源一覧 = 解析天体(Ephemeris の重力窓) + 重力を持つ生存中の
// GameEntity。呼び出し側が「いつの瞬間か」を決めて1回だけ呼び、同じ配列をそのステップの
// 全エンティティに使い回す — 重力天体どうしの相互作用を処理順に依存させないため。
import type { Ephemeris } from '../../physics/ephemeris';
import { Attractor } from '../../physics/attractor';
import type { EntityManager } from './entity-manager';

// Ephemeris のリングキャッシュは呼び出し側で破壊してはいけない共有参照を返すので、合流は
// 常に新しい配列への展開で行う。dynamic が空なら bodies をそのまま返す。
export function mergeAttractors(bodies: readonly Attractor[], dynamic: readonly Attractor[]): readonly Attractor[] {
  return dynamic.length === 0 ? bodies : [...bodies, ...dynamic];
}

// 時刻 t におけるこのステップぶんの重力源一覧。
export function gravityAttractorsAt(ephemeris: Ephemeris, entities: EntityManager, t: number): readonly Attractor[] {
  return mergeAttractors(ephemeris.gravityAttractorsAt(t), entities.attractors());
}
