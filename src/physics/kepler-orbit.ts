// 中心天体まわりの軌道を、基準面に固定したケプラー要素と角度の永年変化率で表したものの評価。
// 恒星/惑星/衛星のどの分類にも属さない、純粋な軌道の数学 — 変化率が何に由来するかは
// planet-orbit.ts / satellite-orbit.ts の責務。
// 角度は平均黄経 L(公転周期でちょうど1周)→ 平均近点角 M = L − ϖ → 真近点角 ν の順に組む。
// 昇交点・近点はどちらも歳差するので、L を軌道面内の角(昇交点からの緯度引数 u)へ直接
// 使うと公転が歳差ぶんだけ遅速し、長期積分で位置が大きくずれる。
// 傾斜・昇交点・近点はすべて basisToEci が指す基準面(黄道面、あるいは親惑星の赤道面)の
// 上で測る。位置・速度だけでなく軌道法線・回転基準系もこの1つの回転を経由するので、
// 基準面を変えても表示・ラグランジュ点・回転座標系が食い違うことはない。
import { Quat, qFromAxisAngle, qMul, qRotate } from './attitude';
import { Q_ECL_TO_ECI } from './ecliptic';
import { eccentricAnomalyFromMean, positionFromOrbitalElements } from './elements';
import { KinematicState, kinematicState } from './kinematic-state';
import { Vec3, addScaled, cross, norm, scale, v3 } from '../math/vec3';

export const JULIAN_CENTURY = 100 * 365.25 * 86400; // [s]

// 基準面座標系(x = 基準面上の要素の原点方向、z = 基準面の法線)の基底軸。
const BASIS_ORIGIN: Vec3 = v3(1, 0, 0);
const BASIS_POLE: Vec3 = v3(0, 0, 1);

// Z 上向きの基準面基底 → Y 上向きの基底。positionFromOrbitalElements は Y=極 を前提とするので、
// 基準面座標の要素からこの回転を挟んで基準面基底へ戻す。
const Q_ZUP_TO_YUP: Quat = qFromAxisAngle(BASIS_ORIGIN, Math.PI / 2);

// 既定の基準面 = 黄道面。惑星と月の要素はこの面の上で与えられる。
export const ECLIPTIC_BASIS: Quat = Q_ECL_TO_ECI;

export type KeplerOrbit = {
  readonly basisToEci: Quat; // 基準面座標系(z = 基準面の法線)→ ECI
  readonly a: number; // t=0 の軌道長半径 [m]
  readonly aRate: number; // 軌道長半径の変化率 [m/s]
  readonly e: number; // t=0 の離心率
  readonly eRate: number; // 離心率の変化率 [1/s]
  readonly inc: number; // t=0 の基準面に対する傾斜 [rad]
  readonly incRate: number; // 傾斜の変化率 [rad/s]
  readonly raan0: number; // t=0 の昇交点黄経 [rad]
  readonly raanRate: number; // 昇交点の変化率 [rad/s]
  readonly lonPeri0: number; // t=0 の近点黄経 ϖ [rad]
  readonly lonPeriRate: number; // 近点の変化率 [rad/s]
  readonly l0: number; // t=0 の平均黄経 L [rad]
  readonly lRate: number; // 平均黄経の変化率 [rad/s](= 2π/公転周期)
};

// 天体に固定した回転基準系の、ECI に対する姿勢 q と角速度 omega [rad/s](ECI 成分)。
// 回転軸が一定とは限らないので、軸と回転角の対ではなくこの対で扱う。
export type FrameRotation = { readonly q: Quat; readonly omega: Vec3 };

type OrbitAngles = {
  readonly a: number;
  readonly e: number;
  readonly inc: number;
  readonly raan: number;
  readonly argp: number;
  readonly nu: number;
  readonly nuRate: number;
  readonly rDot: number; // 動径方向の速さ [m/s]
  readonly u: number;
  readonly uMean: number; // 平均近点角に対応する昇交点からの角(= L − Ω)
  readonly uRate: number;
};

