// 通信圏の判定。中継点との見通しが通り、かつ距離が到達距離以内であることで圏内が決まる。
// 中継は多段であり、通信基地を起点に前方へ閉じた「有効な中継点」だけが周囲を圏内にする。
// DOM にも THREE にも依存しない純関数として書く — 圏内外はゲームの進行そのものを左右する
// 判定なので、単体テストから直接引けることを保つ。
import { isOccluded } from '../../physics/occlusion';
import type { KinematicState } from '../../physics/kinematic-state';
import { len, sub, Vec3 } from '../../physics/vec3';

// 見通しを遮りうる天体。physics/attractor.ts の Attractor がそのまま満たす。
export interface CommOccluder {
  readonly radius: number;
  readonly state: KinematicState;
}

export interface CommRelay {
  readonly id: string;
  readonly pos: Vec3; // ECI
  readonly range: number; // m。この中継点が届く距離
  readonly isGround: boolean; // 通信基地か(網の起点になる)
}

// 2点が直接繋がるか。到達距離は両側の小さいほうで決まる — 強力な中継点の傍にいても、
// 積んでいる通信モジュールが小型なら届く距離はその等級までである(§13-2 の単純化)。
function linked(
  a: Vec3, aRange: number, b: Vec3, bRange: number, attractors: readonly CommOccluder[],
): boolean {
  const reach = Math.min(aRange, bRange);
  if (!(reach > 0)) return false;
  if (len(sub(b, a)) > reach) return false;
  return !isOccluded(a, b, attractors);
}

// 通信基地から前方に閉じて求めた、この時点で有効な中継点の集合。中継点が有効であるのは
// それ自身が通信基地であるか、既に有効な中継点と繋がっているときだけなので、基地から
// 孤立した中継点はどれほど強力でも誰も圏内にしない。
export function activeRelays(
  relays: readonly CommRelay[],
  attractors: readonly CommOccluder[],
): readonly CommRelay[] {
  const active: CommRelay[] = relays.filter((r) => r.isGround && r.range > 0);
  const pending: CommRelay[] = relays.filter((r) => !r.isGround && r.range > 0);

  // 有効集合が増えなくなるまで繰り返す。中継点の数は多くないので素朴な閉包で足りる。
  for (let grew = true; grew;) {
    grew = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const candidate = pending[i]!;
      const reachable = active.some((a) => linked(candidate.pos, candidate.range, a.pos, a.range, attractors));
      if (!reachable) continue;
      pending.splice(i, 1);
      active.push(candidate);
      grew = true;
    }
  }
  return active;
}

// pos にいる、到達距離 ownRange の通信モジュールを積んだ機体が圏内か。有効な中継点の
// いずれか1つと見通しと距離を満たせば圏内である。
export function isInCommRange(
  pos: Vec3,
  active: readonly CommRelay[],
  ownRange: number,
  attractors: readonly CommOccluder[],
): boolean {
  return active.some((r) => linked(pos, ownRange, r.pos, r.range, attractors));
}
