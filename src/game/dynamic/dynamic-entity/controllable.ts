import type { Plan } from '../../plan/plan';
import type { PlanExecutionMode } from '../../player/player';
import type { PlayerThrottle } from '../../player/player-throttle';
import type { PlayerFire } from '../../player/player-fire';
import type { PowerSystem } from '../../player/power';
import type { RadiatorSystem } from '../../player/radiator';
import type { AeroLoad } from '../../player/aero-load';
import type { AltitudeAlarm } from '../../player/altitude-alarm';
import type { DynamicEntity } from './dynamic-entity';

// 操作対象(自艦・基地)が答えるもの。DynamicEntity を継承しているので、世界に実体を持つ
// ものだけが実装できる。搭載していない装備は null で答える。
export interface Controllable extends DynamicEntity {
  readonly totalThrust: number;
  readonly totalTorque: number;
  readonly totalFuelConsumptionRate: number;
  // 全 RCS タンクの残量・容量 [kg]。
  readonly totalFuel: number;
  readonly totalMaxFuel: number;
  readonly throttle: PlayerThrottle;
  readonly fire: PlayerFire | null;
  readonly power: PowerSystem | null;
  readonly radiator: RadiatorSystem | null;
  readonly aero: AeroLoad | null;
  readonly altitudeAlarm: AltitudeAlarm | null;
  readonly plan: Plan;
  planExecution: PlanExecutionMode;
  fineAttitude: boolean;
  consumeFuel(amount: number): number;
}
