import type { Plan } from '../../plan/plan';
import type { PlanExecutionMode } from '../../player/player';
import type { PlayerThrottle } from '../../player/player-throttle';
import type { PlayerFire } from '../../player/player-fire';
import type { PlayerBoosters } from '../../player/player-boosters';
import type { PowerSystem } from '../../player/power';
import type { RadiatorSystem } from '../../player/radiator';
import type { AeroLoad } from '../../player/aero-load';
import type { AltitudeAlarm } from '../../player/altitude-alarm';
import type { Input } from '../../../input/input';
import type { RenderStyle } from '../../../render/render-style';
import type { CameraSystem } from '../../camera/camera-system';
import type { FloatingOrigin } from '../../camera/floating-origin';
import type { CelestialSystem } from '../../celestial/celestial-system';
import type { MapVisibility } from '../../map/visibility-policy';
import type { OrbitReference } from '../../orbit-reference';
import type { Stage } from '../../stages/stage';
import type { DynamicSystem } from '../dynamic-system';
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
  // 削れる耐久値を持たない種別は null。
  readonly hp: number | null;
  readonly maxHp: number | null;
  readonly throttle: PlayerThrottle;
  readonly fire: PlayerFire | null;
  readonly boosters: PlayerBoosters | null;
  readonly power: PowerSystem | null;
  readonly radiator: RadiatorSystem | null;
  readonly aero: AeroLoad | null;
  readonly altitudeAlarm: AltitudeAlarm | null;
  readonly plan: Plan;
  planExecution: PlanExecutionMode;
  fineAttitude: boolean;
  consumeFuel(amount: number): number;

  // 毎フレーム1度だけ呼ぶ。input が null なら、このフレーム操作されない個体として指令を畳む。
  // entities / activeStage / celestialSystem は射撃と補給の判定に要る — 使わない種別は無視する。
  updateControls(
    input: Input | null, dt: number, simDt: number,
    entities: DynamicSystem, activeStage: Stage, celestialSystem: CelestialSystem,
  ): void;

  // 次のフレームへ持ち越してはならない連続指令(推力・トルク・射撃)を畳む。
  clearTransientCommands(): void;

  // メッシュ・エフェクト・マーカーを displayTime の状態へ同期する。isActive はこの個体が
  // 操作対象かどうか。orbitRef は方位マーカーが指す軌道座標系で、持たない種別は無視する。
  syncControllable(
    fo: FloatingOrigin, cameraSystem: CameraSystem, displayTime: number, isActive: boolean,
    style: RenderStyle, visibility: MapVisibility | null, orbitRef?: OrbitReference,
  ): void;
}
