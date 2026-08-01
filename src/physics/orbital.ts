// 地球中心の二体問題 + 任意の追加加速度(推力など)の RK4 積分と、
// 状態ベクトル → 軌道要素の変換。THREE/DOM 非依存の純粋関数群。
import { Vec3, addScaled, cross, dot, len, norm, rotateAxis, scale, sub, v3 } from './vec3';

export const MU_EARTH = 3.986004418e14; // 地球重力定数 [m^3/s^2]
export const R_EARTH = 6.371e6; // 地球平均半径 [m]
export const SIDEREAL_DAY = 86164.0905; // 恒星日 [s]

// ある時刻における位置・速度(エポック付き状態ベクトル)。不変で、進めるときは新しい
// OrbitState を作って差し替える(参照を共有したまま書き換えると、保持側が変化を検知
// できなくなるため)。t を state 自身が持つので「状態」と「その時刻」が引数として
// 分かれて食い違うことがない — 予測点列もエンティティの履歴
// (game-entity/game-entity.ts)も同じこの型で表す。
export type OrbitState = {
  readonly t: number; // 絶対 simTime [s]
  readonly r: Vec3; // ECI 位置 [m]
  readonly v: Vec3; // ECI 速度 [m/s]
} & { readonly __frame: 'inertial'; }

// OrbitState を組み立てる唯一の入口。
export function orbitState(t: number, r: Vec3, v: Vec3): OrbitState {
  return { t, r, v } as OrbitState;
}

// 位置ベクトルから海抜高度を返す。
export function altitudeOf(r: Vec3): number {
  return len(r) - R_EARTH;
}

// 長半径 a の楕円軌道の公転周期 [s]。動径をそのまま渡せば、その高度を回る円軌道の周期
// (= その場の軌道運動の時間スケール)になる。
export function keplerPeriod(a: number): number {
  return 2 * Math.PI * Math.sqrt((a * a * a) / MU_EARTH);
}

// 軌道基底: 進行方向・軌道面法線・面内で進行方向に直交する向きからなる正規直交系。
// radOut が動径外向き r̂ と一致するのは r⊥v のとき(円軌道)だけで、離心軌道では
// 動径から傾く — マーカーの RADIAL OUT/IN や Δv の OUT/IN はこの軸を指す。
export type OrbitalAxes = {
  readonly pro: Vec3; // 進行方向
  readonly nrm: Vec3; // 軌道面法線
  readonly radOut: Vec3; // 面内・進行方向に直交(外向き)
};

// 状態ベクトルから軌道基底を組む。速度または角運動量が縮退していると各軸は NaN になる。
export function orbitalAxes(s: OrbitState): OrbitalAxes {
  const pro = norm(s.v);
  const nrm = norm(cross(s.r, s.v));
  return { pro, nrm, radOut: cross(pro, nrm) };
}

// 軌道基底で表したベクトル(x=pro, y=nrm, z=radOut 成分)をワールド ECI へ変換する。
export function fromOrbitalAxes(s: OrbitState, x: Vec3): Vec3 {
  const { pro, nrm, radOut } = orbitalAxes(s);
  return v3(
    pro.x * x.x + nrm.x * x.y + radOut.x * x.z,
    pro.y * x.x + nrm.y * x.y + radOut.y * x.z,
    pro.z * x.x + nrm.z * x.y + radOut.z * x.z,
  );
}

// 2状態間の3次エルミート補間。両端の位置を通り、両端の速度を接線とする3次多項式で
// 時刻 t の位置を、その微分で速度を求める(粗いサンプル列でも軌道を滑らかに再現できる)。
// a.t > b.t(逆順)でも同じ多項式が定まるので、順序は問わない。
// allowExtrapolation は区間外の t を許可する。多項式は区間外で急速に発散し、軌道として
// 破綻した状態(地球内部の位置、脱出速度を超える速度など)を平然と返すため、既定では
// 禁止する。呼び出し側が短い外挿と分かったうえで使う場合のみ true にすること。
export function hermiteInterpolate(
  a: OrbitState,
  b: OrbitState,
  t: number,
  allowExtrapolation = false,
): OrbitState {
  const h = b.t - a.t;
  if (h === 0) throw new Error(`hermiteInterpolate: 両端が同時刻 (t=${a.t}) で補間できない`);
  if (!allowExtrapolation && (t - a.t) * (t - b.t) > 0) {
    throw new Error(
      `hermiteInterpolate: t=${t} が区間 [${a.t}, ${b.t}] の外(外挿するなら allowExtrapolation=true)`,
    );
  }

  const s = (t - a.t) / h;
  const s2 = s * s;
  const s3 = s2 * s;
  // 位置の基底(a.r, a.v, b.r, b.v の順)と、その s 微分
  const w = [2 * s3 - 3 * s2 + 1, s3 - 2 * s2 + s, -2 * s3 + 3 * s2, s3 - s2];
  const dw = [6 * s2 - 6 * s, 3 * s2 - 4 * s + 1, -6 * s2 + 6 * s, 3 * s2 - 2 * s];

  const combine = (wr0: number, wv0: number, wr1: number, wv1: number): Vec3 => v3(
    wr0 * a.r.x + wv0 * a.v.x + wr1 * b.r.x + wv1 * b.v.x,
    wr0 * a.r.y + wv0 * a.v.y + wr1 * b.r.y + wv1 * b.v.y,
    wr0 * a.r.z + wv0 * a.v.z + wr1 * b.r.z + wv1 * b.v.z,
  );

  return orbitState(
    t,
    combine(w[0]!, w[1]! * h, w[2]!, w[3]! * h),
    combine(dw[0]! / h, dw[1]!, dw[2]! / h, dw[3]!),
  );
}

