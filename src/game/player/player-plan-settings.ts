import type { PlanExecutionMode } from '../plan/plan';

export const PLAN_EXECUTION_MODES: readonly PlanExecutionMode[] = ['none', 'autopilot', 'instant'];
const PLAN_EXECUTION_LABELS: Record<PlanExecutionMode, string> = {
  none: 'なし', autopilot: '自動操縦', instant: '理想実行',
};

export function planExecutionLabel(mode: PlanExecutionMode): string {
  return PLAN_EXECUTION_LABELS[mode];
}
