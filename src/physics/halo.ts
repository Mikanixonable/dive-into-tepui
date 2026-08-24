// 円制限三体問題(CR3BP)の共線ラグランジュ点(L1/L2/L3)まわりの解析解。共線点の局所基底と
// 無次元パラメータ、Richardson (1980) の三次近似の係数と軌道形状、そして線形解から組んだ
// ハロー軌道・リサジュー軌道の初期状態を持つ。
// ラグランジュ点の位置と回転フレームの姿勢/角速度は ephemeris.ts の既存 API
// (lagrangeAt/orbitFrameRotationAt/orbitNormalAt)からそのまま取り、ここでは基底・法線を
// 作り直さない。
//
// 線形解では面内振動数 λ と面外振動数 ωz=√c2 が一致しないため、一次の範囲でハロー軌道
// (閉じた三次元ループ)は存在しない。ハロー軌道は三次の振幅拘束 l1·Ax² + l2·Az² + Δ = 0 が
// 成り立つときに両振動数が一致して現れるので、面外振幅 Az からこの拘束で面内振幅 Ax を決める。
//
// haloState/lissajousState が返す位置・速度は一次の線形解にとどまる。またゲームの積分器は
// 地球中心二体 + J2 + 抗力 + 日月三体であって制限三体問題そのものではないため、ここで返した
// 状態を実際にゲーム内で積分すると軌道はドリフトする。
import { Ephemeris } from './ephemeris';
import { OrbitingId } from './celestial-body';
import { bodyDef, primaryOf } from './solar-system';
import { KinematicState, kinematicState } from './kinematic-state';
import { Vec3, add, cross, len, scale, sub } from './vec3';
import { Vec3Tuple } from './cr3bp';
import { collinearGamma } from './lagrange';

export type CollinearPoint = 'L1' | 'L2' | 'L3';

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
  // 面内運動 x=Ax cos(λτ+φ), y=κAx sin(λτ+φ) を線形化方程式へ代入して得る振幅比。
  return { lambda, omegaZ: Math.sqrt(c2), kappa: (2 * lambda) / (c2 - 1 - lambda2) };
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

