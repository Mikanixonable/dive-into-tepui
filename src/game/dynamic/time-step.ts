// シミュレーション刻みの純粋な決定規則。既知イベントを越えず、大気抵抗を積める幅に収める。

import {
  Atmosphere, airspeed, atmosphericDensity, atmosphericScaleHeight, ellipsoidAltitude,
} from '../../physics/atmosphere';
import { nearestAtmosphereBody } from '../../physics/attractor';
import { CelestialMotion } from '../../physics/celestial-motion';
import { KinematicState } from '../../physics/kinematic-state';
import { Vec3, dot, len, sub } from '../../math/vec3';

// 1サブステップの最大秒数 [s]。
export const SUBSTEP_MAX_DT = 20;
// 1フレームに許すサブステップ数の上限。これを超える時間送りが要求されたら刻み幅の側を伸ばす。
// 刻み幅の上限が固定値だけだと substep 数がワープ倍率に正比例し、高ワープでは1フレームの値段が
// そのまま倍率に比例して増える。再突入中の細分化はこれに優先する(加熱と動圧の積分結果が艦の
// 生死を決め、それをプレイヤーが観測するため)。
// 64 は最高ワープ(×65536)の LEO で1周あたり54歩。そこでの数値的な軌道減衰は 0.42 km/日で、
// 同じ高度で大気抵抗が実際に削る 14 km/日 の 3% — 艦が焼ける時期は高ワープでも変わらない。
// 1周27歩(K=32)まで粗くすると数値減衰が実ドラッグと同等になり、待つだけで艦が倍の速さで落ちる。
export const SUBSTEP_MAX_COUNT = 64;

// 大気の中で刻みを縛る2つの上限(atmosphericMaxStep)。
// 抗力は陽的 RK4 にとって剛い項で、逆時定数 λ = ½ρ·s·bcInv が刻みに対して大きくなると、
// 段ごとの抗力が増幅して1歩で発散する(抗力は速さの2乗なので振動ではなく暴走になる)。
// DRAG_STEP_MAX_SPEED_LOSS は λ·dt の上限 = 1歩で抗力が奪ってよい対気速度の割合。
// RK4 の実軸上の安定限界は λ·dt ≒ 2.78 だが、縛っているのは安定性ではなく精度である:
// GTO からの再突入で外殻温度の最大は、刻み 0.25 s の基準 976 K に対し λ·dt = 1 で 1050 K
// (+7.6%)、0.5 で 991 K(+1.5%)。限界 1300 K に対して 7.6% は艦の生死を変える。
const DRAG_STEP_MAX_SPEED_LOSS = 0.5;
// もう1つは剛性と無関係に効く。RK4 の中間段は現在の速度と加速度からの直線外挿なので、
// 重力だけで動径方向に g·dt²/4 沈む。刻み 204.8 s ではこれが 99.6 km になり、高度 91.5 km
// (λ·dt = 0.006 で剛性は全く問題ない)でも段が地面の下を標本して海面密度を拾う。
// DRAG_STEP_MAX_SCALE_HEIGHTS は、その沈み込みが密度を e^N 倍までしか変えないよう縛る。
const DRAG_STEP_MAX_SCALE_HEIGHTS = 0.5;

// 消費されない弧(計画の区間)の刻みの下限 [s]。消費されない弧は状態を
// 決めず線としてだけ読まれるので、実シミュレーションより粗く刻むこと自体が目的である —
// 細かくすれば届く先が近くなるだけで、折れ線の誤差は間引き補間が支配しているので見える精度は
// 増えない。これ以上粗くできない理由は、この下限が周期由来の刻み(period/ARC_STEPS_PER_REV)を
// 上書きする側にあることにある: 自然な刻みが下限を割るのは周期の短い領域 — LEO と、離心軌道の
// 近地点通過 — で、そこはまさに細かく刻む必要がある場所である。表示期間の遠端に残る形状誤差は
// 40s で LEO 0.2m・低月周回 0.0m・モルニヤ 105m、60s で 1.7m・0.1m・533m。
// 刻みの下限は同時に、天体接近時の接近項が幾何級数的に潰れるのも防ぐ。
export const ARC_MIN_STEP_DT = 40;

// targetTime・maxStep・nextEventTime のいずれよりも先へ進まない、今回のサブステップ幅 [s] を返す。
export function simulationStepDuration(
  simTime: number,
  targetTime: number,
  maxStep: number,
  nextEventTime: number | null,
): number {
  let end = Math.min(targetTime, simTime + maxStep);
  if (nextEventTime !== null && nextEventTime >= simTime && nextEventTime < end) end = nextEventTime;
  return Math.max(0, end - simTime);
}

