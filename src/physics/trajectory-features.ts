// 積分した軌道の特徴点(近地点・遠地点・赤道交点)を探す純粋関数群と、アプシスを積分の進行に沿って
// 溜める ApsisTrack。特徴点を描かれている積分結果と一致させる — 接触軌道要素の解析式は評価エポック
// だけで値が動く(J2 短周期振動が1周回で数十km)。
import { hermiteInterpolate, type KinematicState } from './kinematic-state';
import { goldenSectionMin } from '../math/optimize';
import { dot, len, sub, type Vec3 } from '../math/vec3';
import type { CelestialBody } from './celestial-body';

// 極値探索・交点二分法の反復回数。固定回数にしているのは、収束判定にすると反復回数が
// フレームごとに変動し、その分だけ結果がわずかに揺れるため。
const REFINE_ITERATIONS = 20;

// 時刻 t の中心天体の運動状態。
type CenterStateAt = (t: number) => KinematicState;

// 中心天体からの距離。
function distFromCenter(centerStateAt: CenterStateAt, s: KinematicState): number {
  return len(sub(s.r, centerStateAt(s.t).r));
}

// a-b 区間を hermiteInterpolate で埋めた [0,1] パラメータ位置 u の状態。
function atParam(a: KinematicState, b: KinematicState, u: number): KinematicState {
  return hermiteInterpolate(a, b, a.t + (b.t - a.t) * u);
}

// [a, b] 区間内の中心天体距離の極大/極小を黄金分割探索で追い込む。
function refineExtremum(
  centerStateAt: CenterStateAt, a: KinematicState, b: KinematicState, findMax: boolean,
): KinematicState {
  const sign = findMax ? -1 : 1;
  const u = goldenSectionMin(
    0, 1, (u) => sign * distFromCenter(centerStateAt, atParam(a, b, u)), REFINE_ITERATIONS,
  );
  return atParam(a, b, u);
}

type ApsisKind = 'periapsis' | 'apoapsis';

interface ApsisCrossing {
  readonly state: KinematicState;
  readonly kind: ApsisKind;
}

// prev→next の1積分ステップの間に中心天体 center に対するアプシスがあれば、その瞬間の状態と種類を
// 返す。無ければ null。
export function apsisCrossing(
  center: CelestialBody, centerPivot: number, prev: KinematicState, next: KinematicState,
): ApsisCrossing | null {
  const centerStateAt: CenterStateAt = (t) => center.stateAt(centerPivot, t);
  // 中心天体に対する r·v(動径速度と同符号)。中心天体自身も動くので、速度も相対量で取る。
  const radialVel = (s: KinematicState): number => {
    const centerState = centerStateAt(s.t);
    return dot(sub(s.r, centerState.r), sub(s.v, centerState.v));
  };
  const vPrev = radialVel(prev);
  const vNext = radialVel(next);
  // 動径速度が負→正なら近地点、正→負なら遠地点。
  if (vPrev < 0 && vNext >= 0) {
    return { state: refineExtremum(centerStateAt, prev, next, false), kind: 'periapsis' };
  }
  if (vPrev > 0 && vNext <= 0) {
    return { state: refineExtremum(centerStateAt, prev, next, true), kind: 'apoapsis' };
  }
  return null;
}

// 近地点か遠地点の1つ。center はそれを見つけたときの中心天体。
export interface Apsis {
  readonly state: KinematicState;
  readonly center: CelestialBody;
}

// 時刻昇順の apsides 配列から時刻 t より前の要素を削除する。
function dropBefore(apsides: Apsis[], t: number): void {
  let cut = 0;
  while (cut < apsides.length && apsides[cut]!.state.t < t) cut++;
  if (cut > 0) apsides.splice(0, cut);
}

// 積分の1ステップ対を時刻順に observe へ渡すと、見つかった近地点・遠地点を、その時点の中心天体と
// 組にして時刻昇順に蓄積する。蓄積した配列は dropBefore で先頭から古い要素を削除する。
export class ApsisTrack {
  private readonly periapsides: Apsis[] = [];
  private readonly apoapsides: Apsis[] = [];
  private _center: CelestialBody | null = null;

  // 直近の observe に渡された中心天体。まだ observe を1度も呼んでいなければ null。
  public get center(): CelestialBody | null {
    return this._center;
  }

  // prev→next の1ステップに中心天体 center に対するアプシスがあれば、種類ごとの列へ溜める。
  public observe(center: CelestialBody, centerPivot: number, prev: KinematicState, next: KinematicState): void {
    this._center = center;
    const crossing = apsisCrossing(center, centerPivot, prev, next);
    if (crossing?.kind === 'periapsis') this.periapsides.push({ state: crossing.state, center });
    if (crossing?.kind === 'apoapsis') this.apoapsides.push({ state: crossing.state, center });
  }

  // 両配列から t より前(< t)の要素を先頭から除外する。
  public dropBefore(t: number): void {
    dropBefore(this.periapsides, t);
    dropBefore(this.apoapsides, t);
  }

  // 時刻 t 以降で最初の近地点。無ければ null。
  public periapsisAfter(t: number): Apsis | null {
    return this.periapsides.find((apsis) => apsis.state.t >= t) ?? null;
  }

  // 時刻 t 以降で最初の遠地点。無ければ null。
  public apoapsisAfter(t: number): Apsis | null {
    return this.apoapsides.find((apsis) => apsis.state.t >= t) ?? null;
  }
}

// 時刻順の samples が中心天体の赤道面(pole に垂直な面)を最初に横切る点を追い込んで返す。
// ascending なら負→正(昇交点)、でなければ正→負(降交点)を探し、無ければ null。
function findCrossing(
  samples: readonly KinematicState[], centerPositionAt: (t: number) => Vec3, pole: Vec3, ascending: boolean,
): KinematicState | null {
  // pole 方向の符号(赤道面のどちら側にいるか)。中心天体はサンプルの時刻の位置を使う — 1点に
  // 固定すると、月のように動く中心天体で区間後半ほど基準がずれて交点を見失う。
  const sideOf = (s: KinematicState): number => {
    const rel = sub(s.r, centerPositionAt(s.t));
    return dot(rel, pole);
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
interface EquatorCrossings {
  readonly ascending: KinematicState | null;
  readonly descending: KinematicState | null;
}

// 時刻順の samples から、昇交点・降交点をそれぞれ独立に探して返す。centerPositionAt は時刻 t の
// 中心天体の位置、pole は赤道面の法線。
export function findEquatorCrossings(
  samples: readonly KinematicState[], centerPositionAt: (t: number) => Vec3, pole: Vec3,
): EquatorCrossings {
  return {
    ascending: findCrossing(samples, centerPositionAt, pole, true),
    descending: findCrossing(samples, centerPositionAt, pole, false),
  };
}
