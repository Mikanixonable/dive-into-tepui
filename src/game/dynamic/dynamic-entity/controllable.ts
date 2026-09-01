import type { Plan } from '../../plan/plan';
import type { PlanExecutionMode } from '../../player/player';
import type { DynamicEntity } from './dynamic-entity';

// 操作対象(自艦・基地)が答えるもの。DynamicEntity を継承しているので、世界に実体を持つ
// ものだけが実装できる。
export interface Controllable extends DynamicEntity {
  readonly totalThrust: number;
  readonly totalTorque: number;
  readonly totalFuelConsumptionRate: number;
  readonly plan: Plan;
  planExecution: PlanExecutionMode;
  fineAttitude: boolean;
  consumeFuel(amount: number): number;
}
