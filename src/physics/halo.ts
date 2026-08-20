// 円制限三体問題(CR3BP)の共線ラグランジュ点(L1/L2)まわりの周期・準周期軌道の初期状態。
// ラグランジュ点の位置と回転フレームの姿勢/角速度は ephemeris.ts の既存 API
// (lagrangeAt/orbitFrameRotationAt/orbitNormalAt)からそのまま取り、ここでは基底・法線を
// 作り直さない。
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
import { Ephemeris } from './ephemeris';
import { OrbitingId } from './attractor';
import { bodyDef, primaryOf } from './solar-system';
import { KinematicState, kinematicState } from './kinematic-state';
import { Vec3, add, cross, len, scale, sub, v3 } from './vec3';

export type CollinearPoint = 'L1' | 'L2';

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
function cn(point: CollinearPoint, mu: number, gamma: number, n: number): number {
  const sign = (-1) ** n;
  if (point === 'L1') {
    return (mu + sign * (1 - mu) * gamma ** (n + 1) / (1 - gamma) ** (n + 1)) / gamma ** 3;
  }
  return sign * (mu + (1 - mu) * gamma ** (n + 1) / (1 + gamma) ** (n + 1)) / gamma ** 3;
}

// 指定した副天体・L点における共線点まわりの回転局所基底と線形化パラメータを組み立てる。
// 位置・回転フレームは ephemeris.ts の既存 API から取得し、質量比・距離比だけをここで
// 計算する。gamma(副天体から L点までの距離の比)は ephemeris.ts が内部に持つ近似値を
// 公開していないため、公開済みの L点座標から逆算して一貫性を取る。
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

  const gamma = len(sub(origin, secondaryPos)) / r;
  const c2 = cn(point, mu, gamma, 2);

  // 面内特性方程式 λ⁴+(c2-2)λ²-(2c2+1)(c2-1)=0 の判別式は 9c2²-8c2 に簡約でき、
  // 正の根が振動解を与える(負の根は双曲解で、ここでは使わない)。
  const disc = Math.sqrt(9 * c2 * c2 - 8 * c2);
  const lambda2 = (disc - c2 + 2) / 2;
  const lambda = Math.sqrt(lambda2);
  const omegaZ = Math.sqrt(c2);
  // 面内運動 x=Ax cos(λτ+φ), y=κAx sin(λτ+φ) を線形化方程式へ代入して得る振幅比。
  // Richardson (1980) / Fortran-Astrodynamics-Toolkit の定義 k = 2λ/(λ²+1-c₂) > 0 に合わせる。
  // 分母を (c₂-1-λ²) にすると符号が逆転し y 方向が鏡像になるため注意。
  const kappa = (2 * lambda) / (lambda2 + 1 - c2);

  return { origin, xHat, yHat, zHat, omega, r, gamma, mu, lambda, omegaZ, kappa };
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

// Richardson (1980) 三次近似の振幅拘束 l1·Ax² + l2·Az² + Δ = 0 における係数、2次摂動係数、および3次摂動係数。
export interface HaloCoefficients {
  a21: number;
  a22: number;
  a23: number;
  a24: number;
  b21: number;
  b22: number;
  d21: number;
  // 3次摂動係数 (cos(3τ)/sin(3τ) 項)
  a31: number;
  a32: number;
  b31: number;
  b32: number;
  d31: number;
  d32: number;
  l1: number;
  l2: number;
  delta: number;
}

