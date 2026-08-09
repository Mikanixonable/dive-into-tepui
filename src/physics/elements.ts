// 古典軌道要素(OrbitalElements)の定義と、状態ベクトル⇄要素の変換・要素上のケプラー幾何。
// 軌道要素は「どの天体を中心に取ったか」まで含めて初めて意味が定まるため、OrbitalElements 自身が
// 中心天体(Attractor)を保持する。THREE/DOM 非依存の純粋関数群。
import type { Attractor } from './attractor';
import { KinematicState, kinematicState } from './kinematic-state';
import { Vec3, addScaled, cross, dot, len, norm, rotateAxis, scale, sub, v3 } from './vec3';

export interface OrbitalElements {
  a: number; // 軌道長半径 [m] (双曲線では負)
  e: number; // 離心率
  p: number; // 半直弦 [m]
  incDeg: number; // 軌道傾斜角 [deg] (Y軸 = 北極)
  period: number; // 公転周期 [s] (楕円のみ)
  pHat: Vec3; // 近地点方向(軌道面内)
  qHat: Vec3; // pHat と直交する軌道面内方向
  hHat: Vec3; // 軌道面法線
  center: Attractor; // 中心天体。楕円をどの天体位置へ描画すべきかもこれで決まる。
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
// 原点(地球)でない限り誤った要素になる。絶対 ECI からの呼び出しは attractor.ts の
// orbitalElementsOf に一本化する。半径・角運動量が縮退している場合は null。
export function orbitalElementsFromState(rel: KinematicState, center: Attractor): OrbitalElements | null {
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
export function apsisAltitudes(el: OrbitalElements): { pe: number; ap: number } {
  const centerRadius = el.center.radius;
  return {
    pe: el.p / (1 + el.e) - centerRadius,
    ap: el.e < 1 && isFinite(el.a) ? el.a * (1 + el.e) - centerRadius : NaN,
  };
}

// 平均近点角 M → 離心近点角 E(ケプラー方程式 M = E − e sin E をニュートン法で解く。楕円のみ)。
export function eccentricAnomalyFromMean(m: number, e: number): number {
  const M = Math.atan2(Math.sin(m), Math.cos(m)); // [-π, π] へ畳んで初期値 E=M の収束を安定させる
  let E = e > 0.8 ? Math.PI * Math.sign(M || 1) : M; // 高離心率では M≈0 付近で E=M 初期値だと Newton 法が収束しない/振動するため、M と同じ側の ±π から始める

  for (let i = 0; i < 50; i++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-14) break;
  }
  return E;
}

// 平均近点角 M → 真近点角 ν。timeSincePeriapsis(真近点角→時刻)の逆方向。
export function trueAnomalyFromMean(m: number, e: number): number {
  const E = eccentricAnomalyFromMean(m, e);
  return 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
}

// --- マニューバ計画用のケプラー補助関数(楕円軌道のみ) ---

// 位置ベクトル r の真近点角(pHat 基準、[-π, π])
export function trueAnomalyAt(el: OrbitalElements, r: Vec3): number {
  return Math.atan2(dot(r, el.qHat), dot(r, el.pHat));
}

// 軌道 el が法線 planeNormal の平面を横切る昇交点・降交点の真近点角。交点線の方向は
// planeNormal × el.hHat(昇交点を指す向き)。両面がほぼ一致し交線の向きが定まらない場合は null。
export function nodeAnomalies(el: OrbitalElements, planeNormal: Vec3): { asc: number; desc: number } | null {
  const lineDir = cross(planeNormal, el.hHat);
  if (dot(lineDir, lineDir) < 1e-6) return null;
  const d = norm(lineDir);
  const asc = Math.atan2(dot(d, el.qHat), dot(d, el.pHat));
  return { asc, desc: asc + Math.PI };
}

// 近点通過からの経過時間 [s]。
// 楕円(e < 1): ケプラー方程式、[-T/2, T/2]。
// 双曲線(e >= 1): 双曲線ケプラー方程式。tan(nu/2) が漸近線を超える(その真近点角に
// 到達しない)場合は有限の到達時刻が存在しないため NaN を返す。
export function timeSincePeriapsis(el: OrbitalElements, nu: number): number {
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
export function tofBetween(el: OrbitalElements, nu0: number, nu1: number): number {
  const t = timeSincePeriapsis(el, nu1) - timeSincePeriapsis(el, nu0);
  if (el.e >= 1) return t;
  return ((t % el.period) + el.period) % el.period;
}

// 軌道上の真近点角 nu における ECI 位置
export function positionOnOrbit(el: OrbitalElements, nu: number): Vec3 {
  const r = el.p / (1 + el.e * Math.cos(nu));
  return addScaled(scale(el.pHat, r * Math.cos(nu)), el.qHat, r * Math.sin(nu));
}

// 軌道上の真近点角 nu における ECI 速度
export function velocityOnOrbit(el: OrbitalElements, nu: number): Vec3 {
  const k = Math.sqrt(el.center.mu / el.p);
  return addScaled(scale(el.pHat, -k * Math.sin(nu)), el.qHat, k * (el.e + Math.cos(nu)));
}

// 軌道面の基底(近点方向 pHat と、軌道面内でそれに直交する qHat)を昇交点黄経・傾斜角・
// 近点引数から組む(Y = 北極)。角度はすべて [rad]。
function orbitPlaneBasis(inc: number, raan: number, argp: number): { pHat: Vec3; qHat: Vec3 } {
  const Y = v3(0, 1, 0);
  const node = rotateAxis(v3(1, 0, 0), Y, raan); // 昇交点方向
  const hHat = rotateAxis(Y, node, inc); // 軌道面法線
  const pHat = rotateAxis(node, hHat, argp); // 近点方向
  return { pHat, qHat: cross(hHat, pHat) };
}

// 古典的軌道要素 → 時刻 t の位置(Y = 北極)。角度はすべて [rad]。主天体中心の相対位置で、
// 絶対 ECI 化は呼び出し側が主天体の位置を加えて行う。
export function positionFromOrbitalElements(
  a: number, e: number, inc: number, raan: number, argp: number, nu: number,
): Vec3 {
  const { pHat, qHat } = orbitPlaneBasis(inc, raan, argp);
  const r = (a * (1 - e * e)) / (1 + e * Math.cos(nu));
  return addScaled(scale(pHat, r * Math.cos(nu)), qHat, r * Math.sin(nu));
}

// 古典的軌道要素 → 時刻 t の状態ベクトル(Y = 北極)。角度はすべて [rad]。mu は主天体の
// 重力定数 — 月中心の要素から状態を組む場合など地球以外が主天体のときはその値を渡す
// (その場合の r/v は主天体中心の相対値であり、絶対 ECI 化は呼び出し側が主天体の位置・速度を
// 加えて行う)。
export function stateFromOrbitalElements(
  t: number,
  a: number,
  e: number,
  inc: number,
  raan: number,
  argp: number,
  nu: number,
  mu: number,
): KinematicState {
  const { pHat, qHat } = orbitPlaneBasis(inc, raan, argp);
  const p = a * (1 - e * e);
  const k = Math.sqrt(mu / p);
  return kinematicState(
    t,
    positionFromOrbitalElements(a, e, inc, raan, argp, nu),
    addScaled(scale(pHat, -k * Math.sin(nu)), qHat, k * (e + Math.cos(nu))),
  );
}
