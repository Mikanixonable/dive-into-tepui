// 地球中心の二体問題 + 任意の追加加速度(推力など)の RK4 積分と、
// 状態ベクトル → 軌道要素の変換。THREE/DOM 非依存の純粋関数群。
import { Vec3, add, addScaled, cross, dot, len, norm, scale, sub } from './vec3';

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

// 楕円軌道を離心近点角 E で一様サンプリングして ECI 座標列を返す (e < 1 のみ)。
// 真近点角で一様サンプリングすると近地点付近に点が偏り、遠地点付近では
// 弦が長くなって表示が荒くなる(離心率が大きいほど顕著)。E で一様に取ると
// 弧長方向によりバランス良く点が分布し、遠地点付近の粗さが解消される。
export function sampleOrbit(el: Elements, count: number, out: Vec3[]): boolean {
  if (el.e >= 0.98 || !isFinite(el.a) || el.a <= 0) return false;
  const b = el.a * Math.sqrt(1 - el.e * el.e);
  for (let i = 0; i < count; i++) {
    const E = (i / count) * Math.PI * 2;
    const x = el.a * (Math.cos(E) - el.e);
    const y = b * Math.sin(E);
    const pt = out[i] ?? (out[i] = { x: 0, y: 0, z: 0 });
    pt.x = el.pHat.x * x + el.qHat.x * y;
    pt.y = el.pHat.y * x + el.qHat.y * y;
    pt.z = el.pHat.z * x + el.qHat.z * y;
  }
  return true;
}
