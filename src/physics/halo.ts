// 円制限三体問題(CR3BP)の共線ラグランジュ点(L1/L2/L3)まわりの解析解。共線点の局所基底と
// 無次元パラメータ、Richardson (1980) の三次近似の係数と軌道形状、そして線形解から組んだ
// ハロー軌道・リサジュー軌道の初期状態を持つ。
// ラグランジュ点の位置と回転フレームの姿勢/角速度は受け取った SecondaryFrame からそのまま
// 取り、ここでは基底・法線を作り直さない。
//
// 線形解では面内振動数 λ と面外振動数 ωz=√c2 が一致しないため、一次の範囲でハロー軌道
// (閉じた三次元ループ)は存在しない。ハロー軌道は三次の振幅拘束 l1·Ax² + l2·Az² + Δ = 0 が
// 成り立つときに両振動数が一致して現れるので、面外振幅 Az からこの拘束で面内振幅 Ax を決める。
//
// haloState/lissajousState が返す位置・速度は一次の線形解にとどまる。またゲームの積分器は
// 地球中心二体 + J2 + 抗力 + 日月三体であって制限三体問題そのものではないため、ここで返した
// 状態を実際にゲーム内で積分すると軌道はドリフトする。
import { CollinearPoint, SecondaryFrame, lagrangePointsOf } from './lagrange';
import { KinematicState, kinematicState } from './kinematic-state';
import { Vec3, add, cross, len, scale, sub } from '../math/vec3';
import { Vec3Tuple } from './cr3bp';

// 共線ラグランジュ点まわりの回転局所基底と、その点の無次元パラメータ。
// origin: L点の ECI 位置。xHat: 主天体→副天体方向。zHat: 系の公転面法線。
// yHat = zHat × xHat で右手系を作る。omega: 回転フレームの角速度(ECI 成分、大きさが
// 無次元化の時間単位 n)。r: 主天体・副天体間距離 [m]。
export interface CollinearFrame extends CollinearParams {
  readonly origin: Vec3;
  readonly xHat: Vec3;
  readonly yHat: Vec3;
  readonly zHat: Vec3;
  readonly omega: Vec3;
  readonly r: number;
}

// 共線点における Richardson (1980) の cn 係数。gamma は L点から最も近い天体までの距離を
// 主天体-副天体間距離で割った無次元値(L1/L2 は副天体から、L3 は主天体から測る)。
// 局所座標の x 軸はどの点でも主天体→副天体向きで、符号の違いはその向きから決まる。
function cn(point: CollinearPoint, mu: number, gamma: number, n: number): number {
  const sign = (-1) ** n;
  if (point === 'L1') {
    return (mu + sign * (1 - mu) * gamma ** (n + 1) / (1 - gamma) ** (n + 1)) / gamma ** 3;
  }
  if (point === 'L2') {
    return sign * (mu + (1 - mu) * gamma ** (n + 1) / (1 + gamma) ** (n + 1)) / gamma ** 3;
  }
  return (1 - mu + mu * gamma ** (n + 1) / (1 + gamma) ** (n + 1)) / gamma ** 3;
}

// c2 から共線点の線形化パラメータを組み立てる。
function linearParams(c2: number): { lambda: number; omegaZ: number; kappa: number } {
  // 面内特性方程式 λ⁴+(c2-2)λ²-(2c2+1)(c2-1)=0 の判別式は 9c2²-8c2 に簡約でき、
  // 正の根が振動解を与える(負の根は双曲解で、ここでは使わない)。
  const disc = Math.sqrt(9 * c2 * c2 - 8 * c2);
  const lambda2 = (disc - c2 + 2) / 2;
  const lambda = Math.sqrt(lambda2);
  // 面内運動 x=Ax cos(λτ+φ), y=κAx sin(λτ+φ) を線形化方程式へ代入して得る振幅比
  // (richardsonCoefficients の k と同一の量)。
  return { lambda, omegaZ: Math.sqrt(c2), kappa: (lambda2 + 1 + 2 * c2) / (2 * lambda) };
}

