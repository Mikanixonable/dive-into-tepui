// シミュレーション刻みの純粋な決定規則。既知イベントを越えず、低高度では刻みを縮める。
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