// ν̇ と ṙ は離心近点角 E の軌道面内座標 (a(cosE−e), a√(1−e²)sinE) を陽に時間微分して求める —
// 標準の ν̇ = Ṁ(1+e cosν)²/(1−e²)^1.5 は a・e を定数とみなした式で、aRate/eRate ≠ 0(惑星要素の
// 永年変化)では長半径そのものの変化、およびケプラー方程式 M = E − e sinE の e への依存ぶんが
// Ė、ひいては ν̇/ṙ から抜け落ちる。
function orbitAngles(orbit: KeplerOrbit, t: number): OrbitAngles {
  // 各要素を t=0 の値 + 永年変化率×t で t 時点へ進める。
  const a = orbit.a + orbit.aRate * t;
  const e = orbit.e + orbit.eRate * t;
  const inc = orbit.inc + orbit.incRate * t;
  const raan = orbit.raan0 + orbit.raanRate * t;
  const lonPeri = orbit.lonPeri0 + orbit.lonPeriRate * t;
  const L = orbit.l0 + orbit.lRate * t;
  const M = L - lonPeri;
  const mRate = orbit.lRate - orbit.lonPeriRate;

  // ケプラー方程式 M = E − e·sinE を解き、その両辺を陰関数微分して Ė を得る。
  const E = eccentricAnomalyFromMean(M, e);
  const cosE = Math.cos(E);
  const sinE = Math.sin(E);
  const eDot = orbit.eRate;
  const eccAnomRate = (mRate + eDot * sinE) / (1 - e * cosE); // Ė(ケプラー方程式の陰関数微分)

  // 軌道面内座標 (x,y) = a(cosE−e, √(1−e²)sinE) とその時間微分から ν̇/ṙ を導く。
  const sqrt1me2 = Math.sqrt(1 - e * e);
  const x = a * (cosE - e);
  const y = a * sqrt1me2 * sinE;
  const xDot = orbit.aRate * (cosE - e) + a * (-sinE * eccAnomRate - eDot);
  const yDot = orbit.aRate * sqrt1me2 * sinE
    + a * ((-e * eDot / sqrt1me2) * sinE + sqrt1me2 * cosE * eccAnomRate);

  const r = Math.hypot(x, y);
  const nu = Math.atan2(y, x);
  const nuRate = (x * yDot - y * xDot) / (r * r);
  const rDot = (x * xDot + y * yDot) / r;

  // 昇交点からの緯度引数 u とその変化率は、真近点角と近点・昇交点の歳差の和。
  const argp = lonPeri - raan;
  const u = nu + argp;
  const uMean = L - raan;
  const uRate = nuRate + (orbit.lonPeriRate - orbit.raanRate);
  return { a, e, inc, raan, argp, nu, nuRate, rDot, u, uMean, uRate };
}

// 基準面座標で表したベクトルを ECI へ移す。
function toEci(orbit: KeplerOrbit, x: number, y: number, z: number): Vec3 {
  return qRotate(orbit.basisToEci, v3(x, y, z));
}

// 軌道面の法線(単位ベクトル、ECI)。基準面に対し inc 傾き、その昇交点が raanRate で歳差する
// ので向きは時刻とともに変わる。
function normalFromAngles(orbit: KeplerOrbit, a: OrbitAngles): Vec3 {
  return toEci(orbit, Math.sin(a.raan) * Math.sin(a.inc), -Math.cos(a.raan) * Math.sin(a.inc), Math.cos(a.inc));
}

// 昇交点から軌道面内に角 u だけ進んだ方向の単位ベクトル(ECI)。
function directionFromAngles(orbit: KeplerOrbit, a: OrbitAngles, u: number): Vec3 {
  const cosU = Math.cos(u);
  const sinU = Math.sin(u);
  const cosI = Math.cos(a.inc);
  return toEci(
    orbit,
    Math.cos(a.raan) * cosU - Math.sin(a.raan) * sinU * cosI,
    Math.sin(a.raan) * cosU + Math.cos(a.raan) * sinU * cosI,
    sinU * Math.sin(a.inc),
  );
}