// 時間送り simDt を分割するサブステップ幅の上限 [s]。上限が固定値 maxDt だけだとサブステップ数が
// ワープ倍率に正比例するので、maxCount を超える分割になるときは刻みの側を伸ばす。
export function simulationMaxStep(simDt: number, maxDt: number, maxCount: number): number {
  return Math.max(maxDt, simDt / maxCount);
}

// 弾道係数の逆数 bcInv を持つ物体が、大気天体の中心から見て rRel/vRel にいるとき、抗力を
// 積める最大刻み [s]。上限は2つあり、どちらか片方では足りない。
//   剛性: 抗力の逆時定数 λ = ½ρ·s·bcInv に対し λ·dt を DRAG_STEP_MAX_SPEED_LOSS で抑える。
//   沈み込み: 中間段の直線外挿が動径方向へ沈む深さ(降下率·dt + ½g·dt²)を、密度が
//     e^DRAG_STEP_MAX_SCALE_HEIGHTS 倍を超えない範囲に抑える。
// 抗力の逆時定数 λ = ½ρ·s·bcInv [1/s]。刻み dt に対する λ·dt が、その1歩で抗力が奪う
// 対気速度の割合になる。
function dragRate(rRel: Vec3, vRel: Vec3, bcInv: number, atm: Atmosphere): number {
  return 0.5 * atmosphericDensity(ellipsoidAltitude(rRel, atm), atm)
    * len(airspeed(rRel, vRel, atm)) * bcInv;
}

function dragMaxStep(rRel: Vec3, vRel: Vec3, bcInv: number, mu: number, atm: Atmosphere): number {
  const d = len(rRel);
  const alt = ellipsoidAltitude(rRel, atm);
  const lambda = dragRate(rRel, vRel, bcInv, atm);
  const stiff = lambda > 0 ? DRAG_STEP_MAX_SPEED_LOSS / lambda : Infinity;
  // 沈み込みの許容深さ [m] と、そこへ達するまでの時間。2次方程式 ½g·dt² + 降下率·dt = depth を
  // 有理化した形で解く — 遠方や薄い大気で g → 0 でも 0 除算にならない。
  const depth = DRAG_STEP_MAX_SCALE_HEIGHTS * atmosphericScaleHeight(alt, atm);
  const descentRate = Math.max(0, -dot(rRel, vRel) / d);
  const g = mu / (d * d);
  const sink = (2 * depth) / (descentRate + Math.sqrt(descentRate * descentRate + 2 * g * depth));
  return Math.min(stiff, sink);
}

// その状態を積むのに大気が要求する最大刻み [s]。相手は自分にとって最も近い大気天体ただ1体で、
// それがいなければ Infinity(大気の無いところに上限は無い)。抵抗を受けない物体(bcInv = 0)も
// 同じく Infinity。時間送りやイベント由来の上限との合成は呼び出し側が行う。
export function atmosphericMaxStep(
  state: KinematicState, bcInv: number,
  atmosphereBodies: readonly CelestialMotion[], pivot: number,
): number {
  if (bcInv <= 0) return Infinity;
  const body = nearestAtmosphereBody(state.r, atmosphereBodies, pivot);
  const atmosphere = body === null ? null : body.atmosphereAt(pivot);
  if (body === null || atmosphere === null) return Infinity;
  const bodyState = body.stateAt(pivot);
  return dragMaxStep(
    sub(state.r, bodyState.r), sub(state.v, bodyState.v), bcInv, body.def.mu, atmosphere);
}

// 刻み dt のあいだに、抗力がその物体の対気速度を丸ごと奪い切るか。奪い切る幅で積んだ軌道は
// もはや正確ではない(dragAccel が対気速度で頭打ちにするので発散こそしない)。
//
// **見るのは剛性の項だけで、atmosphericMaxStep の合成値ではない。** 中間段の沈み込みの上限は
// 密度にも bcInv にも依らず、高い倍率では大気から遥かに離れた低軌道でも下回る — それを根拠に
// すると、大気に触れていない物体まで巻き込んでしまう。
export function dragTakesFullAirspeed(
  state: KinematicState, bcInv: number,
  atmosphereBodies: readonly CelestialMotion[], pivot: number, dt: number,
): boolean {
  if (bcInv <= 0 || dt <= 0) return false;
  const body = nearestAtmosphereBody(state.r, atmosphereBodies, pivot);
  const atmosphere = body === null ? null : body.atmosphereAt(pivot);
  if (body === null || atmosphere === null) return false;
  const bodyState = body.stateAt(pivot);
  const rate = dragRate(
    sub(state.r, bodyState.r), sub(state.v, bodyState.v), bcInv, atmosphere);
  return rate * dt >= 1;
}
