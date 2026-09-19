import type { Plan, PlanExecutionMode } from '../../plan/plan';
import type { CelestialBodies } from '../../celestial/celestial-bodies';
import type { Attitude } from '../../../physics/attitude';
import type { Vec3 } from '../../../math/vec3';
import type { FireControl } from '../../player/fire-control';
import type { AttachedBoosters } from '../../player/attached-boosters';
import type { AltitudeAlarm } from '../../player/altitude-alarm';
import type { PilotCommand, PilotControls, ThrustDirection } from './pilot-controls';
import type { RunEventSink } from '../../run-events';
import type { StageOutcome } from '../../stages/stage-outcome';
import type { EntityRegistry } from '../entity-registry';
import type { CombatTarget } from './combat-target';
import type { DynamicEntity } from './dynamic-entity';
import type { StageRules } from '../../stages/stage-rules';

export interface ThrottlePort {
  readonly throttleIdx: number;
  readonly rcsDamp: boolean;
  readonly progradeHold: boolean;
  updateThrustState(controls: PilotControls, att: Attitude, simDt: number, ship: FuelConsumer): Vec3 | null;
  updateTorque(
    att: Attitude, r: Vec3, v: Vec3, controls: PilotControls, fineAttitude: boolean,
    dt: number, simDt: number, ship: FuelConsumer, events: RunEventSink | null,
  ): Vec3;
  updateThrustLatches(controls: PilotControls): void;
  toggleThrustLatch(direction: ThrustDirection): void;
  isThrustLatched(direction: ThrustDirection): boolean;
  clearTransientState(): void;
}

export interface FuelConsumer {
  readonly totalThrust: number;
  readonly totalTorque: number;
  readonly totalFuelConsumptionRate: number;
  readonly totalFuel: number;
  readonly totalMaxFuel: number;
  consumeFuel(amount: number): number;
  readonly motion: DynamicEntity['motion'];
}

export interface PilotCommandReceiver {
  // controls はこのフレームの操作量で、操作されない個体は null。dt [s] は実時間、simDt [sim s] は
  // シミュレーション時間の刻み。
  updateControls(
    controls: PilotControls | null, dt: number, simDt: number,
    activeStage: StageOutcome, stageRules: StageRules, celestialBodies: CelestialBodies,
  ): void;
  clearTransientCommands(): void;
  handleCommand(command: PilotCommand, registry: EntityRegistry): void;
}

export interface NavigationController {
  readonly plan: Plan;
  planExecution: PlanExecutionMode;
  fineAttitude: boolean;
}

// 操作対象(自艦・基地)の共通能力。装備していない機能はプロパティ自体が無いので、有無を確かめて
// から使う。
export interface Controllable extends CombatTarget, FuelConsumer, PilotCommandReceiver, NavigationController {
  readonly throttle: ThrottlePort;
  readonly fire?: FireControl;
  readonly boosters?: AttachedBoosters;
  readonly altitudeAlarm?: AltitudeAlarm;
}

// この個体が操作対象になりうるか。
export function isControllable(entity: DynamicEntity): entity is Controllable {
  return entity.controllable;
}
