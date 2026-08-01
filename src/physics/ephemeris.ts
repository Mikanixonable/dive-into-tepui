// 太陽・月の解析天体暦。座標系はゲームの ECI(Y軸 = 北極)。
// 太陽: 黄道面(赤道に対し 23.44° 傾斜)を 1 恒星年で公転。
// 月: 黄道に対し 5.145° 傾いた白道上の楕円軌道(e = 0.0549)を 1 恒星月で公転し、
//     昇交点は 18.61 年周期で逆行歳差、近地点は 8.85 年周期で順行歳差する
//     (昇交点歳差が軌道傾斜角変化の源)。
// THREE/DOM 非依存。位置の計算式は純関数、それを初期位相で束縛して simTime で
// サンプルする状態は末尾の Ephemeris クラスが持つ。
import { Quat, qFromAxisAngle, qMul, qRotate } from './attitude';
import { MU_EARTH, R_EARTH } from './orbital';
import { Vec3, addScaled, dot, len, norm, scale, v3 } from './vec3';

export const MU_SUN = 1.32712440018e20; // [m^3/s^2]
export const MU_MOON = 4.9048695e12;
export const SUN_DIST = 1.495978707e11; // 1 au [m]
export const MOON_DIST = 3.844e8; // 平均距離 [m]
export const R_MOON = 1.7374e6; // 月半径 [m]

const YEAR = 365.25636 * 86400; // 恒星年 [s]
const MOON_PERIOD = 27.321661 * 86400; // 恒星月 [s]
const NODE_PERIOD = 18.612958 * 365.25 * 86400; // 月の昇交点歳差周期 [s]
const PERIGEE_PERIOD = 8.85 * 365.25 * 86400; // 月の近地点歳差周期 [s]
const MOON_ECC = 0.0549; // 月軌道の離心率
const EPS = (23.439291 * Math.PI) / 180; // 黄道傾斜角
const MOON_INC = (5.145 * Math.PI) / 180; // 白道の黄道に対する傾斜

const COS_EPS = Math.cos(EPS);
const SIN_EPS = Math.sin(EPS);
const COS_MOON_INC = Math.cos(MOON_INC);
const SIN_MOON_INC = Math.sin(MOON_INC);

// 天体に固定した回転基準系の、ECI に対する姿勢 q と角速度 omega [rad/s](ECI 成分)。
// 回転軸が一定とは限らないので、軸と回転角の対ではなくこの対で扱う。
export type FrameRotation = { q: Quat; omega: Vec3 };

// 標準赤道座標 (X=春分点, Z=北極, 右手系) →  ECI (Y=北極)。
// Xstd→X, Zstd→Y, Ystd→-Z(行列式 +1 の回転)。
function stdToEci(xs: number, ys: number, zs: number): Vec3 {
  return v3(xs, zs, -ys);
}

// 黄道座標 (xe,ye 黄道面内, ze 黄道北極) → 標準赤道座標 →  ECI
function eclToEci(xe: number, ye: number, ze: number): Vec3 {
  return stdToEci(xe, ye * COS_EPS - ze * SIN_EPS, ye * SIN_EPS + ze * COS_EPS);
}

// 黄道座標系の基底軸(成分は黄道座標での値)。
const ECL_VERNAL = v3(1, 0, 0); // 春分点方向
const ECL_POLE = v3(0, 0, 1); // 黄道北極
const ECL_POLE_ECI = eclToEci(0, 0, 1); // 黄道北極を ECI で表したもの
// eclToEci と同一の回転をクォータニオンで表したもの。春分点(X)まわりに EPS − 90° 回すと
// 黄道基底が ECI 基底へ重なる。
export const Q_ECL_TO_ECI = qFromAxisAngle(ECL_VERNAL, EPS - Math.PI / 2);