// 質量比 mu だけから決まる共線点の無次元パラメータ。gamma は L点から最も近い天体までの
// 距離比で、局所座標(x: 主天体→副天体、z: 公転面法線)の長さの単位でもある。
export interface CollinearParams {
  readonly point: CollinearPoint;
  readonly mu: number;
  readonly gamma: number;
  readonly lambda: number;
  readonly omegaZ: number;
  readonly kappa: number;
}

// CR3BP 回転系(重心原点、両天体間距離を 1)での共線点の x 座標。
function collinearBarycentricX(params: CollinearParams): number {
  const { mu, gamma, point } = params;
  if (point === 'L1') return 1 - mu - gamma;
  if (point === 'L2') return 1 - mu + gamma;
  return -mu - gamma;
}

// L点局所座標(gamma 単位、原点=L点)の位置を CR3BP 回転系の座標へ移す。
export function collinearLocalToBarycentric(params: CollinearParams, local: Vec3Tuple): Vec3Tuple {
  const xL = collinearBarycentricX(params);
  return [xL + params.gamma * local[0], params.gamma * local[1], params.gamma * local[2]];
}

// 指定した副天体・L点における共線点まわりの回転局所基底と線形化パラメータを組み立てる。
// 質量比・距離比だけをここで計算する。gamma は lagrangePointsOf が内部に持つ近似値を
// 公開していないため、求まった L点座標から逆算して一貫性を取る。
export function collinearFrame(frame: SecondaryFrame, point: CollinearPoint): CollinearFrame {
  const primaryPos = frame.primaryState.r;
  const secondaryPos = frame.secondaryState.r;
  // 回転フレームの omega は公転面法線まわりの公転成分と昇交点歳差成分の和になりうる
  // (kepler-orbit.ts 参照)ので、omega の向きそのものが公転面法線と一致するとは限らない。
  // 歳差の有無によらず正しい公転面法線を frame.normal から取る。
  const omega = frame.rotation.omega;
  const normal = frame.normal;
  const mu = frame.secondary.def.mu / (frame.primary.def.mu + frame.secondary.def.mu);
  const origin = lagrangePointsOf(frame)[point];

  const rVec = sub(secondaryPos, primaryPos);
  const r = len(rVec);
  const xHat = scale(rVec, 1 / r);
  const zHat = normal;
  const yHat = cross(zHat, xHat);

  // L3 だけは最も近い天体が主天体なので、そちらからの距離比を gamma に取る。
  const nearest = point === 'L3' ? primaryPos : secondaryPos;
  const gamma = len(sub(origin, nearest)) / r;

  return {
    origin, xHat, yHat, zHat, omega, r, gamma, mu, point,
    ...linearParams(cn(point, mu, gamma, 2)),
  };
}

export interface LissajousParams {
  readonly point: CollinearPoint;
  readonly ax: number; // 面内振幅 [m]
  readonly az: number; // 面外振幅 [m]
  readonly phase?: number; // 面内位相 [rad]、既定 0(軌道上のどこに置くかを選ぶ)
  readonly psi?: number; // 面外位相 [rad]、既定 0
}

export interface HaloParams {
  readonly point: CollinearPoint;
  readonly az: number; // 面外振幅 [m](面内振幅は三次の振幅拘束から決まる)
  readonly phase?: number; // 面内位相 [rad]、既定 0
}

