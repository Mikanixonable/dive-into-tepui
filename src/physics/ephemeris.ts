// 太陽・月の簡易天体暦(円軌道近似)。座標系はゲームの ECI(Y軸 = 北極)。
// 太陽: 黄道面(赤道に対し 23.44° 傾斜)を 1 恒星年で公転。
// 月: 黄道に対し 5.145° 傾いた円軌道を 1 恒星月で公転し、
//     昇交点は 18.61 年周期で逆行歳差する(これが軌道傾斜角変化の源)。
// THREE/DOM 非依存の純粋関数。
import { Vec3, v3 } from './vec3';

export const MU_SUN = 1.32712440018e20; // [m^3/s^2]
export const MU_MOON = 4.9048695e12;
export const SUN_DIST = 1.495978707e11; // 1 au [m]
export const MOON_DIST = 3.844e8; // 平均距離 [m]
export const R_MOON = 1.7374e6; // 月半径 [m]

const YEAR = 365.25636 * 86400; // 恒星年 [s]
const MOON_PERIOD = 27.321661 * 86400; // 恒星月 [s]
const NODE_PERIOD = 18.612958 * 365.25 * 86400; // 月の昇交点歳差周期 [s]
const EPS = (23.439291 * Math.PI) / 180; // 黄道傾斜角
const MOON_INC = (5.145 * Math.PI) / 180; // 白道の黄道に対する傾斜

const COS_EPS = Math.cos(EPS);
const SIN_EPS = Math.sin(EPS);

// 標準赤道座標 (X=春分点, Z=北極, 右手系) → ゲーム ECI (Y=北極)。
// Xstd→X, Zstd→Y, Ystd→-Z(行列式 +1 の回転)。
function stdToGame(xs: number, ys: number, zs: number): Vec3 {
  return v3(xs, zs, -ys);
}

// 黄道座標 (xe,ye 黄道面内, ze 黄道北極) → 標準赤道座標 → ゲーム ECI
function eclToGame(xe: number, ye: number, ze: number): Vec3 {
  return stdToGame(xe, ye * COS_EPS - ze * SIN_EPS, ye * SIN_EPS + ze * COS_EPS);
}

// 太陽の ECI 位置(地心から見た太陽)。phase0 は初期黄経 [rad]。
export function sunPosition(t: number, phase0: number): Vec3 {
  const lam = phase0 + (2 * Math.PI * t) / YEAR;
  const p = eclToGame(Math.cos(lam), Math.sin(lam), 0);
  return v3(p.x * SUN_DIST, p.y * SUN_DIST, p.z * SUN_DIST);
}

// 太陽方向の ECI 上での「方位角」(Y軸=極を軸としたXZ平面への射影の偏角)。
// 黄道傾斜(23.44°)により太陽の実際の運動は Y軸まわりの純粋な回転ではないが、
// マップモードの「太陽回転系」表示(カメラ方位・予測軌道の回転補正)には
// この近似で十分(年周期のドリフトなので誤差は視覚上ごく僅か)。
export function sunAzimuth(t: number, phase0: number): number {
  const p = sunPosition(t, phase0);
  return Math.atan2(p.z, p.x);
}

// 月の ECI 位置。phase0 は初期の軌道内位相 [rad]。
export function moonPosition(t: number, phase0: number): Vec3 {
  const u = phase0 + (2 * Math.PI * t) / MOON_PERIOD; // 昇交点からの引数
  const node = -(2 * Math.PI * t) / NODE_PERIOD; // 昇交点黄経(逆行)
  const cu = Math.cos(u);
  const su = Math.sin(u);
  const cn = Math.cos(node);
  const sn = Math.sin(node);
  const ci = Math.cos(MOON_INC);
  const si = Math.sin(MOON_INC);
  // 軌道面 → 黄道面(標準的な Ω, i 回転)
  const xe = cn * cu - sn * su * ci;
  const ye = sn * cu + cn * su * ci;
  const ze = su * si;
  const p = eclToGame(xe, ye, ze);
  return v3(p.x * MOON_DIST, p.y * MOON_DIST, p.z * MOON_DIST);
}
