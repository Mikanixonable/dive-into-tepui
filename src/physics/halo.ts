// 円制限三体問題(CR3BP)の共線ラグランジュ点(L1/L2)まわりの周期・準周期軌道の初期状態。
// ラグランジュ点の位置と回転フレームの姿勢/角速度は ephemeris.ts の既存 API
// (lagrangeAt/orbitFrameRotationAt/orbitNormalAt)からそのまま取り、ここでは基底・法線を
// 作り直さない。
//
// 面内・面外の運動は Richardson (1980) の記法に従う。線形解では面内振動数 λ と面外振動数
// ωz=√c2 が一致しないため、一次の範囲でハロー軌道(閉じた三次元ループ)は存在しない。
// ハロー軌道は三次の振幅拘束 l1·Ax² + l2·Az² + Δ = 0 が成り立つときに両振動数が一致して
// 現れるので、haloAmplitudeX は面外振幅 Az からこの拘束で面内振幅 Ax を決める。
// lissajousState はこの拘束を課さず線形解のみで、面内・面外を独立な振幅・振動数で
// 振動させる(一般に非共鳴なので準周期のリサジュー図形になる)。
//
// haloState/haloOrbitOffsetsFor は cr3bp.ts の数値修正法(differential correction)で
// Richardson 3次解を種に真に周期的な軌道を求め、それを継続法(continuation)で目標振幅まで
// 連続的に追跡する。Richardson の級数展開は小〜中振幅でしか妥当ではなく、NRHO 級の大振幅
// (L2 ハロー族が垂直リアプノフ軌道へ分岐する近傍)では発散するため、この数値修正が
// 大振幅での正確さの根拠になる。haloState は修正が収束しない場合のみ線形1次解
// (lissajousState と同じ centerManifoldState)にフォールバックする。haloOrbitOffsetsFor
// (マップ上のハロー軌道参照ライン用)は解析的な近似解へフォールバックせず、収束しなければ
// 空を返す。
//
// いずれの経路も CR3BP そのものの解であり、ゲームの積分器(地球中心二体 + J2 + 抗力 +
// 日月三体)とは運動方程式が異なるため、実際にゲーム内で積分すると軌道はドリフトする。
import { Ephemeris } from './ephemeris';
import { OrbitingId } from './attractor';
import { bodyDef, primaryOf } from './solar-system';
import { KinematicState, kinematicState } from './kinematic-state';
import { Vec3, add, cross, len, scale, sub } from './vec3';
import { CorrectedHalo, continueHaloOrbit, correctHaloOrbit, propagateHaloState, sampleHaloOrbitPositions } from './cr3bp';

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

  // d1: 2次係数の分母に現れるスカラー
  const d1 = (3 * l2sq / k) * (k * (6 * l2sq - 1) - 2 * lambda); // 16λ⁴+4λ²(c₂-2)-2c₂²+c₂+1 と等値

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

  return {
    a21, a22, a23, a24, b21, b22, d21,
    l1: a1 + 2 * l2sq * s1,
    l2: a2 + 2 * l2sq * s2,
    delta: l2sq - c2,
  };
}