// Richardson (1980) 三次近似の位置・速度(無次元、γスケール局所座標、τ1=位相引数での微分)。
// axHat/azHat は gamma 単位(下記 centerManifoldState/lissajousLoop の呼び出し側で
// R*gamma により無次元化して渡す)。deltaN は L1/L3 で 1、L2 で -1(Richardson の
// δn=2-n の符号規約、n=1: L1/L3、n=2: L2。共線点の局所 x 軸はどの点でも主天体→副天体
// 向きに統一されているため、L2 だけ z 方向の符号が反転する)。
// theta1/rate1 は面内(x,y)の位相とその角速度(dτ1/dτ)、psiZ/rateZ は面外(z)の位相と
// その角速度 — ハロー軌道では面内と同じ位相・角速度(呼び出し側で theta1 に π/2 を
// 足したものを渡す)、リサジューでは独立な値になる。
export function richardsonState(
  coeffs: RichardsonCoefficients,
  kappa: number,
  deltaN: number,
  axHat: number,
  azHat: number,
  theta1: number,
  rate1: number,
  psiZ: number,
  rateZ: number,
): { x: number; y: number; z: number; xDot: number; yDot: number; zDot: number } {
  const { a21, a22, a23, a24, a31, a32, b21, b22, b31, b32, d21, d31, d32 } = coeffs;
  const c1 = Math.cos(theta1);
  const s1 = Math.sin(theta1);
  const c2 = Math.cos(2 * theta1);
  const s2 = Math.sin(2 * theta1);
  const c3 = Math.cos(3 * theta1);
  const s3 = Math.sin(3 * theta1);
  const cz1 = Math.cos(psiZ);
  const sz1 = Math.sin(psiZ);
  const cz2 = Math.cos(2 * psiZ);
  const sz2 = Math.sin(2 * psiZ);
  const cz3 = Math.cos(3 * psiZ);
  const sz3 = Math.sin(3 * psiZ);

  const ax2 = axHat * axHat;
  const az2 = azHat * azHat;
  const ax3 = ax2 * axHat;
  const term23 = a23 * ax2 - a24 * az2;
  const term31 = a31 * ax3 - a32 * axHat * az2;
  const termB2 = b21 * ax2 - b22 * az2;
  const termB3 = b31 * ax3 - b32 * axHat * az2;
  const termD3 = d32 * azHat * ax2 - d31 * azHat * az2;

  const x = a21 * ax2 + a22 * az2 - axHat * c1 + term23 * c2 + term31 * c3;
  const y = kappa * axHat * s1 + termB2 * s2 + termB3 * s3;
  const z = deltaN * (azHat * cz1 + d21 * axHat * azHat * (cz2 - 3) + termD3 * cz3);

  const xDot = rate1 * (axHat * s1 - 2 * term23 * s2 - 3 * term31 * s3);
  const yDot = rate1 * (kappa * axHat * c1 + 2 * termB2 * c2 + 3 * termB3 * c3);
  const zDot = -deltaN * rateZ * (azHat * sz1 + 2 * d21 * axHat * azHat * sz2 + 3 * termD3 * sz3);

  return { x, y, z, xDot, yDot, zDot };
}

// L点局所基底での三次近似解(gamma単位、位相 phase/psi での位置・速度)から ECI の
// KinematicState を組み立てる。回転フレーム相対速度から ECI 速度への変換は frame.ts の
// toInertialState と同じ関係 v = v_rel + ω×r(r は原点=地球からの絶対位置)による。
function centerManifoldState(
  t: number,
  frame: CollinearFrame,
  ax: number,
  az: number,
  phase: number,
  psi: number,
  zFreq: number,
): KinematicState {
  const { lambda, kappa, r: R, gamma, omega, point } = frame;
  const n = len(omega); // 回転フレームの角速度(無次元時間 τ=n·t の単位)
  const unit = R * gamma; // Richardson の係数が前提とするγスケール無次元単位への換算長。

  const axHat = ax / unit;
  const azHat = az / unit;
  const deltaN = point === 'L2' ? -1 : 1;

  // 振幅依存の振動数補正(ω=1+s1·Ax²+s2·Az²)を面内位相へ適用し、面外位相にも同じ係数を
  // 掛けて面内・面外の位相関係を保つ。
  const coeffs = richardsonCoefficients(frame);
  const omegaCorrection = 1 + coeffs.s1 * axHat * axHat + coeffs.s2 * azHat * azHat;
  const theta1 = omegaCorrection * phase;
  const rate1 = omegaCorrection * lambda;
  const psiZ = omegaCorrection * psi;
  const rateZ = omegaCorrection * zFreq;

  const { x, y, z, xDot, yDot, zDot } = richardsonState(
    coeffs, kappa, deltaN, axHat, azHat, theta1, rate1, psiZ, rateZ,
  );

  // フレーム基底で組んだ無次元の位置・速度を、実長さ unit でスケールして ECI 軸へ戻す。
  const relPos = add(add(scale(frame.xHat, x * unit), scale(frame.yHat, y * unit)), scale(frame.zHat, z * unit));
  const relVel = add(
    add(scale(frame.xHat, xDot * unit * n), scale(frame.yHat, yDot * unit * n)),
    scale(frame.zHat, zDot * unit * n),
  );

  // 回転フレーム相対の状態を絶対位置へ平行移動し、フレームの角速度ぶんを足して ECI 速度にする。
  const rEci = add(frame.origin, relPos);
  const vEci = add(relVel, cross(omega, rEci));
  return kinematicState<'eci'>(t, rEci, vEci);
}

