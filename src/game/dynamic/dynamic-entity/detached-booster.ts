import type * as THREE from 'three/webgpu';
import type { Quat } from '../../../math/quat';
import { v3, type Vec3 } from '../../../math/vec3';
import { deserializeAttitude, type Attitude } from '../../../physics/attitude';
import { deserializeKinematicState, type KinematicState } from '../../../physics/kinematic-state';
import type { BoosterStage } from '../../player/booster-stack';
import { DetachedBoosterMotion } from './detached-booster-motion';
import type { DynamicMotionThermal } from '../dynamic-motion';
import {
  DetachedBoosterView, type DetachedBoosterRenderSource,
} from '../../../render/dynamic/dynamic-entity/detached-booster-view';
import type { DynamicViewFrame } from '../../../render/dynamic/dynamic-view';
import { DynamicEntity, type SerializedDynamicEntityFields } from './dynamic-entity';
import type { DynamicEntityKind } from './entity-kind';
import type { EntityIdAllocators } from './entity-id';
import type { EntityRegistry } from '../entity-registry';
import type { OrbitReference } from '../../orbit-reference';

// 表示時刻を「現在」とみなす許容差 [sim s]。
const BURN_DISPLAY_EPS = 1e-6;

// 分離後も独立して燃焼・慣性飛行するブースター1基の直列化した形。
export interface SerializedDetachedBooster extends SerializedDynamicEntityFields {
  readonly kind: 'booster';
  readonly thermal: DynamicMotionThermal;
  readonly stage: BoosterStage;
  // 分離直後の親艦との再接触を避ける猶予の期限 [sim s]。
  readonly collisionEnableAt: number;
}

// 分離ブースターの識別情報、運動、表示を一体として所有する。
export class DetachedBooster extends DynamicEntity {
  public static readonly kind = 'booster';
  public static spawnGate(): null { return null; }

  public override readonly mapKind: DynamicEntityKind = 'player';
  public override readonly capKind = 'booster';
  public declare readonly motion: DetachedBoosterMotion;

  // 切り離した段 stage を、state・attitude で飛ばす。collisionEnableAt は親艦との接触を許す時刻。
  // id は採番器が段の id から配った識別子。thermal は熱の状態で、省くと環境温度から始める。alive は生死。
  private constructor(
    stage: BoosterStage,
    state: KinematicState,
    attitude: Attitude,
    collisionEnableAt: number,
    scene: THREE.Scene,
    id: string,
    thermal?: DynamicMotionThermal,
    alive?: boolean,
  ) {
    super(
      () => new DetachedBoosterMotion(state, attitude, stage, collisionEnableAt, thermal, alive),
      new DetachedBoosterView(scene),
      id,
    );
    this.setName('分離ブースター');
  }

  // 主慣性モーメント。
  private static readonly INERTIA = v3(1, 1, 0.4);

  // 切り離した段 stage を、分離時の状態 state・姿勢 q・機体座標系の角速度 w で新しく飛ばす。
  // collisionEnableAt は親艦との接触を許す時刻。
  public static create(
    stage: BoosterStage,
    state: KinematicState,
    q: Quat,
    w: Vec3,
    collisionEnableAt: number,
    scene: THREE.Scene,
    idAllocators: EntityIdAllocators,
  ): DetachedBooster {
    const attitude = { q, w, inertia: DetachedBooster.INERTIA };
    return new DetachedBooster(
      { ...stage }, state, attitude, collisionEnableAt, scene, idAllocators.booster.next(stage.id),
    );
  }

  // 直列化した分離ブースターを復元する。
  public static deserialize(
    serialized: SerializedDetachedBooster, registry: EntityRegistry, scene: THREE.Scene,
  ): DetachedBooster {
    return new DetachedBooster(
      { ...serialized.stage, id: serialized.id },
      deserializeKinematicState(serialized),
      deserializeAttitude(serialized, DetachedBooster.INERTIA),
      // 記録に無い接触の猶予は、記録した状態の時刻で切れているとみなす。
      serialized.collisionEnableAt ?? serialized.t,
      scene,
      registry.idAllocators.booster.next(serialized.id),
      serialized.thermal,
      serialized.alive,
    );
  }

  // 燃焼比を表示入力へ足す。噴射炎を描かないフレームでは null。
  protected override renderSource(
    viewFrame: DynamicViewFrame, active: boolean, orbitReference: OrbitReference | undefined,
  ): DetachedBoosterRenderSource {
    const motion = this.motion;
    // 燃焼は積分の先端でしか決まっていないので、その時刻を映しているフレームだけ噴かせる。
    const burning = motion.thrust !== null
      && Math.abs(viewFrame.displayTime - motion.state.t) <= BURN_DISPLAY_EPS;
    return {
      ...super.renderSource(viewFrame, active, orbitReference),
      burnRatio: burning ? motion.burnRatio : null,
    };
  }

  // 運動状態と残存段を直列化した形へ変換する。
  public override serialize(): SerializedDetachedBooster {
    const motion = this.motion;
    return {
      ...this.serializeEntityFields(DetachedBooster.kind),
      thermal: motion.thermal,
      // 段の ID はエンティティの ID に揃えて直列化する
      stage: { ...motion.stage, id: this.id },
      collisionEnableAt: motion.collisionEnableAt,
    };
  }
}
