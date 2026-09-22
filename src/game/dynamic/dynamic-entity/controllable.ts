import type { Plan, PlanExecutionMode } from '../../plan/plan';
import type { CelestialBodies } from '../../celestial/celestial-bodies';
import type { Attitude } from '../../../physics/attitude';
import type { Vec3 } from '../../../math/vec3';
import type { FireControl } from '../../player/fire-control';
import type { AltitudeAlarm } from '../../player/altitude-alarm';
import type { PilotCommand, PilotControls, ThrustDirection } from './pilot-controls';
import type { RunEventSink } from '../../run-events';
import type { StageOutcome } from '../../stages/stage-outcome';
import type { EntityRegistry } from '../entity-registry';
import type { CombatTarget } from './combat-target';
import type { DynamicEntity } from './dynamic-entity';
import type { StageRules } from '../../stages/stage-rules';

// 操作量から推力とトルクを決め、推力のラッチ・RCS 減衰・プログレード保持を持つスロットルインターフェース。
export interface ThrottlePort {
  readonly throttleIdx: number;
  readonly rcsDamp: boolean;
  readonly progradeHold: boolean;
  readonly thrust: Vec3 | null;
  readonly torque: Vec3;
  updateThrustState(controls: PilotControls, att: Attitude, simDt: number, ship: FuelConsumer): void;
  updateTorque(
    att: Attitude, r: Vec3, v: Vec3, controls: PilotControls, fineAttitude: boolean,
    dt: number, simDt: number, ship: FuelConsumer, events: RunEventSink | null,
  ): void;
  updateThrustLatches(controls: PilotControls): void;
  toggleThrustLatch(direction: ThrustDirection): void;
  isThrustLatched(direction: ThrustDirection): boolean;
  clearTransientState(): void;
}

// スロットルが推力・トルクの上限と燃料を読み、燃料 [kg] を消費させる相手。
export interface FuelConsumer {
  readonly totalThrust: number;
  readonly totalTorque: number;
  readonly totalFuelConsumptionRate: number;
  readonly totalFuel: number;
  readonly totalMaxFuel: number;
  consumeFuel(amount: number): number;
  readonly rcsFuelConsumptionRate?: number;
  consumeRcsFuel?(amount: number): number;
  readonly motion: DynamicEntity['motion'];
}

// フレームごとの操作入力および単発コマンドを受け付けるインターフェース。
export interface PilotCommandReceiver {
  // controls はこのフレームの操作量で、操作されない個体は null。dt [s] は実時間、simDt [sim s] は
  // シミュレーション時間の刻み。
  updateControls(
    controls: PilotControls | null, dt: number, simDt: number,
    activeStage: StageOutcome, stageRules: StageRules, celestialBodies: CelestialBodies,
  ): void;
  // 推力・トルクの指令とスロットルの一時状態を解除（クリア）する。
  clearTransientCommands(): void;
  // 単発の命令 command のうち、備える操作を状態へ適用する。
  handleCommand(command: PilotCommand, registry: EntityRegistry): void;
}

// マニューバ計画と、その実行方法・姿勢操作の微調整の有無。
export interface NavigationController {
  readonly plan: Plan;
  readonly planExecution: PlanExecutionMode;
  readonly fineAttitude: boolean;
}

// 操作対象(自艦・基地)の共通能力。装備していない機能は null なので、有無を確かめてから使う。
export interface Controllable extends CombatTarget, FuelConsumer, PilotCommandReceiver, NavigationController {
  readonly throttle: ThrottlePort;
  readonly fire: FireControl | null;
  readonly altitudeAlarm: AltitudeAlarm | null;
}

// この個体が操作対象になりうるか。
export function isControllable(entity: DynamicEntity): entity is Controllable {
  return entity.controllable;
}