// 追加加速度(推力・大気抵抗・J2・第三体摂動など)を状態の関数として渡すためのコールバック。
// RK4 の各中間段(k1〜k4)ごとに呼ばれる。
export type ExtraAccelFn = (rx: number, ry: number, rz: number, vx: number, vy: number, vz: number) => Vec3;

export const J2_EARTH = 1.08262668e-3; // 地球扁平の J2 項
export const R_EARTH_EQ = 6.378137e6; // 赤道半径 [m]

// J2(地球扁平)摂動加速度。極軸 = Y。
// 軌道面に非対称なトルクを与え、昇交点の歳差(LEO 51.6° で約 -5°/日)を生む。
export function j2Accel(r: Vec3): Vec3 {
  const r2 = r.x * r.x + r.y * r.y + r.z * r.z;
  const rl = Math.sqrt(r2);
  const k = (-1.5 * J2_EARTH * MU_EARTH * R_EARTH_EQ * R_EARTH_EQ) / (r2 * r2 * rl); // /r^5
  const f = (5 * r.y * r.y) / r2;
  return v3(k * r.x * (1 - f), k * r.y * (3 - f), k * r.z * (1 - f));
}

// 第三体(太陽・月)の潮汐摂動: 機体への直接引力から地球中心への引力を
// 差し引いた差分加速度。a = μ[(ρ/|ρ|³) - (r_b/|r_b|³)], ρ = r_b - r。
export function thirdBodyAccel(r: Vec3, bodyPos: Vec3, mu: number): Vec3 {
  // ρ = bodyPos - r
  const dx = bodyPos.x - r.x;
  const dy = bodyPos.y - r.y;
  const dz = bodyPos.z - r.z;
  const d3 = Math.pow(dx * dx + dy * dy + dz * dz, 1.5);
  const b3 = Math.pow(
    bodyPos.x * bodyPos.x + bodyPos.y * bodyPos.y + bodyPos.z * bodyPos.z,
    1.5,
  );
  // μ(ρ/|ρ|³ − r_b/|r_b|³)
  return v3(
    (mu * dx) / d3 - (mu * bodyPos.x) / b3,
    (mu * dy) / d3 - (mu * bodyPos.y) / b3,
    (mu * dz) / d3 - (mu * bodyPos.z) / b3,
  );
}

