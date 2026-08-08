// サンプル列(折れ線)そのものから特徴点を探す純粋関数群。接触軌道要素の解析式は評価
// エポックが変わるだけで値が動く(J2 短周期振動が1周回で数十km)ため、実際に描かれている
// 積分結果と一致させたい特徴点(アプシス・赤道交点)はここで折れ線を走査して求める。
import { Attractor } from './attractor';
import { hermiteInterpolate, KinematicState } from './kinematic-state';
import { len, sub, Vec3 } from './vec3';

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

// [a, b] 区間内で、中心天体からの距離が極小/極大になる点を、隣接3サンプルの
// 符号パターンから探して補間で追い込む。見つからなければ null。
export function findApsis(
  samples: readonly KinematicState[], center: Attractor, kind: 'periapsis' | 'apoapsis',
): KinematicState | null {
  if (samples.length < 3) return null;
  const findMax = kind === 'apoapsis';
  const dists = samples.map((s) => distFromCenter(center, s));
  for (let i = 1; i < samples.length - 1; i++) {
    const isExtremum = findMax
      ? dists[i]! >= dists[i - 1]! && dists[i]! >= dists[i + 1]!
      : dists[i]! <= dists[i - 1]! && dists[i]! <= dists[i + 1]!;
    if (!isExtremum) continue;
    // 極値が i そのものに乗る退化ケースも、i-1..i と i..i+1 のどちらかの区間内に実際の
    // 極値があるとみなして絞り込む。放物線近似で「どちら側か」を予測することもできるが
    // (差が小さい平坦側に頂点が来る)、両側を実際に絞り込んで比較するほうが、近似が外れて
    // 頂点の無い区間を渡してしまう(→黄金分割探索が端点へ収束するだけに終わる)構造的な
    // 取り違えが起きない。反復コストは2倍になるが、1フレームに数個のアイコンなので無視できる。
    const left = refineExtremum(center, samples[i - 1]!, samples[i]!, findMax);
    const right = refineExtremum(center, samples[i]!, samples[i + 1]!, findMax);
    const leftDist = distFromCenter(center, left);
    const rightDist = distFromCenter(center, right);
    return findMax ? (leftDist >= rightDist ? left : right) : (leftDist <= rightDist ? left : right);
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

// 円軌道に近いかどうかを、接触軌道要素ではなくサンプル列そのものの半径変動から判定する。
// (rMax-rMin)/2/rMean を離心率相当の指標として扱う — J2 短周期振動下では接触離心率が
// エポックごとに揺れるため、エポック依存の値でガードすると解消したい問題がガード側に残る。
export function apparentEccentricity(samples: readonly KinematicState[], center: Attractor): number {
  if (samples.length === 0) return 0;
  let rMin = Infinity, rMax = -Infinity, rSum = 0;
  for (const s of samples) {
    const r = distFromCenter(center, s);
    rMin = Math.min(rMin, r);
    rMax = Math.max(rMax, r);
    rSum += r;
  }
  const rMean = rSum / samples.length;
  return rMean > 0 ? (rMax - rMin) / 2 / rMean : 0;
}
