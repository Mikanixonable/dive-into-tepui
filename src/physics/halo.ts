// 円制限三体問題(CR3BP)の共線ラグランジュ点(L1/L2)まわりの周期・準周期軌道の初期状態。
// ラグランジュ点の位置と回転フレームの姿勢/角速度は ephemeris.ts の既存 API
// (emLagrangeAt/seLagrangeAt/moonOrbitRotationAt/sunOrbitRotationAt)からそのまま取り、
// ここでは基底・法線を作り直さない。
//
// 面内・面外の運動は Richardson (1980) の記法に従う。線形解では面内振動数 λ と面外振動数
// ωz=√c2 が一致しないため、一次の範囲でハロー軌道(閉じた三次元ループ)は存在しない。
// ハロー軌道は三次の振幅拘束 l1·Ax² + l2·Az² + Δ = 0 が成り立つときに両振動数が一致して
// 現れるので、haloState は面外振幅 Az からこの拘束で面内振幅 Ax を決め、そのうえで線形解を
// 面内振動数で駆動する。lissajousState は拘束を課さず、面内・面外を独立な振幅・振動数で
// 振動させる(一般に非共鳴なので準周期のリサジュー図形になる)。
//
// 位置・速度そのものは一次の線形解であり、三次の級数展開までは含まない。またゲームの積分器は
// 地球中心二体 + J2 + 抗力 + 日月三体であって制限三体問題そのものではないため、ここで返した
// 状態を実際にゲーム内で積分すると軌道はドリフトする。
import { Ephemeris, MU_MOON, MU_SUN } from './ephemeris';
import { MU_EARTH, OrbitState, orbitState } from './orbital-state';
import { Vec3, add, cross, len, scale, sub, v3 } from './vec3';

export type LibrationSystem = 'earthMoon' | 'sunEarth';
export type LibrationPoint = 'L1' | 'L2';

// 共線ラグランジュ点まわりの回転局所基底とその線形化パラメータ。
// origin: L点の ECI 位置。xHat: 主天体→副天体方向。zHat: 系の公転面法線。
// yHat = zHat × xHat で右手系を作る。omega: 回転フレームの角速度(ECI 成分、大きさが
// 無次元化の時間単位 n)。r: 主天体・副天体間距離 [m]。gamma: 副天体から L点までの距離を
// r で割った無次元値。lambda: 面内線形振動数、omegaZ: 面外線形振動数、kappa: 面内運動の
// y/x 振幅比(いずれも τ=n·t を単位とする無次元量)。
export interface CollinearFrame {
  origin: Vec3;
  xHat: Vec3;
  yHat: Vec3;
  zHat: Vec3;
  omega: Vec3;
  r: number;
  gamma: number;
  mu: number;
  lambda: number;
  omegaZ: number;
  kappa: number;
}

// 共線点における Richardson (1980) の cn 係数。gamma は副天体から L点までの距離を
// 主天体-副天体間距離で割った無次元値。L1/L2 で分母と符号が異なる。
function cn(point: LibrationPoint, mu: number, gamma: number, n: number): number {
  const sign = (-1) ** n;
  if (point === 'L1') {
    return (mu + sign * (1 - mu) * gamma ** (n + 1) / (1 - gamma) ** (n + 1)) / gamma ** 3;
  }
  return sign * (mu + (1 - mu) * gamma ** (n + 1) / (1 + gamma) ** (n + 1)) / gamma ** 3;
}