// 太陽の黄経とその変化率 [rad], [rad/s]。phase0 は初期黄経。円軌道近似なので変化率は一定。
function sunAngles(t: number, phase0: number): { lam: number; lamRate: number } {
  return { lam: phase0 + (2 * Math.PI * t) / YEAR, lamRate: (2 * Math.PI) / YEAR };
}

// 太陽の ECI 位置(地心から見た太陽)。phase0 は初期黄経 [rad]。
export function sunPosition(t: number, phase0: number): Vec3 {
  const { lam } = sunAngles(t, phase0);
  const p = eclToEci(Math.cos(lam), Math.sin(lam), 0);
  return v3(p.x * SUN_DIST, p.y * SUN_DIST, p.z * SUN_DIST);
}

// 太陽の見かけの公転に固定した回転基準系(x̂ = 地心から見た太陽の方向、ẑ = 黄道法線)。
// 回転軸は赤道の極軸ではなく黄道極(赤道に対し 23.44° 傾く)。
export function sunOrbitRotation(t: number, phase0: number): FrameRotation {
  const { lam, lamRate } = sunAngles(t, phase0);
  return {
    q: qMul(Q_ECL_TO_ECI, qFromAxisAngle(ECL_POLE, lam)),
    omega: scale(ECL_POLE_ECI, lamRate),
  };
}

// 月の軌道角(昇交点黄経 node、真近点角 nu、昇交点からの緯度引数 u)とその時間微分 [rad/s]。
// phase0 は初期の平均黄経 [rad]。
// 角度はすべて「黄経」(黄道上の固定方向から測った角)で組み立て、最後に軌道面内の角
// (昇交点からの緯度引数 u)へ落とす。昇交点・近地点はどちらも歳差するので、平均黄経 L を
// 直接 u として使うと公転が歳差ぶんだけ遅速し、月の位置が長期に大きくずれる。
function moonAngles(t: number, phase0: number): {
  node: number; nodeRate: number; nu: number; u: number; uRate: number;
} {
  // 昇交点黄経(逆行、18.61 年)と近地点黄経(順行、約 8.85 年)。
  const node = -(2 * Math.PI * t) / NODE_PERIOD;
  const nodeRate = -(2 * Math.PI) / NODE_PERIOD;
  const lonPerigee = (2 * Math.PI * t) / PERIGEE_PERIOD;
  const perigeeRate = (2 * Math.PI) / PERIGEE_PERIOD;

  // 平均黄経 L は恒星月で 1 周する。平均近点角 M はそこから近地点黄経を引いたもの。
  const M = phase0 + (2 * Math.PI * t) / MOON_PERIOD - lonPerigee;
  const mRate = (2 * Math.PI) / MOON_PERIOD - perigeeRate;

  // 中心差(Equation of the center)による真近点角 ν の近似と、その解析微分。
  const e = MOON_ECC;
  const c1 = 2 * e - 0.25 * e * e * e;
  const c2 = 1.25 * e * e;
  const nu = M + c1 * Math.sin(M) + c2 * Math.sin(2 * M);
  const nuRate = mRate * (1 + c1 * Math.cos(M) + 2 * c2 * Math.cos(2 * M));

  // 昇交点からの緯度引数 u = 近地点引数(= 近地点黄経 − 昇交点黄経)+ 真近点角
  return { node, nodeRate, nu, u: nu + (lonPerigee - node), uRate: nuRate + (perigeeRate - nodeRate) };
}

// 月の ECI 位置。phase0 は初期の平均黄経 [rad]。
export function moonPosition(t: number, phase0: number): Vec3 {
  const { node, nu, u } = moonAngles(t, phase0);
  const r = (MOON_DIST * (1 - MOON_ECC * MOON_ECC)) / (1 + MOON_ECC * Math.cos(nu));

  const cu = Math.cos(u);
  const su = Math.sin(u);
  const cn = Math.cos(node);
  const sn = Math.sin(node);
  // 軌道面 → 黄道面(標準的な Ω, i 回転)
  const xe = cn * cu - sn * su * COS_MOON_INC;
  const ye = sn * cu + cn * su * COS_MOON_INC;
  const ze = su * SIN_MOON_INC;
  const p = eclToEci(xe, ye, ze);
  return v3(p.x * r, p.y * r, p.z * r);
}

