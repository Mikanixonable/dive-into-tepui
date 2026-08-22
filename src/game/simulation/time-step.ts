// シミュレーション刻みの純粋な決定規則。既知イベントを越えず、大気抵抗を積める幅に収める。

import {
  Atmosphere, airspeed, atmosphericDensity, atmosphericScaleHeight, ellipsoidAltitude,
} from '../../physics/atmosphere';
import { CelestialBody, nearestAtmosphereBody } from '../../physics/celestial-body';
import { KinematicState } from '../../physics/kinematic-state';
import { Vec3, dot, len, sub } from '../../physics/vec3';
import * as C from '../const';

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
function dragMaxStep(rRel: Vec3, vRel: Vec3, bcInv: number, mu: number, atm: Atmosphere): number {
  const d = len(rRel);
  const alt = ellipsoidAltitude(rRel, atm);
  const lambda = 0.5 * atmosphericDensity(alt, atm) * len(airspeed(rRel, vRel, atm)) * bcInv;
  const stiff = lambda > 0 ? C.DRAG_STEP_MAX_SPEED_LOSS / lambda : Infinity;
  // 沈み込みの許容深さ [m] と、そこへ達するまでの時間。2次方程式 ½g·dt² + 降下率·dt = depth を
  // 有理化した形で解く — 遠方や薄い大気で g → 0 でも 0 除算にならない。
  const depth = C.DRAG_STEP_MAX_SCALE_HEIGHTS * atmosphericScaleHeight(alt, atm);
  const descentRate = Math.max(0, -dot(rRel, vRel) / d);
  const g = mu / (d * d);
  const sink = (2 * depth) / (descentRate + Math.sqrt(descentRate * descentRate + 2 * g * depth));
  return Math.min(stiff, sink);
}

// その状態を積むのに大気が要求する最大刻み [s]。相手は自分にとって最も近い大気天体ただ1体で、
// それがいなければ Infinity(大気の無いところに上限は無い)。抵抗を受けない物体(bcInv = 0)も
// 同じく Infinity。時間送りやイベント由来の上限との合成は呼び出し側が行う。
export function atmosphericMaxStep(
  state: KinematicState, bcInv: number, atmosphereBodies: readonly CelestialBody[],
): number {
  if (bcInv <= 0) return Infinity;
  const body = nearestAtmosphereBody(state.r, atmosphereBodies);
  if (body === null || body.atmosphere === null) return Infinity;
  return dragMaxStep(
    sub(state.r, body.state.r), sub(state.v, body.state.v), bcInv, body.mu, body.atmosphere);
}
