// シミュレーション刻みの純粋な決定規則。既知イベントを越えず、低高度では刻みを縮める。

import { KinematicState } from '../../physics/kinematic-state';

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

// 再突入域の境界を越えない最大刻み。境界ちょうどは必ずreentryMaxStep側に含める。
export function adaptiveSimulationMaxStep(
  states: readonly KinematicState[],
  reentryRadius: number,
  normalMaxStep: number,
  reentryMaxStep: number,
): number {
  let maxStep = normalMaxStep;
  for (const { r, v } of states) {
    const radius = Math.sqrt(r.x * r.x + r.y * r.y + r.z * r.z);
    if (radius <= reentryRadius) return reentryMaxStep;
    const radialSpeed = (r.x * v.x + r.y * v.y + r.z * v.z) / radius;
    if (radialSpeed < 0) {
      const untilBoundary = (radius - reentryRadius) / -radialSpeed;
      if (untilBoundary > 1e-9) maxStep = Math.min(maxStep, untilBoundary);
      else return reentryMaxStep;
    }
  }
  return maxStep;
}
