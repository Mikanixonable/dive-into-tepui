// 地球中心の二体問題 + 任意の追加加速度(推力など)の RK4 積分と、
// 状態ベクトル → 軌道要素の変換。THREE/DOM 非依存の純粋関数群。
import { Vec3, add, addScaled, cross, dot, len, norm, rotateAxis, scale, sub, v3 } from './vec3';

export const MU_EARTH = 3.986004418e14; // 地球重力定数 [m^3/s^2]
export const R_EARTH = 6.371e6; // 地球平均半径 [m]
export const SIDEREAL_DAY = 86164.0905; // 恒星日 [s]

export interface OrbitState {
  r: Vec3; // ECI 位置 [m]
  v: Vec3; // ECI 速度 [m/s]
}

// 追加加速度(推力など)。RK4 の各ステージで現在の r, v を渡して評価する。
export type ExtraAccel = (r: Vec3, v: Vec3) => Vec3;

export const J2_EARTH = 1.08262668e-3; // 地球扁平の J2 項
export const R_EARTH_EQ = 6.378137e6; // 赤道半径 [m]

// J2(地球扁平)摂動加速度。極軸 = Y。
// 軌道面に非対称なトルクを与え、昇交点の歳差(LEO 51.6° で約 -5°/日)を生む。
export function j2Accel(r: Vec3): Vec3 {
  const r2 = r.x * r.x + r.y * r.y + r.z * r.z;
  const rl = Math.sqrt(r2);
  const k = (-1.5 * J2_EARTH * MU_EARTH * R_EARTH_EQ * R_EARTH_EQ) / (r2 * r2 * rl); // /r^5
  const f = (5 * r.y * r.y) / r2;
  return { x: k * r.x * (1 - f), y: k * r.y * (3 - f), z: k * r.z * (1 - f) };
}

// 第三体(太陽・月)の潮汐摂動: 機体への直接引力から地球中心への引力を
// 差し引いた差分加速度。a = μ[(ρ/|ρ|³) - (r_b/|r_b|³)], ρ = r_b - r。
export function thirdBodyAccel(r: Vec3, bodyPos: Vec3, mu: number): Vec3 {
  const dx = bodyPos.x - r.x;
  const dy = bodyPos.y - r.y;
  const dz = bodyPos.z - r.z;
  const d3 = Math.pow(dx * dx + dy * dy + dz * dz, 1.5);
  const b3 = Math.pow(
    bodyPos.x * bodyPos.x + bodyPos.y * bodyPos.y + bodyPos.z * bodyPos.z,
    1.5,
  );
  return {
    x: (mu * dx) / d3 - (mu * bodyPos.x) / b3,
    y: (mu * dy) / d3 - (mu * bodyPos.y) / b3,
    z: (mu * dz) / d3 - (mu * bodyPos.z) / b3,
  };
}

function accel(r: Vec3, v: Vec3, extra?: ExtraAccel): Vec3 {
  const d = len(r);
  const k = -MU_EARTH / (d * d * d);
  const a = scale(r, k);
  if (extra) {
    const e = extra(r, v);
    a.x += e.x;
    a.y += e.y;
    a.z += e.z;
  }
  return a;
}

// 単一エンティティの RK4 1ステップ(中心重力 + 追加加速度)
export function stepOrbitRK4(s: OrbitState, dt: number, extra?: ExtraAccel): void {
  const r0 = s.r;
  const v0 = s.v;
  const a1 = accel(r0, v0, extra);
  const r2 = addScaled(r0, v0, dt / 2);
  const v2 = addScaled(v0, a1, dt / 2);
  const a2 = accel(r2, v2, extra);
  const r3 = addScaled(r0, v2, dt / 2);
  const v3 = addScaled(v0, a2, dt / 2);
  const a3 = accel(r3, v3, extra);
  const r4 = addScaled(r0, v3, dt);
  const v4 = addScaled(v0, a3, dt);
  const a4 = accel(r4, v4, extra);

  s.r = addScaled(r0, add(add(v0, v4), scale(add(v2, v3), 2)), dt / 6);
  s.v = addScaled(v0, add(add(a1, a4), scale(add(a2, a3), 2)), dt / 6);
}

