// 軌道の特徴点を探す純粋関数群。接触軌道要素の解析式は評価エポックが変わるだけで値が
// 動く(J2 短周期振動が1周回で数十km)ため、実際に描かれている積分結果と一致させたい
// 特徴点はここで求める。赤道交点(findEquatorCrossings)はサンプル列(折れ線)を走査して
// 求め、アプシス(apsisCrossing)は積分の1ステップごとに動径速度の符号反転を直接見て求める
// — どちらも同じ黄金分割探索/二分法の補間機構(refineExtremum/findCrossing)を使う。
import { Attractor } from './attractor';
import { hermiteInterpolate, KinematicState } from './kinematic-state';
import { dot, len, sub, Vec3 } from './vec3';

// 極値探索・交点二分法の反復回数。固定回数にしているのは、収束判定にすると反復回数が
// フレームごとに変動し、その分だけ結果がわずかに揺れるため。
const REFINE_ITERATIONS = 20;

// 中心天体からの距離。
function distFromCenter(center: Attractor, s: KinematicState): number {
  return len(sub(s.r, center.state.r));
}

// a-b 区間を hermiteInterpolate で埋めた [0,1] パラメータ位置 u の状態。
function atParam(a: KinematicState, b: KinematicState, u: number): KinematicState {
  return hermiteInterpolate(a, b, a.t + (b.t - a.t) * u);
}

// [a, b] 区間内の中心天体距離の極大/極小を黄金分割探索で追い込む。
function refineExtremum(
  center: Attractor, a: KinematicState, b: KinematicState, findMax: boolean,
): KinematicState {
  const phi = (Math.sqrt(5) - 1) / 2;
  // [lo, hi] を [0,1] 全体から始め、区間内の2点 u1<u2 を評価して劣る側を毎回捨てる。
  let lo = 0, hi = 1;
  let u1 = hi - phi * (hi - lo);
  let u2 = lo + phi * (hi - lo);
  let f1 = distFromCenter(center, atParam(a, b, u1));
  let f2 = distFromCenter(center, atParam(a, b, u2));
  for (let i = 0; i < REFINE_ITERATIONS; i++) {
    const takeRight = findMax ? f1 < f2 : f1 > f2;
    if (takeRight) {
      lo = u1;
      u1 = u2; f1 = f2;
      u2 = lo + phi * (hi - lo);
      f2 = distFromCenter(center, atParam(a, b, u2));
    } else {
      hi = u2;
      u2 = u1; f2 = f1;
      u1 = hi - phi * (hi - lo);
      f1 = distFromCenter(center, atParam(a, b, u1));
    }
  }
  return atParam(a, b, (lo + hi) / 2);
}

export type ApsisKind = 'periapsis' | 'apoapsis';

export interface ApsisCrossing {
  readonly state: KinematicState;
  readonly kind: ApsisKind;
}

// prev→next の1積分ステップの間に中心天体からの動径速度(距離の変化率)の符号が
// 反転していれば、その瞬間がアプシス。減速→増速(負→正)が近地点、増速→減速
// (正→負)が遠地点で、どちらでもなければ null。中心天体自身も動いている場合が
// あるので、位置だけでなく速度も中心天体の値を差し引いた相対量で判定する。
export function apsisCrossing(center: Attractor, prev: KinematicState, next: KinematicState): ApsisCrossing | null {
  const radialVel = (s: KinematicState): number =>
    dot(sub(s.r, center.state.r), sub(s.v, center.state.v));
  const vPrev = radialVel(prev);
  const vNext = radialVel(next);
  if (vPrev < 0 && vNext >= 0) {
    return { state: refineExtremum(center, prev, next, false), kind: 'periapsis' };
  }
  if (vPrev > 0 && vNext <= 0) {
    return { state: refineExtremum(center, prev, next, true), kind: 'apoapsis' };
  }
  return null;
}

// [a, b] 区間内で、中心天体の赤道面(pole に垂直な面)を横切る点を、符号反転する
// 隣接サンプル対から二分法で追い込む。asc(昇交点、負→正)/desc(降交点、正→負)。
function findCrossing(
  samples: readonly KinematicState[], center: Attractor, pole: Vec3, ascending: boolean,
): KinematicState | null {
  // pole 方向の符号(赤道面のどちら側にいるか)。
  const sideOf = (s: KinematicState): number => {
    const rel = sub(s.r, center.state.r);
    return rel.x * pole.x + rel.y * pole.y + rel.z * pole.z;
  };
  for (let i = 0; i < samples.length - 1; i++) {
    const s0 = sideOf(samples[i]!);
    const s1 = sideOf(samples[i + 1]!);
    const isCrossing = ascending ? s0 < 0 && s1 >= 0 : s0 > 0 && s1 <= 0;
    if (!isCrossing) continue;
    // 符号が反転する [a, b] を二分法で挟み込む。
    let a = samples[i]!, b = samples[i + 1]!;
    let fa = s0;
    for (let iter = 0; iter < REFINE_ITERATIONS; iter++) {
      const mid = atParam(a, b, 0.5);
      const fm = sideOf(mid);
      if ((fm >= 0) === (fa >= 0)) { a = mid; fa = fm; } else { b = mid; }
    }
    return atParam(a, b, 0.5);
  }
  return null;
}

// 赤道昇交点・降交点。どちらか片方だけ折れ線内に見つかる状況もあるので、それぞれ独立に返す。
export interface EquatorCrossings {
  readonly ascending: KinematicState | null;
  readonly descending: KinematicState | null;
}

// 昇交点・降交点をそれぞれ独立に探して返す。
export function findEquatorCrossings(
  samples: readonly KinematicState[], center: Attractor, pole: Vec3,
): EquatorCrossings {
  return {
    ascending: findCrossing(samples, center, pole, true),
    descending: findCrossing(samples, center, pole, false),
  };
}
