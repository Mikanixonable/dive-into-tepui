import * as THREE from 'three/webgpu';
import { v3 } from '../../../math/vec3';
import type { Attitude } from '../../../physics/attitude';
import type { KinematicState } from '../../../physics/kinematic-state';
import { savedAttitude, savedKinematicState, type DetachedBoosterSaveData } from '../../save/save-data';
import { nextBoosterId, type BoosterStage } from '../../player/booster-stack';
import { DetachedBoosterMotion } from './detached-booster-motion';
import { DetachedBoosterView } from './detached-booster-view';
import { DynamicEntity } from './dynamic-entity';
import type { DynamicEntityKind } from './entity-kind';

type DetachedBoosterInit =
  | {
    readonly stage: BoosterStage;
    readonly state: KinematicState;
    readonly att: Attitude;
    readonly collisionEnableAt: number;
  }
  | { readonly saved: DetachedBoosterSaveData; readonly simTime: number };

// 分離ブースターの識別情報、運動、表示を一体として所有する。
export class DetachedBooster extends DynamicEntity {
  public override readonly mapKind: DynamicEntityKind = 'player';
  public override readonly capKind = 'booster';

  public constructor(init: DetachedBoosterInit, scene: THREE.Scene) {
    const restored = 'saved' in init;
    const stage = restored ? { ...init.saved.stage, id: init.saved.id } : { ...init.stage };
    const state = restored ? savedKinematicState(init.saved, init.simTime) : init.state;
    const attitude: Attitude = restored ? savedAttitude(init.saved, v3(1, 1, 0.4)) : init.att;
    const collisionEnableAt = restored
      ? (init.saved.collisionEnableAt ?? init.simTime)
      : init.collisionEnableAt;
    super(
      state,
      new DetachedBoosterView(scene),
      attitude,
      nextBoosterId(stage.id),
      () => new DetachedBoosterMotion(state, attitude, stage, collisionEnableAt),
    );
    this.setName('分離ブースター');
  }

  // 運動状態と残存段をセーブ用データへ変換する。
  public override serialize(): DetachedBoosterSaveData {
    const motion = this.motion as DetachedBoosterMotion;
    return {
      id: this.id,
      name: this.name,
      kind: 'booster',
      r: { ...motion.state.r },
      v: { ...motion.state.v },
      q: { ...motion.att.q },
      w: { ...motion.att.w },
      stage: { ...motion.stage, id: this.id },
      collisionEnableAt: motion.collisionEnableAt,
    };
  }
}
