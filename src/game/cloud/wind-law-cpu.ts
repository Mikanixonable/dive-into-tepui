// 気圧の場と釣り合う風の法則と、その風に流された 1 歩。傾度風(気圧勾配 = コリオリ + 遠心力)へ
// 摩擦を加えた定常の釣り合いを単一の方程式から算出する。勾配が緩い領域ではコリオリ力が支配的となって
// 地衡風の枝へ、谷が狭く深い所では遠心力が受け持って緯度に依らない枝へ落ちるので、**中緯度の
// 低気圧も熱帯の台風も同じ式から出る。** 赤道でも高気圧側でも有限に留まる。
import * as vec from '../../math/vec3';
import type { Vec3 } from '../../math/vec3';

// 摩擦の減衰率 [1/s]。1/k は風が摩擦で衰える時間で、4.7 h(海上の 8〜20 h と陸上の 3〜6 h のあいだ)。
// この値が風の等圧線を横切る角を決める — 大きく取るほど深く横切り、渦の巻きが緩む。
export const FRICTION_RATE = 5.9e-5;

// 空気の密度 [kg/m³]。気圧 [hPa] を力へ直すのに要る(100 は hPa → Pa の換算)。
const AIR_DENSITY = 1.2;

// 気圧の勾配 [hPa/rad] を加速度 [m/s²] へ直す係数。半径 surfaceRadius [m] の天体の地表で。
// 密度と半径からの換算で、調整値ではない。
function gradientToAcceleration(surfaceRadius: number): number {
  return 100 / (AIR_DENSITY * surfaceRadius);
}

// 等圧線方向の 2 階微分 [hPa/rad²] を角速度の二乗 [1/s²] へ直す係数。半径 surfaceRadius [m] の
// 天体の地表で。密度と半径からの換算で、調整値ではない。
function bendToSpinSquared(surfaceRadius: number): number {
  return 100 / (AIR_DENSITY * surfaceRadius ** 2);
}

// コリオリ因子 f = coriolisRate sin φ [1/s] の係数(= 2Ω)。rotationPeriod は自転周期 [s]。
function coriolisRate(rotationPeriod: number): number {
  return (4 * Math.PI) / rotationPeriod;
}

// 渦の回る向きが決まらなくなる、赤道を挟む幅(sin 緯度で測る)。向きは周りの自転が渦へ渡すので、
// コリオリ力の消える赤道では決まらない — 符号で切り替えると、そこで風が跳ぶ。熱帯低気圧の
// 生まれない緯度(5°)に取る。外側ではほぼ ±1 で、15° の台風の巻きは 1% も鈍らない。
const SPIN_SENSE_WIDTH = Math.sin((5 * Math.PI) / 180);

// 等圧線方向の単位接ベクトル(北半球の低気圧を回る向き)。
export function isobarAtCpu(direction: Vec3, gradient: Vec3): Vec3 {
  return vec.scale(vec.cross(direction, gradient), 1 / Math.max(vec.len(gradient), 1e-6));
}

// 釣り合った風。velocity は [m/s] の接ベクトル、turn は流れが向きを変える
// 角速度 [rad/s](天頂まわりに右ねじ正)。曲率半径は |velocity| / turn。
export interface BalancedWindCpu {
  readonly velocity: Vec3;
  readonly turn: number;
}

// 局所の気圧から出た釣り合い風。gradient は気圧の勾配 [hPa/rad] の接ベクトル、isobar は isobarAtCpu
// の向き、bend は等圧線に沿う向きの 2 階微分 [hPa/rad²]、friction は摩擦の減衰率 [1/s]。
// maxCrossing は等圧線を横切る角の上限 [rad]。surfaceRadius は天体の半径 [m]、
// rotationPeriod は自転周期 [s]。
export function balancedWindCpu(
  gradient: Vec3, isobar: Vec3, bend: number, latitude: number, friction: number,
  maxCrossing: number, surfaceRadius: number, rotationPeriod: number,
): BalancedWindCpu {
  const sinLatitude = Math.sin(latitude);
  const coriolis = sinLatitude * coriolisRate(rotationPeriod);
  const damped = Math.hypot(coriolis, friction);
  const spinSquared = bend * bendToSpinSquared(surfaceRadius);
  const denominator = damped
    + Math.sqrt(Math.max(damped * damped + 4 * spinSquared, friction ** 2));
  const speed = vec.len(gradient) * 2 * gradientToAcceleration(surfaceRadius) / denominator;
  const spinSense = Math.tanh(sinLatitude / SPIN_SENSE_WIDTH);
  const spin = spinSquared * 2 / denominator * spinSense;
  const along = coriolis + spin;
  const equatorial = 1 - Math.abs(spinSense);
  const crossingFriction = Math.min(
    friction,
    Math.max(Math.abs(along), Math.abs(coriolis)) * Math.tan(maxCrossing)
      + equatorial * friction,
  );
  const gradientHat = vec.scale(gradient, 1 / Math.max(vec.len(gradient), 1e-6));
  const alongVector = vec.sub(
    vec.scale(isobar, along), vec.scale(gradientHat, crossingFriction));
  return {
    velocity: vec.scale(alongVector, speed / Math.hypot(along, crossingFriction)),
    turn: spin,
  };
}

// wind に seconds 秒だけ流された変位 [m]。direction はその点の天頂で、
// seconds を負に取れば来た弧をそのまま遡る。流れは曲率半径 |velocity| / turn の円をたどるので、
// 変位はその弦 — 渦の芯では直径 2 r_c に収まる。
export function windStepCpu(wind: BalancedWindCpu, direction: Vec3, seconds: number): Vec3 {
  const half = wind.turn * seconds * 0.5;
  // 弦は sin(half)/half に比例する。この比は偶関数なので、0 割りの床は絶対値の側だけで足りる。
  const angle = Math.max(Math.abs(half), 1e-6);
  return vec.scale(
    vec.add(
      vec.scale(wind.velocity, Math.cos(half)),
      vec.scale(vec.cross(direction, wind.velocity), Math.sin(half))),
    (Math.sin(angle) / angle) * seconds);
}

// balancedWindCpu と同じ釣り合いを、等圧線方向の 2 階微分が bend [hPa/rad²] で勾配の消える谷の芯に
// ついて解いた、風が等圧線を横切る角 [rad]。**渦が小さく速いほど閉じる。** surfaceRadius は
// 天体の半径 [m]、rotationPeriod は自転周期 [s]。
export function coreCrossingAngle(
  bend: number, latitude: number, surfaceRadius: number, rotationPeriod: number,
): number {
  const sinLatitude = Math.abs(Math.sin(latitude));
  const coriolis = coriolisRate(rotationPeriod) * sinLatitude;
  const damped = Math.hypot(coriolis, FRICTION_RATE);
  const spinSquared = bendToSpinSquared(surfaceRadius) * bend;
  const spin = 2 * spinSquared
    / (damped + Math.sqrt(Math.max(damped * damped + 4 * spinSquared, FRICTION_RATE ** 2)));
  return Math.atan2(FRICTION_RATE, coriolis + spin * Math.tanh(sinLatitude / SPIN_SENSE_WIDTH));
}
