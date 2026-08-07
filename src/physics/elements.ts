// 古典軌道要素(Elements)の定義と、状態ベクトル⇄要素の変換・要素上のケプラー幾何。
// 軌道要素は「どの天体を中心に取ったか」まで含めて初めて意味が定まるため、Elements 自身が
// 中心天体(Attractor)を保持する。THREE/DOM 非依存の純粋関数群。
import type { Attractor } from './attractor';
import { OrbitState, orbitState } from './orbital-state';
import { Vec3, addScaled, cross, dot, len, norm, rotateAxis, scale, sub, v3 } from './vec3';

export interface Elements {
  a: number; // 軌道長半径 [m] (双曲線では負)
  e: number; // 離心率
  p: number; // 半直弦 [m]
  incDeg: number; // 軌道傾斜角 [deg] (Y軸 = 北極)
  period: number; // 公転周期 [s] (楕円のみ)
  pHat: Vec3; // 近地点方向(軌道面内)
  qHat: Vec3; // pHat と直交する軌道面内方向
  hHat: Vec3; // 軌道面法線
  center: Attractor; // 中心天体
}

// 長半径 a の楕円軌道の公転周期 [s]。動径をそのまま渡せば、その高度を回る円軌道の周期
// (= その場の軌道運動の時間スケール)になる。mu は主天体の重力定数 — 地球中心なら
// MU_EARTH、月中心など別の主天体まわりの周期を求める場合はその天体の値を渡す。
export function keplerPeriod(a: number, mu: number): number {
  return 2 * Math.PI * Math.sqrt((a * a * a) / mu);
}

// keplerPeriod の逆関数: 公転周期 T から長半径を求める唯一の変換点。
export function semiMajorFromPeriod(period: number, mu: number): number {
  return Math.cbrt((mu * period * period) / (4 * Math.PI * Math.PI));
}

// 中心天体相対の状態から古典軌道要素を求める。rel は center 相対(center 自身の位置・速度を
// 差し引いた後)の状態ベクトルでなければならない — 絶対 ECI 座標をそのまま渡すと、center が
// 原点(地球)でない限り誤った要素になる。呼び出しは attractor.ts の elementsAround(絶対 ECI
// から center 相対へ変換したうえでこれを呼ぶ)に一本化されており、この関数自体は他モジュールへ
// export しない。半径・角運動量が縮退している場合は null。
export function elementsFromState(rel: OrbitState, center: Attractor): Elements | null {
  const r = rel.r;
  const v = rel.v;
  const mu = center.mu;
  const rMag = len(r);
  if (rMag < 1) return null;
  const h = cross(r, v);
  const hMag = len(h);
  if (hMag < 1) return null;

  // 離心率ベクトル e = (v×h)/μ - r̂
  const eVec = sub(scale(cross(v, h), 1 / mu), scale(r, 1 / rMag));
  const e = len(eVec);
  const energy = dot(v, v) / 2 - mu / rMag;
  const p = (hMag * hMag) / mu;
  const a = Math.abs(energy) > 1e-12 ? -mu / (2 * energy) : Infinity;

  const hHat = norm(h);
  const pHat = e > 1e-8 ? norm(eVec) : norm(r);
  const qHat = cross(hHat, pHat);
  const incDeg = (Math.acos(Math.max(-1, Math.min(1, hHat.y))) * 180) / Math.PI;

  const elliptic = e < 1 && isFinite(a) && a > 0;
  return {
    a,
    e,
    p,
    incDeg,
    period: elliptic ? keplerPeriod(a, mu) : NaN,
    pHat,
    qHat,
    hHat,
    center,
  };
}

// 中心天体表面からの近地点・遠地点高度。遠地点は楕円軌道のみ(双曲線・放物線は NaN)。
export function apsisAltitudes(el: Elements): { pe: number; ap: number } {
  const bodyRadius = el.center.radius;
  return {
    pe: el.p / (1 + el.e) - bodyRadius,
    ap: el.e < 1 && isFinite(el.a) ? el.a * (1 + el.e) - bodyRadius : NaN,
  };
}

// --- マニューバ計画用のケプラー補助関数(楕円軌道のみ) ---

