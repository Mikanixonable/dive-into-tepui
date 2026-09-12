import type { PlanExecutionMode } from '../plan/plan';

export const PLAN_EXECUTION_MODES: readonly PlanExecutionMode[] = ['off', 'instant'];
const PLAN_EXECUTION_LABELS: Record<PlanExecutionMode, string> = { off: 'OFF', instant: '自動実行' };

export function planExecutionLabel(mode: PlanExecutionMode): string {
  return PLAN_EXECUTION_LABELS[mode];
}