// この軌道に固定した回転基準系(x̂ = 中心→自分、ẑ = 軌道面法線)。
// 姿勢は Rz(Ω)·Rx(inc)·Rz(u) を ECI へ移したもの。角速度は3-1-3オイラー角の合成則により
// 「基準面の極まわりの昇交点歳差」+「昇交点方向まわりの傾斜変化」+「軌道面法線まわりの公転」の和。
function rotationFromAngles(orbit: KeplerOrbit, a: OrbitAngles): FrameRotation {
  const q = qMul(orbit.basisToEci, qMul(
    qFromAxisAngle(BASIS_POLE, a.raan),
    qMul(qFromAxisAngle(BASIS_ORIGIN, a.inc), qFromAxisAngle(BASIS_POLE, a.u)),
  ));
  const node = toEci(orbit, Math.cos(a.raan), Math.sin(a.raan), 0);
  const basisPole = qRotate(orbit.basisToEci, BASIS_POLE);
  const normal = normalFromAngles(orbit, a);
  const omega = addScaled(addScaled(scale(basisPole, orbit.raanRate), node, orbit.incRate), normal, a.uRate);
  return { q, omega };
}

// 角を [0, 2π) へ畳む。
function wrapAngle(x: number): number {
  const TWO_PI = 2 * Math.PI;
  return x - TWO_PI * Math.floor(x / TWO_PI);
}

// 要素の元期を simZeroEt ぶん進め、平均黄経へ初期位相 phase を足した軌道。永年変化は
// すべて時刻の一次式なので、各要素へ「変化率 × オフセット」を加えるだけで移せる。
//
// **角は必ず畳む。** オフセットは 18,000 年規模になりうる — 畳まないと平均黄経が 1e5 rad まで
// 積み上がり、そこでの ulp(1.5e-11 rad)が以降すべての評価の丸めを支配して、地球軌道上で
// メートル規模の誤差になる。畳めば中間値が 100 rad 規模に収まり、丸めは 3 桁小さくなる。
export function keplerOrbitForSimZero(orbit: KeplerOrbit, phase: number, simZeroEt: number): KeplerOrbit {
  const s = simZeroEt;
  return {
    ...orbit,
    a: orbit.a + orbit.aRate * s,
    e: orbit.e + orbit.eRate * s,
    inc: orbit.inc + orbit.incRate * s,
    raan0: wrapAngle(orbit.raan0 + orbit.raanRate * s),
    lonPeri0: wrapAngle(orbit.lonPeri0 + orbit.lonPeriRate * s),
    l0: wrapAngle(orbit.l0 + phase + orbit.lRate * s),
  };
}

// 中心天体中心・ECI 軸での状態。軌道は要素と平均黄経の変化率だけで決まるので、中心天体の
// 重力定数は要らない(lRate が平均運動そのもの)。
// 速度は、軌道面内の動径変化(ṙ·r̂)と回転基準系自身の角速度による見かけの移動(omega×r)の
// 和として組む — 後者が昇交点・近点の歳差ぶんの寄与を担う。
export function keplerOrbitState(orbit: KeplerOrbit, t: number): KinematicState<'primaryRel'> {
  const a = orbitAngles(orbit, t);
  const r = qRotate(qMul(orbit.basisToEci, Q_ZUP_TO_YUP), positionFromOrbitalElements(a.a, a.e, a.inc, a.raan, a.argp, a.nu));
  const { omega } = rotationFromAngles(orbit, a);
  const v = addScaled(cross(omega, r), norm(r), a.rDot);
  return kinematicState<'primaryRel'>(t, r, v);
}

// この軌道に固定した回転基準系の t 時点の姿勢・角速度。
export function keplerOrbitRotation(orbit: KeplerOrbit, t: number): FrameRotation {
  return rotationFromAngles(orbit, orbitAngles(orbit, t));
}

// 軌道面の法線(単位ベクトル、ECI)。
export function keplerOrbitNormal(orbit: KeplerOrbit, t: number): Vec3 {
  return normalFromAngles(orbit, orbitAngles(orbit, t));
}

// 平均黄経が指す方向の単位ベクトル(ECI)。真近点角ではなく平均近点角で軌道面内の角を取るので、
// 中心差のぶんだけ実位置とはずれる。公転周期でちょうど一定角速度で回るため、同期回転する
// 天体の本初子午線が指す方向はこちらで表される。
export function keplerOrbitMeanDirection(orbit: KeplerOrbit, t: number): Vec3 {
  const a = orbitAngles(orbit, t);
  return directionFromAngles(orbit, a, a.uMean);
}
