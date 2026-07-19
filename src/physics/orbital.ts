// 地球中心の二体問題 + 任意の追加加速度(推力など)の RK4 積分と、
// 状態ベクトル → 軌道要素の変換。THREE/DOM 非依存の純粋関数群。
import { Vec3, addScaled, cross, dot, len, norm, rotateAxis, scale, sub, v3 } from './vec3';

export const MU_EARTH = 3.986004418e14; // 地球重力定数 [m^3/s^2]
export const R_EARTH = 6.371e6; // 地球平均半径 [m]
export const SIDEREAL_DAY = 86164.0905; // 恒星日 [s]

export interface OrbitState {
  r: Vec3; // ECI 位置 [m]
  v: Vec3; // ECI 速度 [m/s]
}

// 追加加速度(推力など)。RK4 の各ステージで現在の r, v を渡して評価する。
// out が渡された場合、実装は out に書き込んで out を返してよい(アロケーション回避)。
// out を無視して新規オブジェクトを返す実装も引き続き有効。
export type ExtraAccel = (r: Vec3, v: Vec3, out?: Vec3) => Vec3;

export const J2_EARTH = 1.08262668e-3; // 地球扁平の J2 項
export const R_EARTH_EQ = 6.378137e6; // 赤道半径 [m]

// J2(地球扁平)摂動加速度。極軸 = Y。
// 軌道面に非対称なトルクを与え、昇交点の歳差(LEO 51.6° で約 -5°/日)を生む。
export function j2Accel(r: Vec3): Vec3 {
  return j2AccelInto(v3(), r);
}

// j2Accel のアロケーション回避版: out に書き込んで out を返す
export function j2AccelInto(out: Vec3, r: Vec3): Vec3 {
  const r2 = r.x * r.x + r.y * r.y + r.z * r.z;
  const rl = Math.sqrt(r2);
  const k = (-1.5 * J2_EARTH * MU_EARTH * R_EARTH_EQ * R_EARTH_EQ) / (r2 * r2 * rl); // /r^5
  const f = (5 * r.y * r.y) / r2;
  out.x = k * r.x * (1 - f);
  out.y = k * r.y * (3 - f);
  out.z = k * r.z * (1 - f);
  return out;
}

// 第三体(太陽・月)の潮汐摂動: 機体への直接引力から地球中心への引力を
// 差し引いた差分加速度。a = μ[(ρ/|ρ|³) - (r_b/|r_b|³)], ρ = r_b - r。
export function thirdBodyAccel(r: Vec3, bodyPos: Vec3, mu: number): Vec3 {
  return thirdBodyAccelInto(v3(), r, bodyPos, mu);
}

// thirdBodyAccel のアロケーション回避版: out に「加算」する(合成用)
export function thirdBodyAccelAdd(out: Vec3, r: Vec3, bodyPos: Vec3, mu: number): Vec3 {
  const dx = bodyPos.x - r.x;
  const dy = bodyPos.y - r.y;
  const dz = bodyPos.z - r.z;
  const d3 = Math.pow(dx * dx + dy * dy + dz * dz, 1.5);
  const b3 = Math.pow(
    bodyPos.x * bodyPos.x + bodyPos.y * bodyPos.y + bodyPos.z * bodyPos.z,
    1.5,
  );
  out.x += (mu * dx) / d3 - (mu * bodyPos.x) / b3;
  out.y += (mu * dy) / d3 - (mu * bodyPos.y) / b3;
  out.z += (mu * dz) / d3 - (mu * bodyPos.z) / b3;
  return out;
}

export function thirdBodyAccelInto(out: Vec3, r: Vec3, bodyPos: Vec3, mu: number): Vec3 {
  out.x = 0;
  out.y = 0;
  out.z = 0;
  return thirdBodyAccelAdd(out, r, bodyPos, mu);
}

// stepOrbitRK4 用のモジュール内スクラッチ。RK4 はゲーム内の全エンティティ×
// サブステップで毎フレーム呼ばれる最ホットパスなので、中間ベクトルを再利用して
// 1 ステップあたりのアロケーションをゼロにする(extra が out を無視する実装の場合のみ
// その戻り値ぶんが残る)。stepOrbitRK4 は再入しない前提(同期・単一スレッド)。
const S_A1 = v3(), S_A2 = v3(), S_A3 = v3(), S_A4 = v3();
const S_R = v3(), S_V = v3(), S_E = v3();

// out に 中心重力 + extra を書き込む(out を返す)
function accelInto(out: Vec3, r: Vec3, v: Vec3, extra?: ExtraAccel): Vec3 {
  const d = len(r);
  const k = -MU_EARTH / (d * d * d);
  out.x = r.x * k;
  out.y = r.y * k;
  out.z = r.z * k;
  if (extra) {
    const e = extra(r, v, S_E);
    out.x += e.x;
    out.y += e.y;
    out.z += e.z;
  }
  return out;
}

// 単一エンティティの RK4 1ステップ(中心重力 + 追加加速度)
export function stepOrbitRK4(s: OrbitState, dt: number, extra?: ExtraAccel): void {
  const r0 = s.r;
  const v0 = s.v;
  const h2 = dt / 2;
  accelInto(S_A1, r0, v0, extra);
  // ステージ2: r2 = r0 + v0·h/2, v2 = v0 + a1·h/2
  S_R.x = r0.x + v0.x * h2; S_R.y = r0.y + v0.y * h2; S_R.z = r0.z + v0.z * h2;
  S_V.x = v0.x + S_A1.x * h2; S_V.y = v0.y + S_A1.y * h2; S_V.z = v0.z + S_A1.z * h2;
  const v2x = S_V.x, v2y = S_V.y, v2z = S_V.z;
  accelInto(S_A2, S_R, S_V, extra);
  // ステージ3: r3 = r0 + v2·h/2, v3 = v0 + a2·h/2
  S_R.x = r0.x + v2x * h2; S_R.y = r0.y + v2y * h2; S_R.z = r0.z + v2z * h2;
  S_V.x = v0.x + S_A2.x * h2; S_V.y = v0.y + S_A2.y * h2; S_V.z = v0.z + S_A2.z * h2;
  const v3x = S_V.x, v3y = S_V.y, v3z = S_V.z;
  accelInto(S_A3, S_R, S_V, extra);
  // ステージ4: r4 = r0 + v3·dt, v4 = v0 + a3·dt
  S_R.x = r0.x + v3x * dt; S_R.y = r0.y + v3y * dt; S_R.z = r0.z + v3z * dt;
  S_V.x = v0.x + S_A3.x * dt; S_V.y = v0.y + S_A3.y * dt; S_V.z = v0.z + S_A3.z * dt;
  const v4x = S_V.x, v4y = S_V.y, v4z = S_V.z;
  accelInto(S_A4, S_R, S_V, extra);

  const h6 = dt / 6;
  r0.x += h6 * (v0.x + v4x + 2 * (v2x + v3x));
  r0.y += h6 * (v0.y + v4y + 2 * (v2y + v3y));
  r0.z += h6 * (v0.z + v4z + 2 * (v2z + v3z));
  v0.x += h6 * (S_A1.x + S_A4.x + 2 * (S_A2.x + S_A3.x));
  v0.y += h6 * (S_A1.y + S_A4.y + 2 * (S_A2.y + S_A3.y));
  v0.z += h6 * (S_A1.z + S_A4.z + 2 * (S_A2.z + S_A3.z));
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
