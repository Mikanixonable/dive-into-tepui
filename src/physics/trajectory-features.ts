// 軌道の特徴点を探す純粋関数群と、それを積分の進行に沿って溜める入れ物。接触軌道要素の解析式は
// 評価エポックが変わるだけで値が動く(J2 短周期振動が1周回で数十km)ため、実際に描かれている
// 積分結果と一致させたい特徴点はここで求める。赤道交点(findEquatorCrossings)はサンプル列
// (折れ線)を走査して求め、アプシス(apsisCrossing/ApsisTrack)は積分の1ステップごとに動径速度の
// 符号反転を直接見て求める — どちらも同じ黄金分割探索/二分法の補間機構を使う。
import { Attractor } from './attractor';
import { hermiteInterpolate, KinematicState } from './kinematic-state';
import { goldenSectionMin } from './optimize';
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
  const sign = findMax ? -1 : 1;
  const u = goldenSectionMin(0, 1, (u) => sign * distFromCenter(center, atParam(a, b, u)), REFINE_ITERATIONS);
  return atParam(a, b, u);
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

// 時刻昇順の states から t より前のものを落とす。
function dropBefore(states: KinematicState[], t: number): void {
  let cut = 0;
  while (cut < states.length && states[cut]!.t < t) cut++;
  if (cut > 0) states.splice(0, cut);
}

// 中心天体を生成時に固定し、積分の1ステップ対を時刻順に observe へ渡すと、見つかった
// 近地点・遠地点を時刻昇順に溜める。dropBefore で範囲の先頭より前を落とすので、
// periapsis/apoapsis は常に「いま答える範囲で最初の極値」を返す。
export class ApsisTrack {
  private readonly periapsides: KinematicState[] = [];
  private readonly apoapsides: KinematicState[] = [];

  public constructor(private readonly _center: Attractor) {}

  // 極値の検出に使っている中心天体。
  public get center(): Attractor {
    return this._center;
  }

  // prev→next の1ステップを apsisCrossing に掛け、見つかった極値を種類ごとの列へ追加する。
  public observe(prev: KinematicState, next: KinematicState): void {
    const crossing = apsisCrossing(this._center, prev, next);
    if (crossing?.kind === 'periapsis') this.periapsides.push(crossing.state);
    if (crossing?.kind === 'apoapsis') this.apoapsides.push(crossing.state);
  }

  // 両列から t より前(< t)の要素を先頭から落とす。
  public dropBefore(t: number): void {
    dropBefore(this.periapsides, t);
    dropBefore(this.apoapsides, t);
  }

  // 時刻昇順の列で最初の近地点。無ければ null。
  public get periapsis(): KinematicState | null {
    return this.periapsides[0] ?? null;
  }

  // 時刻昇順の列で最初の遠地点。無ければ null。
  public get apoapsis(): KinematicState | null {
    return this.apoapsides[0] ?? null;
  }
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
