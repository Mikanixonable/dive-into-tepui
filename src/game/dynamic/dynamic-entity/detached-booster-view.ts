import * as THREE from 'three/webgpu';
import { qRotate } from '../../../math/quat';
import { add, v3 } from '../../../math/vec3';
import type { KinematicState } from '../../../physics/kinematic-state';
import {
  BoosterPlume,
  buildBoosterStage,
  type BoosterStage as BoosterStageModel,
} from '../../../render/booster';
import { BOOSTER_STAGE_DIMENSIONS } from '../../../physics/booster-stage-shape';
import { DynamicView, type DynamicViewFrame, type DynamicViewIdentity } from '../dynamic-view';
import type { DynamicMotion } from '../dynamic-motion';
import { DetachedBoosterMotion } from './detached-booster-motion';

// 分離ブースターの機体モデルと噴射炎を所有し、運動状態へ同期する。
export class DetachedBoosterView extends DynamicView {
  private readonly model: BoosterStageModel;
  private readonly plume: BoosterPlume;

  public constructor(scene: THREE.Scene) {
    const root = new THREE.Group();
    super(root, scene);
    this.model = buildBoosterStage({ interstageCover: false });
    const centerZ = (BOOSTER_STAGE_DIMENSIONS.frontZ + BOOSTER_STAGE_DIMENSIONS.aftZ) / 2;
    this.model.position.z = -centerZ;
    root.add(this.model);
    this.plume = new BoosterPlume(scene);
  }

  protected override syncModel(
    _identity: DynamicViewIdentity,
    motion: DynamicMotion,
    displayed: KinematicState | null,
    context: DynamicViewFrame,
  ): void {
    if (!(motion instanceof DetachedBoosterMotion)) {
      throw new TypeError('DetachedBoosterView requires DetachedBoosterMotion');
    }
    if (displayed === null || motion.thrust === null
      || Math.abs(context.displayTime - motion.state.t) > 1e-6
      || context.cameraSystem.zoomActive) {
      this.plume.hide();
      return;
    }
    const centerZ = (BOOSTER_STAGE_DIMENSIONS.frontZ + BOOSTER_STAGE_DIMENSIONS.aftZ) / 2;
    const nozzleFromCenter = BOOSTER_STAGE_DIMENSIONS.nozzleExitZ - centerZ;
    const nozzleWorld = add(displayed.r, qRotate(motion.att.q, v3(0, 0, nozzleFromCenter)));
    const tailDirection = qRotate(motion.att.q, v3(0, 0, -1));
    this.plume.sync({
      position: context.floatingOrigin.RtoThreeV3(nozzleWorld),
      direction: new THREE.Vector3(tailDirection.x, tailDirection.y, tailDirection.z),
      intensity: Math.max(0.25, motion.burnRatio),
      visible: true,
    }, context.cameraSystem.activeCamera.quaternion, context.style);
  }

  public override dispose(): void {
    this.plume.dispose(this.scene!);
    this.model.dispose();
    super.dispose();
  }
}
