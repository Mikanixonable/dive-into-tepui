import type { Plan } from '../../plan/plan';
import type { PlanExecutionMode } from '../../player/player';
import type { KinematicState } from '../../../physics/kinematic-state';
import type { MarkerManager } from '../../marker/marker-manager';
import type { EquatorNodeMarkerPair } from '../../marker/equator-node-marker-pair';
import type { PredictedArc } from '../../simulation/predicted-arc';

// PlayerThrottle が操作対象に要求するプロパティの最小インターフェース。
// Ship は既にこれらを全て持つので自動的に満たし、Base は固定値で実装する。
export interface Controllable {
  readonly id: string;
  readonly name: string;
  readonly mass: number;
  readonly totalThrust: number;
  readonly totalTorque: number;
  readonly totalFuelConsumptionRate: number;
  readonly state: KinematicState;
  readonly plan: Plan;
  readonly predictedArc: PredictedArc | null;
  planExecution: PlanExecutionMode;
  fineAttitude: boolean;
  ensureEquatorNodes(markerManager: MarkerManager): EquatorNodeMarkerPair;
  consumeFuel(amount: number): number;
}