export function haloCoefficients(frame: CollinearFrame, point: CollinearPoint): HaloCoefficients {
  const { mu, gamma, lambda } = frame;
  const c2 = cn(point, mu, gamma, 2);
  const c3 = cn(point, mu, gamma, 3);
  const c4 = cn(point, mu, gamma, 4);
  const l2sq = lambda * lambda;
  // Richardson (1980) の振幅比 k = 2λ/(λ²+1-c₂) > 0。frame.kappa と同じ値。
  // 以降の係数はすべてこの k で書かれている(Fortran-Astrodynamics-Toolkit 参照)。
  const k = (l2sq + 1 + 2 * c2) / (2 * lambda); // = 2λ/(λ²+1-c₂) (characteristic eqn より等値)

  // d1, d2: 2次・3次係数の分母に現れるスカラー
  const d1 = (3 * l2sq / k) * (k * (6 * l2sq - 1) - 2 * lambda); // 16λ⁴+4λ²(c₂-2)-2c₂²+c₂+1 と等値
  const d2 = 81 * l2sq * l2sq + 9 * l2sq * (c2 - 2) - 2 * c2 * c2 + c2 + 1;

  // 2次摂動係数
  const a21 = 3 * c3 * (k * k - 2) / (4 * (1 + 2 * c2));
  const a22 = 3 * c3 / (4 * (1 + 2 * c2));
  const a23 = -(3 * c3 * lambda / (4 * k * d1)) * (3 * k ** 3 * lambda - 6 * k * (k - lambda) + 4);
  const a24 = -(3 * c3 * lambda / (4 * k * d1)) * (2 + 3 * k * lambda);
  const b21 = -(3 * c3 * lambda / (2 * d1)) * (3 * k * lambda - 4);
  const b22 = 3 * c3 * lambda / d1;
  const d21 = -c3 / (2 * l2sq);

  // 振幅拘束係数
  const den = 2 * lambda * (lambda * (1 + k * k) - 2 * k); // = d3 in Fortran
  const s1 = (1.5 * c3 * (2 * a21 * (k * k - 2) - a23 * (k * k + 2) - 2 * k * b21)
    - 0.375 * c4 * (3 * k ** 4 - 8 * k * k + 8)) / den;
  const s2 = (1.5 * c3 * (2 * a22 * (k * k - 2) + a24 * (k * k + 2) + 2 * k * b22 + 5 * d21)
    + 0.375 * c4 * (12 - k * k)) / den;

  const a1 = -1.5 * c3 * (2 * a21 + a23 + 5 * d21) - 0.375 * c4 * (12 - k * k);
  const a2 = 1.5 * c3 * (a24 - 2 * a22) + 1.125 * c4;

  // 3次摂動係数 (Richardson 1980 方程式 19a–19f、Fortran-Astrodynamics-Toolkit 参照)
  const k2 = k * k;
  const lam2c2 = 9 * l2sq + 1 - c2;
  const lam2c2p = 9 * l2sq + 1 + 2 * c2;
  const a31 = -9 * lambda * (c3 * (k * a23 - b21) + k * c4 * (1 + k2 / 4)) / d2
    + lam2c2 * (3 * c3 * (2 * a23 - k * b21) + c4 * (2 + 3 * k2)) / (2 * d2);
  const a32 = -9 * lambda * (4 * c3 * (k * a24 - b22) + k * c4) / (4 * d2)
    - 3 * lam2c2 * (c3 * (k * b22 + d21 - 2 * a24) - c4) / (2 * d2);
  const b31 = (3 * lambda * (3 * c3 * (k * b21 - 2 * a23) - c4 * (2 + 3 * k2))
    + lam2c2p * (12 * c3 * (k * a23 - b21) + 3 * k * c4 * (4 + k2)) / 8) / d2;
  const b32 = (3 * lambda * (3 * c3 * (k * b22 + d21 - 2 * a24) - 3 * c4)
    + lam2c2p * (12 * c3 * (k * a24 - b22) + 3 * c4 * k) / 8) / d2;
  const d31 = 3 * (4 * c3 * a24 + c4) / (64 * l2sq);
  const d32 = 3 * (4 * c3 * (a23 - d21) + c4 * (4 + k2)) / (64 * l2sq);

  return {
    a21, a22, a23, a24, b21, b22, d21,
    a31, a32, b31, b32, d31, d32,
    l1: a1 + 2 * l2sq * s1,
    l2: a2 + 2 * l2sq * s2,
    delta: l2sq - c2,
  };
}

