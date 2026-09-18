import * as THREE from 'three/webgpu';
import { v3 } from '../../../math/vec3';
import { deserializeAttitude, type Attitude } from '../../../physics/attitude';
import { deserializeKinematicState, type KinematicState } from '../../../physics/kinematic-state';
import type { BoosterStage } from '../../player/booster-stack';
import { DetachedBoosterMotion } from './detached-booster-motion';
import {
  DetachedBoosterView, type DetachedBoosterRenderSource,
} from '../../../render/dynamic/dynamic-entity/detached-booster-view';
import type { DynamicViewFrame } from '../../../render/dynamic/dynamic-view';
import { DynamicEntity, type SerializedDynamicEntityFields } from './dynamic-entity';
import type { DynamicEntityKind } from './entity-kind';
import type { EntityIdAllocators } from './entity-id';
import type { OrbitReference } from '../../orbit-reference';

// 表示時刻を「現在」とみなす許容差 [sim s]。
const BURN_DISPLAY_EPS = 1e-6;

// 分離後も独立して燃焼・慣性飛行するブースター。接続中の段は SerializedPlayer 側に直列化される。
export interface SerializedDetachedBooster extends SerializedDynamicEntityFields {
  readonly kind: 'booster';
  readonly stage: BoosterStage;
  // 分離直後の親艦との再接触を避ける猶予の期限。無ければ即時に接触できる。
  readonly collisionEnableAt?: number;
}

// 分離ブースターの識別情報、運動、表示を一体として所有する。
export class DetachedBooster extends DynamicEntity {
  public static readonly kind = 'booster';
  public static spawnGate(): null { return null; }

  public override readonly mapKind: DynamicEntityKind = 'player';
  public override readonly capKind = 'booster';
  public declare readonly motion: DetachedBoosterMotion;

  // 切り離した段 stage を、state・attitude で飛ばす。collisionEnableAt は親艦との接触を許す時刻。
  // id は段の id を引き継ぐ。
  private constructor(
    stage: BoosterStage,
    state: KinematicState,
    attitude: Attitude,
    collisionEnableAt: number,
    scene: THREE.Scene,
    idAllocators: EntityIdAllocators,
  ) {
    super(
      () => new DetachedBoosterMotion(state, attitude, stage, collisionEnableAt),
      new DetachedBoosterView(scene),
      idAllocators.booster.next(stage.id),
    );
    this.setName('分離ブースター');
  }

  // 切り離した段 stage を、分離時の状態 state・attitude で新しく飛ばす。collisionEnableAt は親艦との
  // 接触を許す時刻。
  public static create(
    stage: BoosterStage,
    state: KinematicState,
    attitude: Attitude,
    collisionEnableAt: number,
    scene: THREE.Scene,
    idAllocators: EntityIdAllocators,
  ): DetachedBooster {
    return new DetachedBooster({ ...stage }, state, attitude, collisionEnableAt, scene, idAllocators);
  }

  // 直列化した分離ブースターを、時刻 simTime の状態として復元する。
  public static deserialize(
    serialized: SerializedDetachedBooster, simTime: number, idAllocators: EntityIdAllocators, scene: THREE.Scene,
  ): DetachedBooster {
    return new DetachedBooster(
      { ...serialized.stage, id: serialized.id },
      deserializeKinematicState(serialized, simTime),
      deserializeAttitude(serialized, v3(1, 1, 0.4)),
      // 記録に無い接触の猶予は、復元した時刻で切れているとみなす。
      serialized.collisionEnableAt ?? simTime,
      scene,
      idAllocators,
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
      id: this.id,
      name: this.name,
      kind: DetachedBooster.kind,
      r: { ...motion.state.r },
      v: { ...motion.state.v },
      q: { ...motion.att.q },
      w: { ...motion.att.w },
      // 段の ID はエンティティの ID に揃えて直列化する
      stage: { ...motion.stage, id: this.id },
      collisionEnableAt: motion.collisionEnableAt,
    };
  }
}
