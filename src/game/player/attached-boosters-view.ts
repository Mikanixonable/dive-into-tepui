import * as THREE from 'three/webgpu';
import type { Attitude } from '../../physics/attitude';
import { qRotate } from '../../math/quat';
import { add, v3, type Vec3 } from '../../math/vec3';
import type { FloatingOrigin } from '../camera/floating-origin';
import type { CameraSystem } from '../camera/camera-system';
import type { RenderStyle } from '../../render/render-style';
import {
  BoosterPlumeSet,
  buildBoosterStage,
  type BoosterStage as BoosterStageModel,
} from '../../render/booster';
import { BOOSTER_STAGE_DIMENSIONS } from '../../physics/booster-stage-shape';
import type { BoosterStage } from './booster-stack';

// 接続中ブースターのモデルと噴射炎を所有し、運動状態へ同期する。
export class AttachedBoostersView {
  private readonly plumes: BoosterPlumeSet;
  private readonly models: BoosterStageModel[] = [];
  private stageIds: readonly string[] = [];

  constructor(scene: THREE.Scene, private readonly root: THREE.Object3D) {
    this.plumes = new BoosterPlumeSet(scene);
  }

  private setStages(stages: readonly BoosterStage[], mountZ: number): void {
    for (const model of this.models) model.dispose();
    this.models.length = 0;
    for (let i = 0; i < stages.length; i++) {
      const model = buildBoosterStage({ interstageCover: i < stages.length - 1 });
      model.position.z = mountZ - i * BOOSTER_STAGE_DIMENSIONS.length;
      this.root.add(model);
      this.models.push(model);
    }
    this.stageIds = stages.map(stage => stage.id);
  }

  sync(
    floatingOrigin: FloatingOrigin,
    effectPosition: Vec3,
    displayTime: number,
    actualTime: number,
    attitude: Attitude,
    stages: readonly BoosterStage[],
    thrust: Vec3 | null,
    burnRatio: number,
    visible: boolean,
    camera: CameraSystem,
    style: RenderStyle,
    mountZ: number,
  ): void {
    if (stages.length !== this.stageIds.length
      || stages.some((stage, index) => stage.id !== this.stageIds[index])) {
      this.setStages(stages, mountZ);
    }
    const activeIndex = stages.length - 1;
    const atCurrentTime = Math.abs(displayTime - actualTime) <= 1e-6;
    if (activeIndex < 0 || thrust === null || !visible || !atCurrentTime || camera.zoomActive) {
      this.plumes.sync([], camera.activeCamera.quaternion, style);
      return;
    }
    const nozzleZ = mountZ
      - activeIndex * BOOSTER_STAGE_DIMENSIONS.length
      + BOOSTER_STAGE_DIMENSIONS.nozzleExitZ;
    const nozzleWorld = add(effectPosition, qRotate(attitude.q, v3(0, 0, nozzleZ)));
    const tail = qRotate(attitude.q, v3(0, 0, -1));
    this.plumes.sync([{
      position: floatingOrigin.RtoThreeV3(nozzleWorld),
      direction: new THREE.Vector3(tail.x, tail.y, tail.z),
      intensity: Math.max(0.25, burnRatio),
      visible: true,
    }], camera.activeCamera.quaternion, style);
  }

  dispose(): void {
    this.plumes.dispose();
    for (const model of this.models) model.dispose();
    this.models.length = 0;
  }
}
