import type { Plan } from '../../plan/plan';
import type { PlanExecutionMode } from '../../player/player';
import type { Throttle } from '../../player/throttle';
import type { FireControl } from '../../player/fire-control';
import type { AttachedBoosters } from '../../player/attached-boosters';
import type { PowerSystem } from '../../player/power';
import type { RadiatorSystem } from '../../player/radiator';
import type { AeroLoad } from '../../player/aero-load';
import type { AltitudeAlarm } from '../../player/altitude-alarm';
import type { Input } from '../../../input/input';
import type { CelestialSystem } from '../../celestial/celestial-system';
import type { Stage } from '../../stages/stage';
import type { EntityRegistry } from '../entity-registry';
import type { CombatTarget } from './combat-target';
import type { DynamicEntity } from './dynamic-entity';

// 操作対象(自艦・基地)が答えるもの。戦闘の対象になれる個体(CombatTarget)だけが
// 実装できる。搭載していない装備は null で答える。
export interface Controllable extends CombatTarget {
  readonly totalThrust: number;
  readonly totalTorque: number;
  readonly totalFuelConsumptionRate: number;
  // 全 RCS タンクの残量・容量 [kg]。
  readonly totalFuel: number;
  readonly totalMaxFuel: number;
  readonly throttle: Throttle;
  readonly fire: FireControl | null;
  readonly boosters: AttachedBoosters | null;
  readonly power: PowerSystem | null;
  readonly radiator: RadiatorSystem | null;
  readonly aero: AeroLoad | null;
  readonly altitudeAlarm: AltitudeAlarm | null;
  readonly plan: Plan;
  planExecution: PlanExecutionMode;
  fineAttitude: boolean;
  // 操作対象になったときに出す案内。出すものが無ければ null。
  readonly controlHint: string | null;
  // 操作対象から手で外したときに出す案内。出すものが無ければ null。
  readonly releaseHint: string | null;
  consumeFuel(amount: number): number;

  // 毎フレーム1度だけ呼ぶ。input が null なら、このフレーム操作されない個体として指令を畳む。
  // registry / activeStage / celestialSystem は射撃と補給の判定に使う。
  updateControls(
    input: Input | null, dt: number, simDt: number,
    registry: EntityRegistry, activeStage: Stage, celestialSystem: CelestialSystem,
  ): void;

  // 次のフレームへ持ち越してはならない連続指令(推力・トルク・射撃)を畳む。
  clearTransientCommands(): void;
}

// この個体が操作対象になりうるか。顔ぶれから操作対象だけを絞るときに使う。
export function isControllable(entity: DynamicEntity): entity is Controllable {
  return entity.controllable;
}
