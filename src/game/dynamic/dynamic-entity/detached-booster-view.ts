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

  // 分離段の本体と、scene 直下に置く噴射炎を同じ寿命で組み立てる。
  public constructor(scene: THREE.Scene) {
    const root = new THREE.Group();
    super(root, scene);
    this.model = buildBoosterStage({ interstageCover: false });
    const centerZ = (BOOSTER_STAGE_DIMENSIONS.frontZ + BOOSTER_STAGE_DIMENSIONS.aftZ) / 2;
    this.model.position.z = -centerZ;
    root.add(this.model);
    this.plume = new BoosterPlume(scene);
  }

  // 外部 Motion が示す燃焼状態を、分離段の噴射炎へ同期する。
  protected override syncModel(
    _identity: DynamicViewIdentity,
    motion: DynamicMotion,
    displayed: KinematicState | null,
    context: DynamicViewFrame,
  ): void {
    // 現在時刻の燃焼だけを描き、過去・未来表示や照準ズームでは必ず隠す。
    if (!(motion instanceof DetachedBoosterMotion)) {
      throw new TypeError('DetachedBoosterView requires DetachedBoosterMotion');
    }
    if (displayed === null || motion.thrust === null
      || Math.abs(context.displayTime - motion.state.t) > 1e-6
      || context.cameraSystem.zoomActive) {
      this.plume.hide();
      return;
    }
    // ノズル位置と後方軸を表示時刻の姿勢でワールドへ写す。
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

  // 噴射炎と段モデルを破棄してから、共通 View 資源を片付ける。
  public override dispose(): void {
    this.plume.dispose(this.scene!);
    this.model.dispose();
    super.dispose();
  }
}
