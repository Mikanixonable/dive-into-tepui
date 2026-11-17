// 気圧の場と釣り合う風の法則と、その風に流された 1 歩。傾度風(気圧勾配 = コリオリ + 遠心力)へ
// 摩擦を加えた定常の釣り合いを単一の方程式から算出する。勾配が緩い領域ではコリオリ力が支配的となって
// 地衡風の枝へ、谷が狭く深い所では遠心力が受け持って緯度に依らない枝へ落ちるので、**中緯度の
// 低気圧も熱帯の台風も同じ式から出る。** 赤道でも高気圧側でも有限に留まる。
import { abs, cos, cross, length, max, min, sin, sqrt, tanh } from 'three/tsl';
import type { FloatNode, Vec3Node } from '../tsl-types';

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

// 等圧線方向の単位接ベクトル。北半球の低気圧を回る向き(南半球では balancedWind が符号を返す)。
export function isobarAt(direction: Vec3Node, gradient: Vec3Node): Vec3Node {
  return cross(direction, gradient).div(max(length(gradient), 1e-6));
}

// 釣り合った風。velocity は [m/s]、turn は流れが向きを変える角速度 [rad/s](天頂まわりに右ねじ正で、
// 北半球の低気圧で正)。曲率半径は |velocity| / turn。
export interface BalancedWind {
  readonly velocity: Vec3Node;
  readonly turn: FloatNode;
}

// 局所の気圧から出た風 local へ、全球の背景流 background [m/s] を足す。流れが向きを変える角速度は
// local のものを保つ。
export function composeWind(local: BalancedWind, background: Vec3Node): BalancedWind {
  return { velocity: local.velocity.add(background), turn: local.turn };
}

