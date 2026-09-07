// 重力源一覧を、位置に依らず常に加算する天体と、到達量の内側で加算する天体へ分類し、ある位置へ
// 効きうる天体を取り出す。分類1回を多数の問い合わせ位置で使い回すことが成立条件。
import { CelestialMotion } from '../../physics/celestial-motion';
import { Vec3, distSq, lenSq } from '../../math/vec3';

// 一覧から落とす天体1体の寄与の上限 [m/s^2]。
export const GRAVITY_NEGLIGIBLE_ACCEL = 1e-8;

// 引力 mu の天体の寄与が GRAVITY_NEGLIGIBLE_ACCEL を割ると言い切れる距離(到達量)[m]。直達項 mu/d²
// と ECI 原点補正項 mu/D² の和は 2mu/min(d,D)² を超えないので、min(d,D) がこれを上回れば寄与は
// 無視できる。
export function gravityReachOf(mu: number): number {
  return Math.sqrt(2 * mu / GRAVITY_NEGLIGIBLE_ACCEL);
}

// 到達量の内側で加算する天体。r は分類した時刻の ECI 位置 [m]、reachSq は到達量の2乗 [m²]。
type RangedAttractor = {
  readonly motion: CelestialMotion;
  readonly r: Vec3;
  readonly reachSq: number;
};

// 重力源一覧を、常に含める天体(always)と到達量の内側で含める天体(ranged)へ分けたもの。
export type ClassifiedAttractors = {
  readonly always: readonly CelestialMotion[];
  readonly ranged: readonly RangedAttractor[];
};

// 重力源一覧を、時刻 pivot の位置で分類する。ECI 原点を到達量の内側に持つ天体は、原点補正項
// mu/D² が問い合わせ位置に依らず残るので always へ入る(原点天体は D = 0 なので必ず入る)。
// 残りは、問い合わせ位置が到達量の内側に来たときに効く ranged へ入る。
//
// **1回の分類を多数の問い合わせ位置で使い回すことが成立条件。** 分類が全天体の位置解決を1回
// 払い、以降の問い合わせは解決済みの位置との距離比較で済む。1点ごとに分類し直すと、その1点の
// ために全天体を解決し直すので、一覧をそのまま走査する費用に分類の費用が上乗せになる。
export function classifyAttractors(
  attractors: readonly CelestialMotion[], pivot: number,
): ClassifiedAttractors {
  const always: CelestialMotion[] = [];
  const ranged: RangedAttractor[] = [];
  for (const motion of attractors) {
    const r = motion.positionAt(pivot);
    const reach = gravityReachOf(motion.def.mu);
    const reachSq = reach * reach;
    // 原点との距離で振り分け、ranged には問い合わせ側の距離比較に要る位置と到達量を添える。
    if (lenSq(r) <= reachSq) always.push(motion);
    else ranged.push({ motion, r, reachSq });
  }
  return { always, ranged };
}

// 位置 pos から見た重力源一覧 = 常に含める天体 + pos を到達量の内側に置く天体を、out へ
// 書き込む。out は呼び出し側が所有する作業領域で、空にしてから書き込む。
export function attractorsNearInto(
  pos: Vec3, classified: ClassifiedAttractors, out: CelestialMotion[],
): CelestialMotion[] {
  out.length = 0;
  for (const a of classified.always) out.push(a);
  for (const a of classified.ranged) {
    if (distSq(pos, a.r) <= a.reachSq) out.push(a.motion);
  }
  return out;
}