// 単一エンティティの RK4 1ステップ(中心重力 + 追加加速度)。
// 入力 s は書き換えず、時刻も dt だけ進めた新しい OrbitState を返す。
export function stepOrbitRK4(s: OrbitState, dt: number, extraAccel?: ExtraAccelFn): OrbitState {
  const r0x = s.r.x, r0y = s.r.y, r0z = s.r.z;
  const v0x = s.v.x, v0y = s.v.y, v0z = s.v.z;
  const h2 = dt / 2;
  const h6 = dt / 6;

  const outA = { ax: 0, ay: 0, az: 0 };

  // 位置・速度から加速度(中心重力 + 追加加速度)を求め、outA に書き込む。
  const computeA = (rx: number, ry: number, rz: number, vx: number, vy: number, vz: number) => {
    // 中心重力加速度
    const d2 = rx * rx + ry * ry + rz * rz;
    const d = Math.sqrt(d2);
    const k = -MU_EARTH / (d2 * d);
    outA.ax = rx * k;
    outA.ay = ry * k;
    outA.az = rz * k;
    // 追加加速度を合算
    if (extraAccel) {
      const a = extraAccel(rx, ry, rz, vx, vy, vz);
      outA.ax += a.x;
      outA.ay += a.y;
      outA.az += a.z;
    }
  };

  // k1
  const kr1x = v0x, kr1y = v0y, kr1z = v0z;
  computeA(r0x, r0y, r0z, v0x, v0y, v0z);
  const kv1x = outA.ax, kv1y = outA.ay, kv1z = outA.az;

  // k2
  const r2x = r0x + kr1x * h2, r2y = r0y + kr1y * h2, r2z = r0z + kr1z * h2;
  const v2x = v0x + kv1x * h2, v2y = v0y + kv1y * h2, v2z = v0z + kv1z * h2;
  const kr2x = v2x, kr2y = v2y, kr2z = v2z;
  computeA(r2x, r2y, r2z, v2x, v2y, v2z);
  const kv2x = outA.ax, kv2y = outA.ay, kv2z = outA.az;

  // k3
  const r3x = r0x + kr2x * h2, r3y = r0y + kr2y * h2, r3z = r0z + kr2z * h2;
  const v3x = v0x + kv2x * h2, v3y = v0y + kv2y * h2, v3z = v0z + kv2z * h2;
  const kr3x = v3x, kr3y = v3y, kr3z = v3z;
  computeA(r3x, r3y, r3z, v3x, v3y, v3z);
  const kv3x = outA.ax, kv3y = outA.ay, kv3z = outA.az;

  // k4
  const r4x = r0x + kr3x * dt, r4y = r0y + kr3y * dt, r4z = r0z + kr3z * dt;
  const v4x = v0x + kv3x * dt, v4y = v0y + kv3y * dt, v4z = v0z + kv3z * dt;
  const kr4x = v4x, kr4y = v4y, kr4z = v4z;
  computeA(r4x, r4y, r4z, v4x, v4y, v4z);
  const kv4x = outA.ax, kv4y = outA.ay, kv4z = outA.az;

  return orbitState(
    s.t + dt,
    v3(
      r0x + h6 * (kr1x + kr4x + 2 * (kr2x + kr3x)),
      r0y + h6 * (kr1y + kr4y + 2 * (kr2y + kr3y)),
      r0z + h6 * (kr1z + kr4z + 2 * (kr2z + kr3z))
    ),
    v3(
      v0x + h6 * (kv1x + kv4x + 2 * (kv2x + kv3x)),
      v0y + h6 * (kv1y + kv4y + 2 * (kv2y + kv3y)),
      v0z + h6 * (kv1z + kv4z + 2 * (kv2z + kv3z))
    )
  );
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

// 位置・速度から古典軌道要素を求める。半径・角運動量が縮退している場合は null。
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
    period: elliptic ? keplerPeriod(a) : NaN,
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

// 近点通過からの経過時間 [s]。
// 楕円(e < 1): ケプラー方程式、[-T/2, T/2]。
// 双曲線(e >= 1): 双曲線ケプラー方程式。tan(nu/2) が漸近線を超える(その真近点角に
// 到達しない)場合は有限の到達時刻が存在しないため NaN を返す。
export function timeSincePeriapsis(el: Elements, nu: number): number {
  if (el.e < 1) {
    const E = 2 * Math.atan2(Math.sqrt(1 - el.e) * Math.sin(nu / 2), Math.sqrt(1 + el.e) * Math.cos(nu / 2));
    const M = E - el.e * Math.sin(E);
    return M / Math.sqrt(MU_EARTH / (el.a * el.a * el.a));
  }

  // 双曲線離心近点角 H = 2 * atanh( sqrt((e-1)/(e+1)) * tan(nu/2) )
  const x = Math.sqrt((el.e - 1) / (el.e + 1)) * Math.tan(nu / 2);
  if (Math.abs(x) >= 1) return NaN; // 漸近線を超えており、その nu には到達しない
  const H = 2 * Math.atanh(x);
  const M = el.e * Math.sinh(H) - H; // 双曲線ケプラー方程式
  return M / Math.sqrt(MU_EARTH / (-el.a * -el.a * -el.a)); // a < 0 なので -a > 0
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
  const k = Math.sqrt(MU_EARTH / el.p);
  return addScaled(scale(el.pHat, -k * Math.sin(nu)), el.qHat, k * (el.e + Math.cos(nu)));
}

// 古典的軌道要素 → 時刻 t の状態ベクトル(Y = 北極)。角度はすべて [rad]。
export function stateFromElements(
  t: number,
  a: number,
  e: number,
  inc: number,
  raan: number,
  argp: number,
  nu: number,
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
  const k = Math.sqrt(MU_EARTH / p);
  return orbitState(
    t,
    addScaled(scale(pHat, r * Math.cos(nu)), qHat, r * Math.sin(nu)),
    addScaled(scale(pHat, -k * Math.sin(nu)), qHat, k * (e + Math.cos(nu))),
  );
}
