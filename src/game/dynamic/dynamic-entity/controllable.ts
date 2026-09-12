import type { Plan, PlanExecutionMode } from '../../plan/plan';
import type { CelestialBodies } from '../../celestial/celestial-bodies';
import type { Attitude } from '../../../physics/attitude';
import type { Vec3 } from '../../../math/vec3';
import type { ThrottleSaveData } from '../../save/save-data';
import type { FireControl } from '../../player/fire-control';
import type { AttachedBoosters } from '../../player/attached-boosters';
import type { AltitudeAlarm } from '../../player/altitude-alarm';
import type { Input } from '../../../input/input';
import type { StageOutcome } from '../../stages/stage-outcome';
import type { EntityRegistry } from '../entity-registry';
import type { CombatTarget } from './combat-target';
import type { DynamicEntity } from './dynamic-entity';
import type { PlayerStatusSnapshot } from '../../player/player-status-snapshot';

export interface ThrottlePort {
  readonly throttleIdx: number;
  readonly rcsDamp: boolean;
  readonly progradeHold: boolean;
  updateThrustState(input: Input, att: Attitude, simDt: number, ship: FuelConsumer): Vec3 | null;
  updateTorque(
    att: Attitude, r: Vec3, v: Vec3, input: Input, fineAttitude: boolean,
    dt: number, simDt: number, ship: FuelConsumer, onProgradeHoldReleased: () => void,
  ): Vec3;
  updateThrustLatches(input: Input): void;
  isThrustLatched(key: { readonly code: string }): boolean;
  clearTransientState(): void;
  serialize(): ThrottleSaveData;
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

export interface PilotCommandFrame {
  readonly input: Input | null;
  readonly dt: number;
  readonly simDt: number;
  readonly registry: EntityRegistry;
  readonly activeStage: StageOutcome;
  readonly celestialBodies: CelestialBodies;
}

export interface PilotCommandReceiver {
  updateControls(frame: PilotCommandFrame): void;
  clearTransientCommands(): void;
}

export interface NavigationController {
  readonly plan: Plan;
  planExecution: PlanExecutionMode;
  fineAttitude: boolean;
}

// 操作対象(自艦・基地)の共通能力。装備していない機能は null ではなくプロパティ自体を
// 持たない。HUD や入力側は capability の有無だけを確認して利用する。
export interface Controllable extends CombatTarget, FuelConsumer, PilotCommandReceiver, NavigationController {
  readonly throttle: ThrottlePort;
  readonly fire?: FireControl;
  readonly boosters?: AttachedBoosters;
  readonly altitudeAlarm?: AltitudeAlarm;
  // 操作対象になったときに出す案内。出すものが無ければ null。
  readonly controlHint: string | null;
  // 操作対象から手で外したときに出す案内。出すものが無ければ null。
  readonly releaseHint: string | null;
  // HUD が読む同一フレームの表示値。Motion 内部の個別系を公開しない。
  statusSnapshot(): PlayerStatusSnapshot;
  // 装備を持つ操作対象だけが実装する入力命令。未搭載はメソッド自体を持たない。
  readonly toggleSolarPanel?: (side: 'up' | 'down') => void;
  readonly toggleRadiator?: (side: 'up' | 'down') => void;
}

// この個体が操作対象になりうるか。顔ぶれから操作対象だけを絞るときに使う。
export function isControllable(entity: DynamicEntity): entity is Controllable {
  return entity.controllable;
}
