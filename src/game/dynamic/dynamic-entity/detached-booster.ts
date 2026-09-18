import * as THREE from 'three/webgpu';
import { v3 } from '../../../math/vec3';
import { deserializeAttitude, type Attitude } from '../../../physics/attitude';
import { deserializeKinematicState, type KinematicState } from '../../../physics/kinematic-state';
import type { BoosterStage, SerializedBoosterStage } from '../../player/booster-stack';
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

// 分離後も独立して燃焼・慣性飛行するブースター。接続中の段は SerializedPlayer 側へ保存する。
export interface SerializedDetachedBooster extends SerializedDynamicEntityFields {
  readonly kind: 'booster';
  readonly stage: SerializedBoosterStage;
  // 分離直後の親艦との再接触を避ける猶予の期限。無ければ即時に接触できる。
  readonly collisionEnableAt?: number;
}

type DetachedBoosterInit =
  | {
    readonly stage: BoosterStage;
    readonly state: KinematicState;
    readonly att: Attitude;
    readonly collisionEnableAt: number;
  }
  | { readonly saved: SerializedDetachedBooster; readonly simTime: number };

// 分離ブースターの識別情報、運動、表示を一体として所有する。
export class DetachedBooster extends DynamicEntity {
  public override readonly mapKind: DynamicEntityKind = 'player';
  public override readonly capKind = 'booster';
  public declare readonly motion: DetachedBoosterMotion;

  // 新規の分離は切り離した段と分離時の状態から、再開は saved を simTime 付きの状態として展開して
  // 組む。id は段の id を引き継ぐ。
  public constructor(init: DetachedBoosterInit, scene: THREE.Scene, idAllocators: EntityIdAllocators) {
    // 復元と新規の分離を同じ形へ均してから基底へ渡す。
    const restored = 'saved' in init;
    const stage = restored ? { ...init.saved.stage, id: init.saved.id } : { ...init.stage };
    const state = restored ? deserializeKinematicState(init.saved, init.simTime) : init.state;
    const attitude: Attitude = restored ? deserializeAttitude(init.saved, v3(1, 1, 0.4)) : init.att;
    const collisionEnableAt = restored
      ? (init.saved.collisionEnableAt ?? init.simTime)
      : init.collisionEnableAt;
    super(
      () => new DetachedBoosterMotion(state, attitude, stage, collisionEnableAt),
      new DetachedBoosterView(scene),
      idAllocators.booster.next(stage.id),
    );
    this.setName('分離ブースター');
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
      kind: 'booster',
      r: { ...motion.state.r },
      v: { ...motion.state.v },
      q: { ...motion.att.q },
      w: { ...motion.att.w },
      // 段の ID はエンティティの ID に揃えて保存する
      stage: { ...motion.stage, id: this.id },
      collisionEnableAt: motion.collisionEnableAt,
    };
  }
}