// gradient は気圧の勾配 [hPa/rad] の接ベクトル、isobar は isobarAt() の向き、bend は等圧線に沿う
// 向きの 2 階微分 [hPa/rad²](= |∇p| ÷ 等圧線の曲率半径。低気圧で正)、friction は摩擦の減衰率
// [1/s]。摩擦を強く取るほど風は遅く、等圧線を深く横切る。maxCrossing は等圧線を横切る角の上限 [rad]
// で、赤道から離れた所で向きだけを抑え、渦の向きが決まらない赤道へ向かって開く。surfaceRadius は
// 天体の半径 [m]、rotationPeriod は自転周期 [s]。
export function balancedWind(
  gradient: Vec3Node, isobar: Vec3Node, bend: FloatNode, latitude: FloatNode, friction: number,
  maxCrossing: number, surfaceRadius: number, rotationPeriod: number,
): BalancedWind {
  const sinLatitude = sin(latitude);
  const coriolis = sinLatitude.mul(coriolisRate(rotationPeriod));
  const damped = sqrt(coriolis.mul(coriolis).add(friction ** 2));
  const spinSquared = bend.mul(bendToSpinSquared(surfaceRadius));
  // 判別式の床を 0 に取ると、高気圧側(bend < 0)が厳密な釣り合いから 70% 外れる。
  const denominator = damped.add(sqrt(max(damped.mul(damped).add(spinSquared.mul(4)), friction ** 2)));
  const speed = length(gradient).mul(2 * gradientToAcceleration(surfaceRadius)).div(denominator);
  // 流れが渦の中心のまわりを回る角速度 [rad/s]。等圧線に沿う成分はコリオリとこれの和が受け持ち、
  // 負担しきれない残りを摩擦が受け、等圧線を横切る流入になる。赤道で未定義となるのは向きだけ
  // なので、0 へ減衰させるのはここだけ — 速さを決める denominator は spinSquared を維持する。
  const spinSense = tanh(sinLatitude.div(SPIN_SENSE_WIDTH));
  const spin = spinSquared.mul(2).div(denominator).mul(spinSense);
  const along = coriolis.add(spin);
  // 風向にのみ作用する摩擦項。上限はコリオリパラメータが小さい低緯度域で低気圧への流入角を maxCrossing 以内に抑制するための設定
  // で、赤道へ向かっては渦の向きが決まらない幅で開く — 開かないと along の消える赤道で向きの長さが 0 に
  // なり(0/0)、along の符号が変わる所で風が 2 × maxCrossing 跳んで緯線に沿う継ぎ目が立つ。高気圧側では
  // along が赤道の外でも 0 を通るので尺度を |coriolis| で下から支える — その流れは勾配をまっすぐ下って
  // 連続に留まり、中緯度では |coriolis| tan θ が摩擦を超えるので風は釣り合いのまま。
  const equatorial = abs(spinSense).oneMinus();
  const crossingFriction = min(
    friction, max(abs(along), abs(coriolis)).mul(Math.tan(maxCrossing)).add(equatorial.mul(friction)),
  );
  // 向きの長さは √(along² + crossingFriction²) で、勾配が消えても 0 にならない。normalize では NaN が出る。
  const velocity = isobar.mul(along).sub(gradient.div(max(length(gradient), 1e-6)).mul(crossingFriction))
    .div(sqrt(along.mul(along).add(crossingFriction.mul(crossingFriction)))).mul(speed);
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

// 谷の気圧の形が作る循環。谷の芯のまわりを空気が回る角速度と、その半径ごとの分布を、
// balancedWind と同じ釣り合いから出す — depth [hPa]・radius [m]・latitude [rad] の谷で、
// reach は谷の裾を閉じる半径 [m]。前線の腕はこの循環が気団の境目を巻き上げた形なので、
// トラック側は角速度を一生に渡って積み、写し側は半径のプロファイルで腕を曲げる。
export interface VortexSpin {
  // 芯の軌道角速度 [rad/s]。天頂まわりの向きは半球で反転するが、前線骨格の座標は
  // 極側の軸で反転を吸収するので、ここでは絶対値で持つ。
  readonly coreOmega: number;
  // 4 × 芯の spin 二乗 ÷ 減衰項の二乗 — 半径プロファイルの形を決める無次元数。
  readonly spinRatio: number;
  // 裾を閉じるガウスの係数 (radius / reach)²。
  readonly reachSq: number;
}

// 深さ depth [hPa]・短軸の半径 radius [m]・緯度 latitude [rad] の谷の循環。
// rotationPeriod は自転周期 [s]。谷の気圧形は (1+r̂²)^(−1/2) で半径 r̂ = r/radius を尺に
// 取るので、芯の spin 二乗は 深さ ÷ 半径² × (1 + 2 a) に集約できる — a = reachSq。
export function vortexSpinOf(
  depth: number, radius: number, latitude: number, reach: number, rotationPeriod: number,
): VortexSpin {
  const reachSq = (radius / reach) ** 2;
  const sinLatitude = Math.abs(Math.sin(latitude));
  const coriolis = coriolisRate(rotationPeriod) * sinLatitude;
  const damped = Math.hypot(coriolis, FRICTION_RATE);
  // 芯での等圧線方向の 2 階微分 [hPa/rad²] は depth·(1+2a)·(天体半径/radius)²。天体半径は
  // 角速度の二乗への換算係数と相殺されるので、spin 二乗は depth·(1+2a)·100/(密度·radius²)。
  const spinSquared = depth * (1 + 2 * reachSq) * 100 / (AIR_DENSITY * radius ** 2);
  const spinSense = Math.abs(Math.tanh(sinLatitude / SPIN_SENSE_WIDTH));
  return {
    coreOmega: 2 * spinSquared * spinSense
      / (damped + Math.sqrt(damped * damped + 4 * spinSquared)),
    spinRatio: 4 * spinSquared / (damped * damped),
    reachSq,
  };
}

// 循環の半径プロファイル — 半径 r̂(半径の倍率)での軌道角速度 ÷ 芯の角速度。谷の気圧形の
// 微分から出る解析形で、内側が外側より速く回る(差回転が気団の境目を螺旋へ巻き上げる)。
export function vortexProfileAt(rHat: number, spin: VortexSpin): number {
  const rr = rHat * rHat + 1;
  const f = Math.exp(-spin.reachSq * rHat * rHat)
    * (rr ** -1.5 + 2 * spin.reachSq * rr ** -0.5) / (1 + 2 * spin.reachSq);
  return f * (1 + Math.sqrt(1 + spin.spinRatio)) / (1 + Math.sqrt(1 + spin.spinRatio * f));
}

// 循環の風が edgeSpeed [m/s] を下回る半径(半径の倍率) — 渦が周りの流れを圧倒しなくなる
// 外縁で、前線の腕はここまで届く。循環の速さは芯で 0 から立ち上がって半径とともに落ちる
// ので、外側から閾値を越える最初の半径を取る。谷の裾の影響限界 reach [m] が上界。
// radius [m] は谷の短軸の半径。
export function vortexEdgeOf(
  spin: VortexSpin, radius: number, reach: number, edgeSpeed: number,
): number {
  const limit = reach / radius;
  for (let r = limit; r > 0.3; r -= 0.05) {
    if (spin.coreOmega * vortexProfileAt(r, spin) * r * radius >= edgeSpeed) return r;
  }
  return 0.3;
}

// 積算の巻き上げ角 [rad]。一生の位置 life(0..1)・寿命 lifetime [s] の渦について、生まれて
// から谷の循環が気団の境目を巻き上げてきた総量 — 深さ・半径・緯度の履歴から角速度を台形で
// 積む。両端で深さが 0 へ降りるので刻みは粗くて足りる。sample は一生の位置での
// (深さ [hPa]・半径 [m]・緯度 [rad]) を返し、reach [m]・rotationPeriod [s] は
// vortexSpinOf と同じ。
const WOUND_STEPS = 16;
export function woundOf(
  life: number, lifetime: number, reach: number, rotationPeriod: number,
  sample: (l: number) => {
    readonly depth: number; readonly radius: number; readonly latitude: number;
  },
): number {
  let sum = 0;
  for (let i = 0; i <= WOUND_STEPS; i += 1) {
    const l = (life * i) / WOUND_STEPS;
    const { depth, radius, latitude } = sample(l);
    const spin = vortexSpinOf(depth, radius, latitude, reach, rotationPeriod);
    sum += (i === 0 || i === WOUND_STEPS ? 0.5 : 1) * spin.coreOmega;
  }
  return (sum * life * lifetime) / WOUND_STEPS;
}
