// 状態ベクトル(KinematicState)そのものの定義と、それだけで完結する幾何演算(高度・軌道基底・
// エルミート補間)。地球の物理定数もここに置く。THREE/DOM 非依存の純粋関数群。
import { Vec3, cross, len, norm, v3 } from './vec3';

export const MU_EARTH = 3.986004418e14; // 地球重力定数 [m^3/s^2]
export const R_EARTH = 6.371e6; // 地球平均半径 [m]
export const R_EARTH_EQ = 6.378137e6; // 赤道半径 [m]
export const SIDEREAL_DAY = 86164.0905; // 恒星日 [s]

// ある時刻における位置・速度(エポック付き状態ベクトル)。不変で、進めるときは新しい
// KinematicState を作って差し替える(参照を共有したまま書き換えると、保持側が変化を検知
// できなくなるため)。t を state 自身が持つので「状態」と「その時刻」が引数として
// 分かれて食い違うことがない — 予測点列もエンティティの履歴
// (game-entity/game-entity.ts)も同じこの型で表す。
export type KinematicState = {
  readonly t: number; // 絶対 simTime [s]
  readonly r: Vec3; // ECI 位置 [m]
  readonly v: Vec3; // ECI 速度 [m/s]
} & { readonly __frame: 'inertial'; }

// KinematicState を組み立てる唯一の入口。
export function kinematicState(t: number, r: Vec3, v: Vec3): KinematicState {
  return { t, r, v } as KinematicState;
}

// 位置ベクトルから海抜高度を返す。
export function altitudeOf(r: Vec3): number {
  return len(r) - R_EARTH;
}

// 軌道基底: 進行方向・軌道面法線・面内で進行方向に直交する向きからなる正規直交系。
// radOut が動径外向き r̂ と一致するのは r⊥v のとき(円軌道)だけで、離心軌道では
// 動径から傾く — マーカーの RADIAL OUT/IN や Δv の OUT/IN はこの軸を指す。
export type OrbitAxes = {
  readonly pro: Vec3; // 進行方向
  readonly nrm: Vec3; // 軌道面法線
  readonly radOut: Vec3; // 面内・進行方向に直交(外向き)
};

// 状態ベクトルから軌道基底を組む。速度または角運動量が縮退していると各軸は NaN になる。
export function orbitAxes(s: KinematicState): OrbitAxes {
  const pro = norm(s.v);
  const nrm = norm(cross(s.r, s.v));
  return { pro, nrm, radOut: cross(pro, nrm) };
}

// 軌道基底で表したベクトル(x=pro, y=nrm, z=radOut 成分)をワールド ECI へ変換する。
export function fromOrbitAxes(s: KinematicState, x: Vec3): Vec3 {
  const { pro, nrm, radOut } = orbitAxes(s);
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
  a: KinematicState,
  b: KinematicState,
  t: number,
  allowExtrapolation = false,
): KinematicState {
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

  return kinematicState(
    t,
    combine(w[0]!, w[1]! * h, w[2]!, w[3]! * h),
    combine(dw[0]! / h, dw[1]!, dw[2]! / h, dw[3]!),
  );
}