// 指定した系・L点における共線点まわりの回転局所基底と線形化パラメータを組み立てる。
// 位置・回転フレームは ephemeris.ts の既存 API から取得し、質量比・距離比だけをここで
// 計算する。gamma(副天体から L点までの距離の比)は ephemeris.ts が内部に持つ近似値を
// 公開していないため、公開済みの L点座標から逆算して一貫性を取る。
export function collinearFrame(system: LibrationSystem, point: LibrationPoint, t: number, ephemeris: Ephemeris): CollinearFrame {
  let primaryPos: Vec3;
  let secondaryPos: Vec3;
  let omega: Vec3;
  let normal: Vec3;
  let mu: number;
  let origin: Vec3;
  if (system === 'earthMoon') {
    secondaryPos = ephemeris.moonPosAt(t);
    primaryPos = v3(0, 0, 0);
    omega = ephemeris.moonOrbitRotationAt(t).omega;
    // 月回転系の omega は白道法線まわりの公転成分と黄道極まわりの昇交点歳差成分の和
    // なので、omega の向きそのものは白道の法線と一致しない(ephemeris.ts 参照)。
    // 公転面法線は moonOrbitNormalAt から直接取る。
    normal = ephemeris.moonOrbitNormalAt(t);
    mu = MU_MOON / (MU_EARTH + MU_MOON);
    origin = ephemeris.emLagrangeAt(t)[point];
  } else {
    primaryPos = ephemeris.sunPosAt(t);
    secondaryPos = v3(0, 0, 0);
    omega = ephemeris.sunOrbitRotationAt(t).omega;
    normal = scale(omega, 1 / len(omega)); // 太陽回転系の omega は黄道法線そのもの
    mu = MU_EARTH / (MU_SUN + MU_EARTH);
    origin = ephemeris.seLagrangeAt(t)[point];
  }

  const rVec = sub(secondaryPos, primaryPos);
  const r = len(rVec);
  const xHat = scale(rVec, 1 / r);
  const zHat = normal;
  const yHat = cross(zHat, xHat);

  const gamma = len(sub(origin, secondaryPos)) / r;
  const c2 = cn(point, mu, gamma, 2);

  // 面内特性方程式 λ⁴+(c2-2)λ²-(2c2+1)(c2-1)=0 の判別式は 9c2²-8c2 に簡約でき、
  // 正の根が振動解を与える(負の根は双曲解で、ここでは使わない)。
  const disc = Math.sqrt(9 * c2 * c2 - 8 * c2);
  const lambda2 = (disc - c2 + 2) / 2;
  const lambda = Math.sqrt(lambda2);
  const omegaZ = Math.sqrt(c2);
  // 面内運動 x=Ax cos(λτ+φ), y=κAx sin(λτ+φ) を線形化方程式へ代入して得る振幅比。
  const kappa = (2 * lambda) / (c2 - 1 - lambda2);

  return { origin, xHat, yHat, zHat, omega, r, gamma, mu, lambda, omegaZ, kappa };
}

export interface LissajousParams {
  readonly system: LibrationSystem;
  readonly point: LibrationPoint;
  readonly ax: number; // 面内振幅 [m]
  readonly az: number; // 面外振幅 [m]
  readonly phase?: number; // 面内位相 [rad]、既定 0(軌道上のどこに置くかを選ぶ)
  readonly psi?: number; // 面外位相 [rad]、既定 0
}

export interface HaloParams {
  readonly system: LibrationSystem;
  readonly point: LibrationPoint;
  readonly az: number; // 面外振幅 [m](面内振幅は三次の振幅拘束から決まる)
  readonly phase?: number; // 面内位相 [rad]、既定 0
}

// L点局所基底での線形解(無次元、位相 phase/psi での位置・速度)から ECI の OrbitState を
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
): OrbitState {
  const { lambda, kappa, r: R, omega } = frame;
  const n = len(omega); // 回転フレームの角速度(無次元時間 τ=n·t の単位)

  const axN = ax / R;
  const azN = az / R;

  const x = axN * Math.cos(phase);
  const y = kappa * axN * Math.sin(phase);
  const z = azN * Math.sin(psi);
  const xDot = -axN * lambda * Math.sin(phase);
  const yDot = kappa * axN * lambda * Math.cos(phase);
  const zDot = azN * zFreq * Math.cos(psi);

  const relPos = add(add(scale(frame.xHat, x * R), scale(frame.yHat, y * R)), scale(frame.zHat, z * R));
  const relVel = add(
    add(scale(frame.xHat, xDot * R * n), scale(frame.yHat, yDot * R * n)),
    scale(frame.zHat, zDot * R * n),
  );

  const rEci = add(frame.origin, relPos);
  const vEci = add(relVel, cross(omega, rEci));
  return orbitState(t, rEci, vEci);
}