export interface Elements {
  a: number; // 軌道長半径 [m] (双曲線では負)
  e: number; // 離心率
  p: number; // 半直弦 [m]
  incDeg: number; // 軌道傾斜角 [deg] (Y軸 = 北極)
  apAlt: number; // 遠地点高度 [m] (楕円のみ、双曲線は NaN)
  peAlt: number; // 近地点高度 [m]
  period: number; // 公転周期 [s] (楕円のみ)
  pHat: Vec3; // 近地点方向(軌道面内)
  qHat: Vec3; // pHat と直交する軌道面内方向
  hHat: Vec3; // 軌道面法線
}

export function elementsFromState(r: Vec3, v: Vec3): Elements | null {
  const rMag = len(r);
  if (rMag < 1) return null;
  const h = cross(r, v);
  const hMag = len(h);
  if (hMag < 1) return null;

  // 離心率ベクトル e = (v×h)/μ - r̂
  const eVec = sub(scale(cross(v, h), 1 / MU_EARTH), scale(r, 1 / rMag));
  const e = len(eVec);
  const energy = dot(v, v) / 2 - MU_EARTH / rMag;
  const p = (hMag * hMag) / MU_EARTH;
  const a = Math.abs(energy) > 1e-12 ? -MU_EARTH / (2 * energy) : Infinity;

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
    apAlt: elliptic ? a * (1 + e) - R_EARTH : NaN,
    peAlt: p / (1 + e) - R_EARTH,
    period: elliptic ? 2 * Math.PI * Math.sqrt((a * a * a) / MU_EARTH) : NaN,
    pHat,
    qHat,
    hHat,
  };
}

// --- マニューバ計画用のケプラー補助関数(楕円軌道のみ) ---

// 位置ベクトル r の真近点角(pHat 基準、[-π, π])
export function trueAnomalyAt(el: Elements, r: Vec3): number {
  return Math.atan2(dot(r, el.qHat), dot(r, el.pHat));
}

// 近点通過からの経過時間 [s](ケプラー方程式、[-T/2, T/2])
export function timeSincePeriapsis(el: Elements, nu: number): number {
  const E = 2 * Math.atan2(Math.sqrt(1 - el.e) * Math.sin(nu / 2), Math.sqrt(1 + el.e) * Math.cos(nu / 2));
  const M = E - el.e * Math.sin(E);
  return M / Math.sqrt(MU_EARTH / (el.a * el.a * el.a));
}

// 真近点角 nu0 → nu1 への飛行時間 [s](順行方向、[0, T))
export function tofBetween(el: Elements, nu0: number, nu1: number): number {
  const t = timeSincePeriapsis(el, nu1) - timeSincePeriapsis(el, nu0);
  return ((t % el.period) + el.period) % el.period;
}

// 軌道上の真近点角 nu における ECI 位置
export function positionOnOrbit(el: Elements, nu: number): Vec3 {
  const r = el.p / (1 + el.e * Math.cos(nu));
  return addScaled(scale(el.pHat, r * Math.cos(nu)), el.qHat, r * Math.sin(nu));
}

// 軌道上の真近点角 nu における ECI 速度
export function velocityOnOrbit(el: Elements, nu: number): Vec3 {
  const k = Math.sqrt(MU_EARTH / el.p);
  return addScaled(scale(el.pHat, -k * Math.sin(nu)), el.qHat, k * (el.e + Math.cos(nu)));
}

// 古典的軌道要素 → 状態ベクトル(Y = 北極)。角度はすべて [rad]。
export function stateFromElements(
  a: number,
  e: number,
  inc: number,
  raan: number,
  argp: number,
  nu: number,
): OrbitState {
  const Y = v3(0, 1, 0);
  const node = rotateAxis(v3(1, 0, 0), Y, raan); // 昇交点方向
  const hHat = rotateAxis(Y, node, inc); // 軌道面法線
  const pHat = rotateAxis(node, hHat, argp); // 近点方向
  const qHat = cross(hHat, pHat);
  const p = a * (1 - e * e);
  const r = p / (1 + e * Math.cos(nu));
  const k = Math.sqrt(MU_EARTH / p);
  return {
    r: addScaled(scale(pHat, r * Math.cos(nu)), qHat, r * Math.sin(nu)),
    v: addScaled(scale(pHat, -k * Math.sin(nu)), qHat, k * (e + Math.cos(nu))),
  };
}
