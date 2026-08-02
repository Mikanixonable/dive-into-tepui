// 円制限三体問題(CR3BP)の共線ラグランジュ点(L1/L2)まわりの線形化解 — ハロー軌道・
// リサジュー軌道の初期状態。ラグランジュ点の位置と回転フレームの姿勢/角速度は
// ephemeris.ts の既存 API(emLagrangeAt/seLagrangeAt/moonOrbitRotationAt/sunOrbitRotationAt)
// からそのまま取り、ここでは基底・法線を作り直さない。
//
// Richardson (1980) の三次近似のうち、面内・面外の振動数を関係づける三次の振幅拘束
// (十数個の高次係数からなる Az-Ax 関係式)は実装していない。線形化(一次)の周期解に
// 留め、リサジュー軌道は面内振動数 λ と面外振動数 ωz を独立に使う(面内・面外振幅を
// 独立に指定できる、線形リサジューそのもの)。ハロー軌道は面外振動数に λ を流用して
// 面内と共鳴させ、閉じた三次元ループにする — 三次拘束による厳密な周期解ではなく、
// 振動数だけを合わせた近似であることに留意。
//
// このモジュールが返す初期状態は、この線形化解を積分し続けた場合にのみ周期軌道になる。
// ゲームの積分器は地球中心二体 + J2 + 抗力 + 日月三体であり制限三体問題そのものでは
// ないため、ここで返した状態を実際にゲーム内で積分すると軌道はドリフトする。
import { Ephemeris, MU_MOON, MU_SUN } from './ephemeris';
import { MU_EARTH, OrbitState, orbitState } from './orbital';
import { Vec3, add, cross, len, scale, sub, v3 } from './vec3';

export type LibrationSystem = 'earthMoon' | 'sunEarth';
export type LibrationPoint = 'L1' | 'L2';

// 共線ラグランジュ点まわりの回転局所基底とその線形化パラメータ。
// origin: L点の ECI 位置。xHat: 主天体→副天体方向。zHat: 系の公転面法線。
// yHat = zHat × xHat で右手系を作る。omega: 回転フレームの角速度(ECI 成分、大きさが
// 無次元化の時間単位 n)。r: 主天体・副天体間距離 [m]。lambda: 面内線形振動数、
// omegaZ: 面外線形振動数、kappa: 面内運動の y/x 振幅比(いずれも τ=n·t を単位とする無次元量)。
export interface CollinearFrame {
  origin: Vec3;
  xHat: Vec3;
  yHat: Vec3;
  zHat: Vec3;
  omega: Vec3;
  r: number;
  lambda: number;
  omegaZ: number;
  kappa: number;
}

// 共線点における Richardson (1980) の c2 係数。gamma は副天体から L点までの距離を
// 主天体-副天体間距離で割った無次元値。L1/L2 で分母の符号だけが異なる。
function c2Coefficient(point: LibrationPoint, mu: number, gamma: number): number {
  if (point === 'L1') {
    return (mu + (1 - mu) * gamma ** 3 / (1 - gamma) ** 3) / gamma ** 3;
  }
  return (mu + (1 - mu) * gamma ** 3 / (1 + gamma) ** 3) / gamma ** 3;
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
  const c2 = c2Coefficient(point, mu, gamma);

  // 面内特性方程式 λ^4+(c2-2)λ^2-(2c2+1)(c2-1)=0 の判別式は 9c2^2-8c2 に簡約でき、
  // 負の根 -ωp^2 が面内の振動(周期)解を、正の根が双曲解(ここでは不使用)を与える。
  const disc = Math.sqrt(9 * c2 * c2 - 8 * c2);
  const omegaP2 = (disc + c2 - 2) / 2;
  const lambda = Math.sqrt(omegaP2);
  const omegaZ = Math.sqrt(c2);
  // 面内運動 x=Ax cos(λτ+φ), y=κAx sin(λτ+φ) を線形化方程式へ代入して得る振幅比。
  const kappa = (2 * lambda) / (c2 - 1 - omegaP2);

  return { origin, xHat, yHat, zHat, omega, r, lambda, omegaZ, kappa };
}

export interface CenterManifoldParams {
  readonly system: LibrationSystem;
  readonly point: LibrationPoint;
  readonly ax: number; // 面内振幅 [m]
  readonly az: number; // 面外振幅 [m]
  readonly phase?: number; // 面内位相 [rad]、既定 0(軌道上のどこに置くかを選ぶ)
  readonly psi?: number; // 面外位相 [rad]、既定 0
}

// L点局所基底での線形化解(無次元、τ=0 での位置・速度)から ECI の OrbitState を
// 組み立てる共通部分。zFreq に面内振動数 λ を渡すとハロー軌道(面内・面外が共鳴し
// 閉じた3次元ループになる)、面外振動数 ωz を渡すとリサジュー軌道(面内・面外が独立)
// になる。回転フレーム相対速度から ECI 速度への変換は frame.ts の toInertialState と
// 同じ関係 v = v_rel + ω×r(r は原点=地球からの絶対位置)による。
function centerManifoldState(
  t: number,
  ephemeris: Ephemeris,
  params: CenterManifoldParams,
  zFreq: (frame: CollinearFrame) => number,
): OrbitState {
  const frame = collinearFrame(params.system, params.point, t, ephemeris);
  const phase = params.phase ?? 0;
  const psi = params.psi ?? 0;
  const { lambda, kappa, r: R, omega } = frame;
  const omegaZv = zFreq(frame);
  const n = len(omega); // 回転フレームの角速度(無次元時間 τ=n·t の単位)

  const ax = params.ax / R;
  const az = params.az / R;

  const x = ax * Math.cos(phase);
  const y = kappa * ax * Math.sin(phase);
  const z = az * Math.sin(psi);
  const xDot = -ax * lambda * Math.sin(phase);
  const yDot = kappa * ax * lambda * Math.cos(phase);
  const zDot = az * omegaZv * Math.cos(psi);

  const relPos = add(add(scale(frame.xHat, x * R), scale(frame.yHat, y * R)), scale(frame.zHat, z * R));
  const relVel = add(
    add(scale(frame.xHat, xDot * R * n), scale(frame.yHat, yDot * R * n)),
    scale(frame.zHat, zDot * R * n),
  );

  const rEci = add(frame.origin, relPos);
  const vEci = add(relVel, cross(omega, rEci));
  return orbitState(t, rEci, vEci);
}

// 指定したラグランジュ点(earthMoon/sunEarth の L1/L2)まわりのリサジュー軌道初期状態。
// 面内振幅 ax・面外振幅 az は独立に指定でき、面内は線形振動数 λ、面外は独立な線形
// 振動数 ωz で振動する(一般に非共鳴なので周期軌道にはならない準周期のリサジュー図形)。
export function lissajousState(t: number, ephemeris: Ephemeris, params: CenterManifoldParams): OrbitState {
  return centerManifoldState(t, ephemeris, params, (f) => f.omegaZ);
}

// 指定したラグランジュ点まわりのハロー軌道初期状態。面外振動を面内と同じ線形振動数 λ
// で駆動することで面内・面外を共鳴させ、閉じた3次元ループにする(モジュール先頭の
// コメント通り、Richardson 三次近似の振幅拘束によるものではない近似)。
export function haloState(t: number, ephemeris: Ephemeris, params: CenterManifoldParams): OrbitState {
  return centerManifoldState(t, ephemeris, params, (f) => f.lambda);
}
