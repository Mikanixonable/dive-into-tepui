// 気圧の場と釣り合う風の法則と、その風に流された 1 歩。傾度風(気圧勾配 = コリオリ + 遠心力)へ
// 摩擦を足した定常の釣り合いを 1 本の式で解く。勾配が緩い所ではコリオリが釣り合いを受け持って
// 地衡風の枝へ、谷が狭く深い所では遠心力が受け持って緯度に依らない枝へ落ちるので、**中緯度の
// 低気圧も熱帯の台風も同じ式から出る。** 赤道でも高気圧側でも有限に留まる。
import { abs, cos, cross, length, max, sin, sqrt, tanh } from 'three/tsl';
import { R_EARTH, SIDEREAL_DAY } from '../../physics/solar-system';
import type { FloatNode, Vec3Node } from '../tsl-types';

// 摩擦の減衰率 [1/s]。1/k は風が摩擦で衰える時間で、4.7 h(海上の 8〜20 h と陸上の 3〜6 h のあいだ)。
// この値が風の等圧線を横切る角を決める — 大きく取るほど深く横切り、渦の巻きが緩む。
export const FRICTION_RATE = 5.9e-5;

// 空気の密度 [kg/m³]。気圧 [hPa] を力へ直すのに要る(100 は hPa → Pa の換算)。
const AIR_DENSITY = 1.2;
// 気圧の勾配 [hPa/rad] を加速度 [m/s²] へ、等圧線方向の 2 階微分 [hPa/rad²] を角速度の二乗 [1/s²] へ
// 直す係数。どちらも密度と天体の半径からの換算で、調整値ではない。
const GRADIENT_TO_ACCELERATION = 100 / (AIR_DENSITY * R_EARTH);
const BEND_TO_SPIN_SQUARED = 100 / (AIR_DENSITY * R_EARTH ** 2);
// コリオリ因子 f = CORIOLIS_RATE sin φ [1/s] の係数(= 2Ω)。
const CORIOLIS_RATE = (4 * Math.PI) / SIDEREAL_DAY;
// 渦の回る向きが決まらなくなる、赤道を挟む幅(sin 緯度で測る)。向きは周りの自転が渦へ渡すので、
// コリオリ力の消える赤道では決まらない — 符号で切り替えると、そこで風が跳ぶ。熱帯低気圧の
// 生まれない緯度(5°)に取る。外側ではほぼ ±1 で、15° の台風の巻きは 1% も鈍らない。
const SPIN_SENSE_WIDTH = Math.sin((5 * Math.PI) / 180);

// 等圧線方向の単位接ベクトル。北半球の低気圧を回る向き(南半球では balancedWind が符号を返す)。
export function isobarAt(direction: Vec3Node, gradient: Vec3Node): Vec3Node {
  return cross(direction, gradient).div(max(length(gradient), 1e-6));
}

// 釣り合った風。velocity は [m/s]、turn は流れが向きを変える角速度 [rad/s](天頂まわりに右ねじ正で、
// 北半球の低気圧で正)。曲率半径は |velocity| / turn。
export type BalancedWind = {
  readonly velocity: Vec3Node;
  readonly turn: FloatNode;
};

// gradient は気圧の勾配 [hPa/rad] の接ベクトル、isobar は isobarAt() の向き、bend は等圧線に沿う
// 向きの 2 階微分 [hPa/rad²](= |∇p| ÷ 等圧線の曲率半径。低気圧で正)、friction は摩擦の減衰率
// [1/s]。摩擦を強く取るほど風は遅く、等圧線を深く横切る。
export function balancedWind(
  gradient: Vec3Node, isobar: Vec3Node, bend: FloatNode, latitude: FloatNode, friction: number,
): BalancedWind {
  const sinLatitude = sin(latitude);
  const coriolis = sinLatitude.mul(CORIOLIS_RATE);
  const damped = sqrt(coriolis.mul(coriolis).add(friction ** 2));
  const spinSquared = bend.mul(BEND_TO_SPIN_SQUARED);
  // 判別式の床を 0 に取ると、高気圧側(bend < 0)が厳密な釣り合いから 70% 外れる。
  const denominator = damped.add(sqrt(max(damped.mul(damped).add(spinSquared.mul(4)), friction ** 2)));
  const speed = length(gradient).mul(2 * GRADIENT_TO_ACCELERATION).div(denominator);
  // 流れが渦の中心のまわりを回る角速度 [rad/s]。等圧線に沿う成分はコリオリとこれの和が受け持ち、
  // 受け持ち切れない残りを摩擦が受けて、等圧線を横切る流入になる。赤道で決まらなくなるのは向きだけ
  // なので、落とすのはここだけ — 速さを決める denominator は spinSquared を持ったままにする。
  const spin = spinSquared.mul(2).div(denominator).mul(tanh(sinLatitude.div(SPIN_SENSE_WIDTH)));
  const along = coriolis.add(spin);
  // 向きの長さは √(along² + friction²) で、勾配が消えても 0 にならない。normalize では NaN が出る。
  const velocity = isobar.mul(along).sub(gradient.div(max(length(gradient), 1e-6)).mul(friction))
    .div(sqrt(along.mul(along).add(friction ** 2))).mul(speed);
  return { velocity, turn: spin };
}

// wind に seconds 秒だけ流された変位 [m]。direction はその点の天頂で、seconds を負に取れば来た弧を
// そのまま遡る。流れは曲率半径 |velocity| / turn の円をたどるので、変位はその弦 — 渦の芯では
// 直径 2 r_c に収まる。
export function windStep(wind: BalancedWind, direction: Vec3Node, seconds: FloatNode): Vec3Node {
  const half = wind.turn.mul(seconds).mul(0.5);
  // 弦は sin(half)/half に比例する。この比は偶関数なので、0 割りの床は絶対値の側だけで足りる。
  const angle = max(abs(half), 1e-6);
  return wind.velocity.mul(cos(half)).add(cross(direction, wind.velocity).mul(sin(half)))
    .mul(sin(angle).div(angle).mul(seconds));
}

// balancedWind と同じ釣り合いを、等圧線方向の 2 階微分が bend [hPa/rad²] で勾配の消える谷の芯に
// ついて解いた、風が等圧線を横切る角 [rad]。**渦が小さく速いほど閉じる。**
export function coreCrossingAngle(bend: number, latitude: number): number {
  const sinLatitude = Math.abs(Math.sin(latitude));
  const coriolis = CORIOLIS_RATE * sinLatitude;
  const damped = Math.hypot(coriolis, FRICTION_RATE);
  const spinSquared = BEND_TO_SPIN_SQUARED * bend;
  const spin = 2 * spinSquared
    / (damped + Math.sqrt(Math.max(damped * damped + 4 * spinSquared, FRICTION_RATE ** 2)));
  return Math.atan2(FRICTION_RATE, coriolis + spin * Math.tanh(sinLatitude / SPIN_SENSE_WIDTH));
}