// 位置ベクトル r の真近点角(pHat 基準、[-π, π])
export function trueAnomalyAt(el: Elements, r: Vec3): number {
  return Math.atan2(dot(r, el.qHat), dot(r, el.pHat));
}

// 近点通過からの経過時間 [s]。
// 楕円(e < 1): ケプラー方程式、[-T/2, T/2]。
// 双曲線(e >= 1): 双曲線ケプラー方程式。tan(nu/2) が漸近線を超える(その真近点角に
// 到達しない)場合は有限の到達時刻が存在しないため NaN を返す。
export function timeSincePeriapsis(el: Elements, nu: number): number {
  if (el.e < 1) {
    const E = 2 * Math.atan2(Math.sqrt(1 - el.e) * Math.sin(nu / 2), Math.sqrt(1 + el.e) * Math.cos(nu / 2));
    const M = E - el.e * Math.sin(E);
    return M / Math.sqrt(el.center.mu / (el.a * el.a * el.a));
  }

  // 双曲線離心近点角 H = 2 * atanh( sqrt((e-1)/(e+1)) * tan(nu/2) )
  const x = Math.sqrt((el.e - 1) / (el.e + 1)) * Math.tan(nu / 2);
  if (Math.abs(x) >= 1) return NaN; // 漸近線を超えており、その nu には到達しない
  const H = 2 * Math.atanh(x);
  const M = el.e * Math.sinh(H) - H; // 双曲線ケプラー方程式
  return M / Math.sqrt(el.center.mu / (-el.a * -el.a * -el.a)); // a < 0 なので -a > 0
}

// 真近点角 nu0 → nu1 への飛行時間 [s]。
// 楕円(e < 1、周期あり): 順行方向に周期で畳んで [0, T) に正規化する。
// 双曲線(e >= 1、周期なし): 畳まず単純差分をそのまま返す。
export function tofBetween(el: Elements, nu0: number, nu1: number): number {
  const t = timeSincePeriapsis(el, nu1) - timeSincePeriapsis(el, nu0);
  if (el.e >= 1) return t;
  return ((t % el.period) + el.period) % el.period;
}

// 軌道上の真近点角 nu における ECI 位置
export function positionOnOrbit(el: Elements, nu: number): Vec3 {
  const r = el.p / (1 + el.e * Math.cos(nu));
  return addScaled(scale(el.pHat, r * Math.cos(nu)), el.qHat, r * Math.sin(nu));
}

// 軌道上の真近点角 nu における ECI 速度
export function velocityOnOrbit(el: Elements, nu: number): Vec3 {
  const k = Math.sqrt(el.center.mu / el.p);
  return addScaled(scale(el.pHat, -k * Math.sin(nu)), el.qHat, k * (el.e + Math.cos(nu)));
}

// 古典的軌道要素 → 時刻 t の状態ベクトル(Y = 北極)。角度はすべて [rad]。mu は主天体の
// 重力定数 — 月中心の要素から状態を組む場合など地球以外が主天体のときはその値を渡す
// (その場合の r/v は主天体中心の相対値であり、絶対 ECI 化は呼び出し側が主天体の位置・速度を
// 加えて行う)。
export function stateFromElements(
  t: number,
  a: number,
  e: number,
  inc: number,
  raan: number,
  argp: number,
  nu: number,
  mu: number,
): OrbitState {
  const Y = v3(0, 1, 0);
  // 軌道面の基底を昇交点・傾斜角・近点引数の順に組み立てる
  const node = rotateAxis(v3(1, 0, 0), Y, raan); // 昇交点方向
  const hHat = rotateAxis(Y, node, inc); // 軌道面法線
  const pHat = rotateAxis(node, hHat, argp); // 近点方向
  const qHat = cross(hHat, pHat);
  // 真近点角 nu における位置半径
  const p = a * (1 - e * e);
  const r = p / (1 + e * Math.cos(nu));
  const k = Math.sqrt(mu / p);
  return orbitState(
    t,
    addScaled(scale(pHat, r * Math.cos(nu)), qHat, r * Math.sin(nu)),
    addScaled(scale(pHat, -k * Math.sin(nu)), qHat, k * (e + Math.cos(nu))),
  );
}
