// シミュレーション刻みの純粋な決定規則。既知イベントを越えず、大気の底の近くでは刻みを縮める。

import { ellipsoidAltitude } from '../../physics/atmosphere';
import { Attractor, nearestAtmosphereBody } from '../../physics/attractor';
import { KinematicState } from '../../physics/kinematic-state';
import { dot, len, sub } from '../../physics/vec3';

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

// 再突入域(大気を持つ天体の基準楕円体から reentryAlt 以内)の境界を越えない最大刻み。
// 境界ちょうどは必ず reentryMaxStep 側に含める。細分化が要るのは大気の密度が 1 スケールハイトで
// 桁を変えるからなので、**大気の無いところに再突入域は無い** — atmosphereBodies が空、または
// どの状態も大気を持つ天体の近くにいなければ normalMaxStep がそのまま返る。
// 各状態はそれぞれにとって最も近い大気天体を相手にする(呼び出し側は窓をそのまま渡す)。
export function adaptiveSimulationMaxStep(
  states: readonly KinematicState[],
  atmosphereBodies: readonly Attractor[],
  reentryAlt: number,
  normalMaxStep: number,
  reentryMaxStep: number,
): number {
  let maxStep = normalMaxStep;
  for (const { r, v } of states) {
    const body = nearestAtmosphereBody(r, atmosphereBodies);
    if (body === null || body.atmosphere === null) continue;
    const rRel = sub(r, body.state.r);
    const alt = ellipsoidAltitude(rRel, body.atmosphere);
    if (alt <= reentryAlt) return reentryMaxStep;
    // 境界までの猶予は動径接近率で見積もる。基準楕円体の半径も緯度とともに動くが、その速さは
    // 高々 16 m/s で降下速度に対して十分小さい(この見積りは刻みを縮める上限にしか使わない)。
    const descentRate = -dot(rRel, sub(v, body.state.v)) / len(rRel);
    if (descentRate <= 0) continue;
    const untilBoundary = (alt - reentryAlt) / descentRate;
    if (untilBoundary > 1e-9) maxStep = Math.min(maxStep, untilBoundary);
    else return reentryMaxStep;
  }
  return maxStep;
}