function haloConstraint(frame: CollinearFrame, point: CollinearPoint): { l1: number; l2: number; delta: number } {
  return haloCoefficients(frame, point);
}

// Richardson (1980) 3次精度での共線ラグランジュ点まわりの 3D 位置オフセット [m] (ECI 座標系成分)。
// ax, az はメートル単位の振幅 (az の正負は北側 (+az) / 南側 (-az) ファミリーに対応)。
// phase は 0 から 2π までの位相角 τ₁。
// 参照: Fortran-Astrodynamics-Toolkit / halo_orbit_module.f90 方程式 20a–20c。
export function haloLocalPosition(
  frame: CollinearFrame,
  point: CollinearPoint,
  ax: number,
  az: number,
  phase: number,
): Vec3 {
  const coeffs = haloCoefficients(frame, point);
  const rLocal = frame.r * frame.gamma;
  const axN = ax / rLocal;
  const absAz = Math.abs(az);
  const azN = absAz / rLocal;
  const deltaM = az >= 0 ? 1 : -1;

  const cos1 = Math.cos(phase);
  const sin1 = Math.sin(phase);
  const cos2 = Math.cos(2 * phase);
  const sin2 = Math.sin(2 * phase);
  const cos3 = Math.cos(3 * phase);
  const sin3 = Math.sin(3 * phase);

  const axN2 = axN * axN;
  const axN3 = axN2 * axN;
  const azN2 = azN * azN;
  const azN3 = azN2 * azN;

  // Richardson (1980) 3次展開による無次元局所座標
  // (x: 主天体→副天体軸, y: 公転方向 [kappa>0 を保証], z: 北極方向)
  // frame.kappa = 2λ/(λ²+1-c₂) > 0 (Fortran の k と同値、2次コードでの符号ミスを修正済み)
  const xN = coeffs.a21 * axN2 + coeffs.a22 * azN2
    - axN * cos1
    + (coeffs.a23 * axN2 - coeffs.a24 * azN2) * cos2
    + (coeffs.a31 * axN3 - coeffs.a32 * axN * azN2) * cos3;
  const yN = frame.kappa * axN * sin1
    + (coeffs.b21 * axN2 - coeffs.b22 * azN2) * sin2
    + (coeffs.b31 * axN3 - coeffs.b32 * axN * azN2) * sin3;
  const zN = deltaM * (
    azN * cos1
    + coeffs.d21 * axN * azN * (cos2 - 3)
    + (coeffs.d32 * azN * axN2 - coeffs.d31 * azN3) * cos3
  );

  const x = xN * rLocal;
  const y = yN * rLocal;
  const z = zN * rLocal;

  // ECI 軸上の相対オフセットベクトル
  return v3(
    x * frame.xHat.x + y * frame.yHat.x + z * frame.zHat.x,
    x * frame.xHat.y + y * frame.yHat.y + z * frame.zHat.y,
    x * frame.xHat.z + y * frame.yHat.z + z * frame.zHat.z,
  );
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
  const ax = haloAmplitudeX(frame, params.point, params.az);
  // 拘束が成り立つ = 面内・面外の振動数が一致するので、面外も面内振動数 λ で駆動する。
  // 面外位相を π/2 ずらして面内の x と直交させ、閉じた三次元ループにする。
  return centerManifoldState(t, frame, ax, params.az, params.phase ?? 0, (params.phase ?? 0) + Math.PI / 2, frame.lambda);
}

// 面外振幅 az [m] に対応する面内振幅 [m]。az=0 での値が、平面リアプノフ軌道からハローが
// 分岐する面内振幅の下限になる。
export function haloAmplitudeX(frame: CollinearFrame, point: CollinearPoint, az: number): number {
  const { l1, l2, delta } = haloConstraint(frame, point);
  // 無次元化は gamma 基準(Richardson の局所座標)なので、その単位で解いてから [m] へ戻す。
  const azN = az / (frame.r * frame.gamma);
  return Math.sqrt(-(delta + l2 * azN * azN) / l1) * frame.r * frame.gamma;
}