function haloConstraint(frame: CollinearFrame, point: CollinearPoint): { l1: number; l2: number; delta: number } {
  return haloCoefficients(frame, point);
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
  const halo = correctedHaloOrbit(frame, params.point, params.az);
  if (halo) return haloOrbitState(t, halo, params.phase ?? 0);

  // 数値修正が収束しない極端な振幅などでは、線形1次解へフォールバックする。
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

// L点のバリセントリック x 座標(CR3BP 無次元、原点=系の重心、+x=主天体→副天体、
// 距離の単位は主天体・副天体間距離 r)。cn() の分母・符号が L1/L2 で異なるのと同じ幾何。
function collinearPointX(point: CollinearPoint, mu: number, gamma: number): number {
  return point === 'L1' ? 1 - mu - gamma : 1 - mu + gamma;
}

// CollinearFrame 上で数値修正済みの真の周期軌道(CR3BP 無次元座標)。frame/point/mu/xl は
// haloOrbitState/haloOrbitOffsets が ECI へ戻すのに要る。
export interface HaloOrbit {
  readonly frame: CollinearFrame;
  readonly point: CollinearPoint;
  readonly mu: number;
  readonly xl: number;
  readonly orbit: CorrectedHalo;
}

// 継続法の1ステップあたり z0 の最大変化(無次元)。小さいほど NRHO 級の大振幅まで安定して
// 追跡できるが、その分ステップ数(=積分回数)が増える。
const HALO_CONTINUATION_STEP_Z0 = 0.005;

// ハロー族は面内リアプノフ軌道(Az=0)から分岐するので、まずその平面軌道(Richardson 線形解を
// 種に数値修正した真の周期軌道)を種にし、そこから継続法で Az まで面外振幅を伸ばして
// 真に周期的な軌道(ハロー/NRHO)を数値修正で求める。収束しなければ null(呼び出し側は
// 解析解にフォールバックする)。
export function correctedHaloOrbit(frame: CollinearFrame, point: CollinearPoint, az: number): HaloOrbit | null {
  const xl = collinearPointX(point, frame.mu, frame.gamma);
  const rDim = frame.r;
  const planarAx = haloAmplitudeX(frame, point, 0);
  if (!Number.isFinite(planarAx) || planarAx <= 0) return null;

  // x=+Ax·cos(τ) の位相規約(centerManifoldState と同じ)での面内固有ベクトルの比は -kappa
  // (kappa 自体は haloLocalPosition の x=-Ax·cos(τ) 規約に合わせて定義されているため符号が要る)。
  const planarSeed = { x0: xl + planarAx / rDim, z0: 0, vy0: (-frame.kappa * frame.lambda * planarAx) / rDim };
  const planarOrbit = correctHaloOrbit(frame.mu, planarSeed, Math.PI / frame.lambda);
  if (!planarOrbit) return null;

  const targetZ0 = az / rDim;
  const corrected = continueHaloOrbit(frame.mu, planarOrbit, planarOrbit.halfPeriod, targetZ0, HALO_CONTINUATION_STEP_Z0);
  if (!corrected) return null;
  return { frame, point, mu: frame.mu, xl, orbit: corrected };
}

// CR3BP 無次元の回転系相対位置(バリセントリック x を含む)を、frame が定める ECI 軸へ戻す。
function offsetToEci(frame: CollinearFrame, xl: number, x: number, y: number, z: number): Vec3 {
  const r = frame.r;
  return add(add(scale(frame.xHat, (x - xl) * r), scale(frame.yHat, y * r)), scale(frame.zHat, z * r));
}

// 修正済み軌道上の位相(0..2π、軌道1周ぶんの無次元角)における ECI 状態。
export function haloOrbitState(t: number, halo: HaloOrbit, phase: number): KinematicState {
  const { frame, xl, mu, orbit } = halo;
  const s = propagateHaloState(mu, orbit, phase);
  const [x, y, z, vx, vy, vz] = [s[0] ?? 0, s[1] ?? 0, s[2] ?? 0, s[3] ?? 0, s[4] ?? 0, s[5] ?? 0];
  const n = len(frame.omega);
  const relPos = offsetToEci(frame, xl, x, y, z);
  const relVel = offsetToEci(frame, 0, vx * n, vy * n, vz * n);
  const rEci = add(frame.origin, relPos);
  const vEci = add(relVel, cross(frame.omega, rEci));
  return kinematicState(t, rEci, vEci);
}

// 修正済み軌道を1周期ぶん count 点、L点原点からの ECI 相対オフセットとしてサンプリングする。
export function haloOrbitOffsets(halo: HaloOrbit, count: number): Vec3[] {
  const raw = sampleHaloOrbitPositions(halo.mu, halo.orbit, count);
  return raw.map((p) => offsetToEci(halo.frame, halo.xl, p.x, p.y, p.z));
}

// ハロー軌道表示ライン用: 数値修正済みの軌道を count 点サンプリングして返す
// (L点原点からの ECI 相対オフセット)。収束しなければ空を返す。
export function haloOrbitOffsetsFor(frame: CollinearFrame, point: CollinearPoint, az: number, count: number): Vec3[] {
  const halo = correctedHaloOrbit(frame, point, az);
  return halo ? haloOrbitOffsets(halo, count) : [];
}