// Richardson (1980) 三次近似の振幅拘束 l1·Ax² + l2·Az² + Δ = 0 における (l1, l2, Δ)。
// いずれも gamma で正規化した無次元量で、この拘束が成り立つとき面内・面外の振動数が
// 一致してハロー軌道になる。
function haloConstraint(frame: CollinearFrame, point: LibrationPoint): { l1: number; l2: number; delta: number } {
  const { mu, gamma, lambda } = frame;
  const c2 = cn(point, mu, gamma, 2);
  const c3 = cn(point, mu, gamma, 3);
  const c4 = cn(point, mu, gamma, 4);
  const l2sq = lambda * lambda;
  // kappa と符号だけが違う Richardson の振幅比。以降の係数はこの k で書かれている。
  const k = (l2sq + 1 + 2 * c2) / (2 * lambda);

  const d1 = (3 * l2sq / k) * (k * (6 * l2sq - 1) - 2 * lambda);

  const a21 = 3 * c3 * (k * k - 2) / (4 * (1 + 2 * c2));
  const a22 = 3 * c3 / (4 * (1 + 2 * c2));
  const a23 = -(3 * c3 * lambda / (4 * k * d1)) * (3 * k ** 3 * lambda - 6 * k * (k - lambda) + 4);
  const a24 = -(3 * c3 * lambda / (4 * k * d1)) * (2 + 3 * k * lambda);
  const b21 = -(3 * c3 * lambda / (2 * d1)) * (3 * k * lambda - 4);
  const b22 = 3 * c3 * lambda / d1;
  const d21 = -c3 / (2 * l2sq);

  const den = 2 * lambda * (lambda * (1 + k * k) - 2 * k);
  const s1 = (1.5 * c3 * (2 * a21 * (k * k - 2) - a23 * (k * k + 2) - 2 * k * b21)
    - 0.375 * c4 * (3 * k ** 4 - 8 * k * k + 8)) / den;
  const s2 = (1.5 * c3 * (2 * a22 * (k * k - 2) + a24 * (k * k + 2) + 2 * k * b22 + 5 * d21)
    + 0.375 * c4 * (12 - k * k)) / den;

  const a1 = -1.5 * c3 * (2 * a21 + a23 + 5 * d21) - 0.375 * c4 * (12 - k * k);
  const a2 = 1.5 * c3 * (a24 - 2 * a22) + 1.125 * c4;

  return { l1: a1 + 2 * l2sq * s1, l2: a2 + 2 * l2sq * s2, delta: l2sq - c2 };
}

// 指定したラグランジュ点(earthMoon/sunEarth の L1/L2)まわりのリサジュー軌道初期状態。
// 面内振幅 ax・面外振幅 az は独立に指定でき、面内は線形振動数 λ、面外は独立な線形
// 振動数 ωz で振動する。
export function lissajousState(t: number, ephemeris: Ephemeris, params: LissajousParams): OrbitState {
  const frame = collinearFrame(params.system, params.point, t, ephemeris);
  return centerManifoldState(
    t, frame, params.ax, params.az, params.phase ?? 0, params.psi ?? 0, frame.omegaZ,
  );
}

// 指定したラグランジュ点まわりのハロー軌道初期状態。面内振幅は面外振幅 az から三次の
// 振幅拘束で決まる(az=0 でも面内振幅は下限値を取り、そこから単調に増える)。
export function haloState(t: number, ephemeris: Ephemeris, params: HaloParams): OrbitState {
  const frame = collinearFrame(params.system, params.point, t, ephemeris);
  const ax = haloAmplitudeX(frame, params.point, params.az);
  // 拘束が成り立つ = 面内・面外の振動数が一致するので、面外も面内振動数 λ で駆動する。
  // 面外位相を π/2 ずらして面内の x と直交させ、閉じた三次元ループにする。
  return centerManifoldState(t, frame, ax, params.az, params.phase ?? 0, (params.phase ?? 0) + Math.PI / 2, frame.lambda);
}

// 面外振幅 az [m] に対応する面内振幅 [m]。az=0 での値が、平面リアプノフ軌道からハローが
// 分岐する面内振幅の下限になる。
export function haloAmplitudeX(frame: CollinearFrame, point: LibrationPoint, az: number): number {
  const { l1, l2, delta } = haloConstraint(frame, point);
  // 無次元化は gamma 基準(Richardson の局所座標)なので、その単位で解いてから [m] へ戻す。
  const azN = az / (frame.r * frame.gamma);
  return Math.sqrt(-(delta + l2 * azN * azN) / l1) * frame.r * frame.gamma;
}