// Richardson (1980) 三次近似の係数一式。長さはすべて gamma 単位、時間は τ=n·t 単位。
// l1·Ax² + l2·Az² + delta = 0 が面内・面外の振動数を一致させる振幅拘束で、これが
// 成り立つ振幅の組だけがハロー軌道になる。
export interface RichardsonCoefficients {
  readonly lambda: number;
  readonly k: number;
  readonly a21: number; readonly a22: number; readonly a23: number; readonly a24: number;
  readonly a31: number; readonly a32: number;
  readonly b21: number; readonly b22: number; readonly b31: number; readonly b32: number;
  readonly d21: number; readonly d31: number; readonly d32: number;
  readonly s1: number; readonly s2: number;
  readonly l1: number; readonly l2: number; readonly delta: number;
}

// 共線点の無次元パラメータから Richardson 三次近似の係数を解く。
export function richardsonCoefficients(params: CollinearParams): RichardsonCoefficients {
  const { mu, gamma, lambda, point } = params;
  const c2 = cn(point, mu, gamma, 2);
  const c3 = cn(point, mu, gamma, 3);
  const c4 = cn(point, mu, gamma, 4);
  const l2sq = lambda * lambda;
  // kappa と符号だけが違う Richardson の振幅比。以降の係数はこの k で書かれている。
  const k = (l2sq + 1 + 2 * c2) / (2 * lambda);

  const d1 = (3 * l2sq / k) * (k * (6 * l2sq - 1) - 2 * lambda);
  const d2 = (8 * l2sq / k) * (k * (11 * l2sq - 1) - 2 * lambda);

  // 二次の項。
  const a21 = 3 * c3 * (k * k - 2) / (4 * (1 + 2 * c2));
  const a22 = 3 * c3 / (4 * (1 + 2 * c2));
  const a23 = -(3 * c3 * lambda / (4 * k * d1)) * (3 * k ** 3 * lambda - 6 * k * (k - lambda) + 4);
  const a24 = -(3 * c3 * lambda / (4 * k * d1)) * (2 + 3 * k * lambda);
  const b21 = -(3 * c3 * lambda / (2 * d1)) * (3 * k * lambda - 4);
  const b22 = 3 * c3 * lambda / d1;
  const d21 = -c3 / (2 * l2sq);

  // 三次の項。
  const p = 9 * l2sq + 1 - c2;
  const q = 9 * l2sq + 1 + 2 * c2;
  const a31 = -(9 * lambda / (4 * d2)) * (4 * c3 * (k * a23 - b21) + k * c4 * (4 + k * k))
    + (p / (2 * d2)) * (3 * c3 * (2 * a23 - k * b21) + c4 * (2 + 3 * k * k));
  const a32 = -(9 * lambda / (4 * d2)) * (4 * c3 * (k * a24 - b22) + k * c4)
    - (3 * p / (2 * d2)) * (c3 * (k * b22 + d21 - 2 * a24) - c4);
  const b31 = (3 / (8 * d2)) * (8 * lambda * (3 * c3 * (k * b21 - 2 * a23) - c4 * (2 + 3 * k * k))
    + q * (4 * c3 * (k * a23 - b21) + k * c4 * (4 + k * k)));
  const b32 = (1 / d2) * (9 * lambda * (c3 * (k * b22 + d21 - 2 * a24) - c4)
    + (3 * q / 8) * (4 * c3 * (k * a24 - b22) + k * c4));
  const d31 = (3 / (64 * l2sq)) * (4 * c3 * a24 + c4);
  const d32 = (3 / (64 * l2sq)) * (4 * c3 * (a23 - d21) + c4 * (4 + k * k));

  // 振動数の振幅補正 ω=λ(1+s1Ax²+s2Az²) と、そこから決まる振幅拘束。
  const den = 2 * lambda * (lambda * (1 + k * k) - 2 * k);
  const s1 = (1.5 * c3 * (2 * a21 * (k * k - 2) - a23 * (k * k + 2) - 2 * k * b21)
    - 0.375 * c4 * (3 * k ** 4 - 8 * k * k + 8)) / den;
  const s2 = (1.5 * c3 * (2 * a22 * (k * k - 2) + a24 * (k * k + 2) + 2 * k * b22 + 5 * d21)
    + 0.375 * c4 * (12 - k * k)) / den;
  const a1 = -1.5 * c3 * (2 * a21 + a23 + 5 * d21) - 0.375 * c4 * (12 - k * k);
  const a2 = 1.5 * c3 * (a24 - 2 * a22) + 1.125 * c4;

  return {
    lambda, k, a21, a22, a23, a24, a31, a32, b21, b22, b31, b32, d21, d31, d32, s1, s2,
    l1: a1 + 2 * l2sq * s1, l2: a2 + 2 * l2sq * s2, delta: l2sq - c2,
  };
}