// 白道(月の公転面)の法線(単位ベクトル、ECI)。黄道面(見かけの太陽の公転面)に対し
// 5.145° 傾き、その昇交点が 18.61 年周期で逆行するので、向きは時刻とともに変わる。
export function moonOrbitNormal(t: number, phase0: number): Vec3 {
  const { node } = moonAngles(t, phase0);
  return eclToEci(Math.sin(node) * SIN_MOON_INC, -Math.cos(node) * SIN_MOON_INC, COS_MOON_INC);
}

// 月の公転に固定した回転基準系(x̂ = 地心から見た月の方向、ẑ = 白道法線)。
// 白道の昇交点が歳差するため回転軸は一つに固定できず、omega は「黄道極まわりの昇交点歳差」と
// 「白道法線まわりの公転」の和になる。
export function moonOrbitRotation(t: number, phase0: number): FrameRotation {
  const { node, nodeRate, u, uRate } = moonAngles(t, phase0);
  // 黄道座標での基底 Rz(Ω)·Rx(i)·Rz(u) を組み、ECI へ移す。
  const q = qMul(Q_ECL_TO_ECI, qMul(
    qFromAxisAngle(ECL_POLE, node),
    qMul(qFromAxisAngle(ECL_VERNAL, MOON_INC), qFromAxisAngle(ECL_POLE, u)),
  ));
  const omega = addScaled(scale(ECL_POLE_ECI, nodeRate), moonOrbitNormal(t, phase0), uRate);
  return { q, omega };
}

export type LagrangePoints = { L1: Vec3; L2: Vec3; L3: Vec3; L4: Vec3; L5: Vec3 };

// 円制限三体問題のラグランジュ点。5点はいずれも回転系(原点 = 主天体、x̂ = 副天体方向、
// ŷ = 副天体の公転前方)の固定点で、その無次元座標(軌道半径を 1 とする)は質量比
// mu = m2/(m1+m2) だけで決まる。それを ECI [m] へ移す写像 place を受け取って組み立てる。
function lagrangePoints(mu: number, place: (x: number, y: number) => Vec3): LagrangePoints {
  const hill = Math.cbrt(mu / 3); // L1/L2 の副天体からの距離(軌道半径比)
  const s60 = Math.sqrt(3) / 2;
  return {
    L1: place(1 - hill, 0),
    L2: place(1 + hill, 0),
    L3: place(-(1 + (5 / 12) * mu), 0),
    L4: place(0.5, s60),
    L5: place(0.5, -s60),
  };
}

// 地球-月系のラグランジュ点を ECI [m] で返す。
// 地球が主天体なので、回転系の原点がそのまま地心になる。
export function emLagrangePoints(t: number, phase0: number): LagrangePoints {
  const { q } = moonOrbitRotation(t, phase0);
  const R = len(moonPosition(t, phase0));
  return lagrangePoints(MU_MOON / (MU_EARTH + MU_MOON), (x, y) => qRotate(q, v3(R * x, R * y, 0)));
}

// 太陽-地球系のラグランジュ点を ECI [m] で返す。L1 は太陽側、L2 は反太陽側、
// L3 は太陽を挟んだ向こう側(地心からは太陽方向へ約 2 au)、L4/L5 は地球の公転前方/後方 60°。
// 地球はこの系では副天体なので、回転系の原点(太陽)から地心へ移す平行移動が入る。
// sunOrbitRotation の基底では x̂ が地球→太陽、すなわち回転系の x̂(太陽→地球)とは逆向きで、
// ŷ も同時に反転するため、無次元座標 (x, y) の地心での像は R·(1 − x, −y) になる。
export function seLagrangePoints(t: number, phase0: number): LagrangePoints {
  const { q } = sunOrbitRotation(t, phase0);
  const R = SUN_DIST; // 太陽は円軌道近似なので距離は一定
  return lagrangePoints(MU_EARTH / (MU_SUN + MU_EARTH), (x, y) => qRotate(q, v3(R * (1 - x), -R * y, 0)));
}

