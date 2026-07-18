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
  // 昇交点黄経(逆行)
  const node = -(2 * Math.PI * t) / NODE_PERIOD; 
  // 近地点の移動周期(約8.85年、順行)
  const PERIGEE_PERIOD = 8.85 * 365.25 * 86400;
  const omega = (2 * Math.PI * t) / PERIGEE_PERIOD;
  
  // 平均近点角 M
  const L = phase0 + (2 * Math.PI * t) / MOON_PERIOD; 
  const M = L - omega;
  
  // 中心差(Equation of the center)による真近点角 ν の近似 (e = 0.0549)
  const e = 0.0549;
  const nu = M + (2 * e - 0.25 * e * e * e) * Math.sin(M) + 1.25 * e * e * Math.sin(2 * M);
  
  // 昇交点からの真の引数 u
  const u = nu + omega;
  
  // 軌道半径 r
  const a = MOON_DIST;
  const r = a * (1 - e * e) / (1 + e * Math.cos(nu));

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
  return v3(p.x * r, p.y * r, p.z * r);
}

// Earth-Moon L-points (calculated from Earth center in ECI)
export function emLagrangePoints(t: number, phase0: number): { L1: Vec3, L2: Vec3, L3: Vec3, L4: Vec3, L5: Vec3 } {
  const mPos = moonPosition(t, phase0);
  const R = Math.sqrt(mPos.x * mPos.x + mPos.y * mPos.y + mPos.z * mPos.z);
  const mu = MU_MOON / (3.986004418e14 + MU_MOON);
  
  const rL1 = R * (1 - Math.pow(mu / 3, 1/3));
  const rL2 = R * (1 + Math.pow(mu / 3, 1/3));
  const rL3 = -R * (1 + 5/12 * mu);

  const l1 = v3(mPos.x * rL1 / R, mPos.y * rL1 / R, mPos.z * rL1 / R);
  const l2 = v3(mPos.x * rL2 / R, mPos.y * rL2 / R, mPos.z * rL2 / R);
  const l3 = v3(mPos.x * rL3 / R, mPos.y * rL3 / R, mPos.z * rL3 / R);

  // L4/L5 are 60 degrees ahead/behind the Moon in its orbit plane
  const node = -(2 * Math.PI * t) / NODE_PERIOD;
  const ci = Math.cos(MOON_INC);
  const si = Math.sin(MOON_INC);
  const cn = Math.cos(node);
  const sn = Math.sin(node);
  
  // Orbit normal in ecliptic
  const nxe = sn * si;
  const nye = -cn * si;
  const nze = ci;
  const nHat = eclToGame(nxe, nye, nze);
  
  const mHat = v3(mPos.x / R, mPos.y / R, mPos.z / R);
  const tHat = v3(
    nHat.y * mHat.z - nHat.z * mHat.y,
    nHat.z * mHat.x - nHat.x * mHat.z,
    nHat.x * mHat.y - nHat.y * mHat.x
  );
  
  const cos60 = 0.5;
  const sin60 = Math.sqrt(3) / 2;
  
  const l4 = v3(
    R * (mHat.x * cos60 + tHat.x * sin60),
    R * (mHat.y * cos60 + tHat.y * sin60),
    R * (mHat.z * cos60 + tHat.z * sin60)
  );
  const l5 = v3(
    R * (mHat.x * cos60 - tHat.x * sin60),
    R * (mHat.y * cos60 - tHat.y * sin60),
    R * (mHat.z * cos60 - tHat.z * sin60)
  );
  
  return { L1: l1, L2: l2, L3: l3, L4: l4, L5: l5 };
}

// Sun-Earth L-points (calculated from Earth center in ECI)
// Note: Earth is at origin in ECI. The Sun is at `sunPosition`.
// L1 is between Sun and Earth. L2 is past Earth.
export function seLagrangePoints(t: number, phase0: number): { L1: Vec3, L2: Vec3 } {
  const sPos = sunPosition(t, phase0);
  const D = SUN_DIST;
  const mu = 3.986004418e14 / MU_SUN;
  
  const rL = D * Math.pow(mu / 3, 1/3); // distance from Earth
  const sHat = v3(sPos.x / D, sPos.y / D, sPos.z / D);
  
  const l1 = v3(sHat.x * rL, sHat.y * rL, sHat.z * rL); // towards Sun
  const l2 = v3(-sHat.x * rL, -sHat.y * rL, -sHat.z * rL); // away from Sun
  
  return { L1: l1, L2: l2 };
}