// 面外振幅 az(gamma 単位)に対応する面内振幅(gamma 単位)。az=0 での値が、平面リアプノフ
// 軌道からハローが分岐する下限になる。
export function richardsonAmplitudeX(c: RichardsonCoefficients, az: number): number {
  return Math.sqrt(-(c.delta + c.l2 * az * az) / c.l1);
}

// 指定したラグランジュ点(副天体 secondary の L1/L2)まわりのリサジュー軌道初期状態。
// 面内振幅 ax・面外振幅 az は独立に指定でき、面内は線形振動数 λ、面外は独立な線形
// 振動数 ωz で振動する。
export function lissajousState(system: SecondaryFrame, params: LissajousParams): KinematicState {
  const frame = collinearFrame(system, params.point);
  return centerManifoldState(
    system.secondaryState.t, frame, params.ax, params.az, params.phase ?? 0, params.psi ?? 0, frame.omegaZ,
  );
}

// 指定したラグランジュ点まわりのハロー軌道初期状態。面内振幅は面外振幅 az から三次の
// 振幅拘束で決まる(az=0 でも面内振幅は下限値を取り、そこから単調に増える)。
export function haloState(system: SecondaryFrame, params: HaloParams): KinematicState {
  const frame = collinearFrame(system, params.point);
  const ax = haloAmplitudeX(frame, params.az);
  // 拘束が成り立つ = 面内・面外の振動数が一致するので、面外も面内振動数 λ で駆動する。
  // 面外位相を π/2 ずらして面内の x と直交させ、閉じた三次元ループにする。
  return centerManifoldState(
    system.secondaryState.t, frame, ax, params.az,
    params.phase ?? 0, (params.phase ?? 0) + Math.PI / 2, frame.lambda,
  );
}

// 面外振幅 az [m] に対応する面内振幅 [m]。az=0 での値が、平面リアプノフ軌道からハローが
// 分岐する面内振幅の下限になる。
export function haloAmplitudeX(frame: CollinearFrame, az: number): number {
  // 無次元化は gamma 基準(Richardson の局所座標)なので、その単位で解いてから [m] へ戻す。
  const unit = frame.r * frame.gamma;
  return richardsonAmplitudeX(richardsonCoefficients(frame), az / unit) * unit;
}