// 質量比から共線点の無次元パラメータを解く。
export function collinearParams(point: CollinearPoint, mu: number): CollinearParams {
  const gamma = collinearGamma(mu, point);
  return { point, mu, gamma, ...linearParams(cn(point, mu, gamma, 2)) };
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

// CR3BP 回転系の位置を L点局所座標(gamma 単位)へ移す。
export function collinearBarycentricToLocal(params: CollinearParams, bary: Vec3Tuple): Vec3Tuple {
  const xL = collinearBarycentricX(params);
  return [(bary[0] - xL) / params.gamma, bary[1] / params.gamma, bary[2] / params.gamma];
}

// 指定した副天体・L点における共線点まわりの回転局所基底と線形化パラメータを組み立てる。
// 位置・回転フレームは ephemeris.ts の既存 API から取得し、質量比・距離比だけをここで
// 計算する。gamma は ephemeris.ts が内部に持つ近似値を公開していないため、公開済みの
// L点座標から逆算して一貫性を取る。
export function collinearFrame(secondary: OrbitingId, point: CollinearPoint, t: number, ephemeris: Ephemeris): CollinearFrame {
  const def = bodyDef(ephemeris.registry, secondary);
  const primary = primaryOf(ephemeris.registry, secondary);
  if (primary === null) throw new Error(`collinearFrame: ${secondary} に主星が無いレジストリでは共線点は定義できない`);
  const primaryPos = ephemeris.positionOf(primary, t);
  const secondaryPos = ephemeris.positionOf(secondary, t);
  const omega = ephemeris.orbitFrameRotationAt(secondary, t).omega;
  // 回転フレームの omega は公転面法線まわりの公転成分と昇交点歳差成分の和になりうる
  // (kepler-orbit.ts 参照)ので、omega の向きそのものが公転面法線と一致するとは限らない。
  // 歳差の有無によらず正しい公転面法線を orbitNormalAt から直接取る。
  const normal = ephemeris.orbitNormalAt(secondary, t);
  const mu = def.mu / (bodyDef(ephemeris.registry, primary).mu + def.mu);
  const origin = ephemeris.lagrangeAt(secondary, t)[point];

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
  readonly secondary: OrbitingId;
  readonly point: CollinearPoint;
  readonly ax: number; // 面内振幅 [m]
  readonly az: number; // 面外振幅 [m]
  readonly phase?: number; // 面内位相 [rad]、既定 0(軌道上のどこに置くかを選ぶ)
  readonly psi?: number; // 面外位相 [rad]、既定 0
}

export interface HaloParams {
  readonly secondary: OrbitingId;
  readonly point: CollinearPoint;
  readonly az: number; // 面外振幅 [m](面内振幅は三次の振幅拘束から決まる)
  readonly phase?: number; // 面内位相 [rad]、既定 0
}

// L点局所基底での線形解(無次元、位相 phase/psi での位置・速度)から ECI の KinematicState を
// 組み立てる。回転フレーム相対速度から ECI 速度への変換は frame.ts の toInertialState と
// 同じ関係 v = v_rel + ω×r(r は原点=地球からの絶対位置)による。
function centerManifoldState(
  t: number,
  frame: CollinearFrame,
  ax: number,
  az: number,
  phase: number,
  psi: number,
  zFreq: number,
): KinematicState {
  const { lambda, kappa, r: R, omega } = frame;
  const n = len(omega); // 回転フレームの角速度(無次元時間 τ=n·t の単位)

  const axN = ax / R;
  const azN = az / R;

  // 面内(x,y)は λ で振動し、面外(z)はハロー軌道なら同じ λ、リサジューなら独立な zFreq で振動する。
  const x = axN * Math.cos(phase);
  const y = kappa * axN * Math.sin(phase);
  const z = azN * Math.sin(psi);
  const xDot = -axN * lambda * Math.sin(phase);
  const yDot = kappa * axN * lambda * Math.cos(phase);
  const zDot = azN * zFreq * Math.cos(psi);

  // フレーム基底で組んだ無次元の位置・速度を、実長さ R でスケールして ECI 軸へ戻す。
  const relPos = add(add(scale(frame.xHat, x * R), scale(frame.yHat, y * R)), scale(frame.zHat, z * R));
  const relVel = add(
    add(scale(frame.xHat, xDot * R * n), scale(frame.yHat, yDot * R * n)),
    scale(frame.zHat, zDot * R * n),
  );

  // 回転フレーム相対の状態を絶対位置へ平行移動し、フレームの角速度ぶんを足して ECI 速度にする。
  const rEci = add(frame.origin, relPos);
  const vEci = add(relVel, cross(omega, rEci));
  return kinematicState(t, rEci, vEci);
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

// Richardson 三次近似の軌道上の1点。位相 tau=ωτ、振幅 ax/az は gamma 単位の無次元量で、
// northern が真なら面外の突出が公転面法線側(北)を向く。返す位置は L点局所座標(gamma 単位)。
// ax=0 なら垂直リヤプノフ的な8の字、az=0 なら平面リヤプノフ的な閉曲線になる。
export function richardsonPoint(
  c: RichardsonCoefficients, ax: number, az: number, northern: boolean, tau: number,
): Vec3Tuple {
  // 面内 x は cos、y は sin、面外 z は cos の級数で、いずれも 3τ までを取る。
  const dn = northern ? 1 : -1;
  const x = c.a21 * ax * ax + c.a22 * az * az - ax * Math.cos(tau)
    + (c.a23 * ax * ax - c.a24 * az * az) * Math.cos(2 * tau)
    + (c.a31 * ax ** 3 - c.a32 * ax * az * az) * Math.cos(3 * tau);
  const y = c.k * ax * Math.sin(tau)
    + (c.b21 * ax * ax - c.b22 * az * az) * Math.sin(2 * tau)
    + (c.b31 * ax ** 3 - c.b32 * ax * az * az) * Math.sin(3 * tau);
  const z = dn * (az * Math.cos(tau) + c.d21 * ax * az * (Math.cos(2 * tau) - 3)
    + (c.d32 * az * ax * ax - c.d31 * az ** 3) * Math.cos(3 * tau));
  return [x, y, z];
}

// 面外振幅 az(gamma 単位)に対応する面内振幅(gamma 単位)。az=0 での値が、平面リアプノフ
// 軌道からハローが分岐する下限になる。
export function richardsonAmplitudeX(c: RichardsonCoefficients, az: number): number {
  return Math.sqrt(-(c.delta + c.l2 * az * az) / c.l1);
}

// Richardson 三次近似での軌道周期(τ=n·t 単位)。
export function richardsonPeriod(c: RichardsonCoefficients, ax: number, az: number): number {
  return (2 * Math.PI) / (c.lambda * (1 + c.s1 * ax * ax + c.s2 * az * az));
}

// 指定したラグランジュ点(副天体 secondary の L1/L2)まわりのリサジュー軌道初期状態。
// 面内振幅 ax・面外振幅 az は独立に指定でき、面内は線形振動数 λ、面外は独立な線形
// 振動数 ωz で振動する。
export function lissajousState(t: number, ephemeris: Ephemeris, params: LissajousParams): KinematicState {
  const frame = collinearFrame(params.secondary, params.point, t, ephemeris);
  return centerManifoldState(
    t, frame, params.ax, params.az, params.phase ?? 0, params.psi ?? 0, frame.omegaZ,
  );
}

// 指定したラグランジュ点まわりのハロー軌道初期状態。面内振幅は面外振幅 az から三次の
// 振幅拘束で決まる(az=0 でも面内振幅は下限値を取り、そこから単調に増える)。
export function haloState(t: number, ephemeris: Ephemeris, params: HaloParams): KinematicState {
  const frame = collinearFrame(params.secondary, params.point, t, ephemeris);
  const ax = haloAmplitudeX(frame, params.az);
  // 拘束が成り立つ = 面内・面外の振動数が一致するので、面外も面内振動数 λ で駆動する。
  // 面外位相を π/2 ずらして面内の x と直交させ、閉じた三次元ループにする。
  return centerManifoldState(t, frame, ax, params.az, params.phase ?? 0, (params.phase ?? 0) + Math.PI / 2, frame.lambda);
}

// 面外振幅 az [m] に対応する面内振幅 [m]。az=0 での値が、平面リアプノフ軌道からハローが
// 分岐する面内振幅の下限になる。
export function haloAmplitudeX(frame: CollinearFrame, az: number): number {
  // 無次元化は gamma 基準(Richardson の局所座標)なので、その単位で解いてから [m] へ戻す。
  const unit = frame.r * frame.gamma;
  return richardsonAmplitudeX(richardsonCoefficients(frame), az / unit) * unit;
}