// 位置 r における日照率 0..1。地球を円柱とみなし、影側では地球半径からの距離に応じて
// penumbra [m] の幅で 0→1 へ線形にぼかす。
export function sunlitFactor(r: Vec3, sunDir: Vec3, penumbra: number): number {
  const along = dot(r, sunDir);
  if (along >= 0) return 1; // 太陽側
  const perp = len(addScaled(r, sunDir, -along));
  return Math.min(1, Math.max(0, (perp - R_EARTH) / penumbra));
}

// 天体暦: 初期位相をゲームごとに固定し、任意の simTime で太陽・月の ECI 位置・
// 太陽方向を計算して返すサンプラ。軌道予測・環境描画・マップ表示など「物理的な天体暦」
// だけを要する箇所は、位相を露出せずこのオブジェクトを共有する。
// sunPosAt/moonPosAt は直近に引いた時刻と結果を覚えて同一時刻の再計算を省くが、返す Vec3 は
// 不変なので呼び出し側からは毎回計算するのと区別できない — 呼び出し順の制約は生じない。
export class Ephemeris {
  // sunPosAt/moonPosAt のメモ(直近に引いた時刻とその結果)。
  private sunMemoT: number;
  private sunMemoPos: Vec3;
  private moonMemoT: number;
  private moonMemoPos: Vec3;

  // sunPhase0 は昼(太陽が+X側)から始まるよう既定 0。moonPhase0 は既定でゲーム
  // ごとの乱数。テストは決定的な位相を渡すためコンストラクタで上書きする。
  constructor(
    private readonly sunPhase0 = 0,
    private readonly moonPhase0 = Math.random() * Math.PI * 2,
  ) {
    this.sunMemoT = 0;
    this.sunMemoPos = sunPosition(0, sunPhase0);
    this.moonMemoT = 0;
    this.moonMemoPos = moonPosition(0, moonPhase0);
  }

  // 指定時刻の太陽の ECI 位置。
  sunPosAt(t: number): Vec3 {
    if (t !== this.sunMemoT) {
      this.sunMemoPos = sunPosition(t, this.sunPhase0);
      this.sunMemoT = t;
    }
    return this.sunMemoPos;
  }
  // 指定時刻の月の ECI 位置。
  moonPosAt(t: number): Vec3 {
    if (t !== this.moonMemoT) {
      this.moonMemoPos = moonPosition(t, this.moonPhase0);
      this.moonMemoT = t;
    }
    return this.moonMemoPos;
  }
  // 太陽方向の単位ベクトル(ライティング・影判定用)。
  sunDirAt(t: number): Vec3 {
    return norm(sunPosition(t, this.sunPhase0));
  }
  // 指定時刻の、太陽の見かけの公転に固定した回転基準系。
  sunOrbitRotationAt(t: number): FrameRotation {
    return sunOrbitRotation(t, this.sunPhase0);
  }
  // 指定時刻の、月の公転に固定した回転基準系。
  moonOrbitRotationAt(t: number): FrameRotation {
    return moonOrbitRotation(t, this.moonPhase0);
  }
  // 指定時刻の白道(月の公転面)法線。
  moonOrbitNormalAt(t: number): Vec3 {
    return moonOrbitNormal(t, this.moonPhase0);
  }
  // 指定時刻の地球-月ラグランジュ点(L1-L5)。
  emLagrangeAt(t: number): LagrangePoints {
    return emLagrangePoints(t, this.moonPhase0);
  }
  // 指定時刻の太陽-地球ラグランジュ点(L1-L5)。
  seLagrangeAt(t: number): LagrangePoints {
    return seLagrangePoints(t, this.sunPhase0);
  }
}
