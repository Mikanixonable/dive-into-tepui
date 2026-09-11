import * as THREE from 'three/webgpu';
import { qRotate, type Quat } from '../../../math/quat';
import { add, v3, type Vec3 } from '../../../math/vec3';
import type { FloatingOrigin } from '../../camera/floating-origin';
import type { RenderStyle } from '../../render-style';
import { BoosterPlumeSet } from '../booster-plume';
import { buildBoosterStage } from '../ships';
import { BOOSTER_MOUNT_Z, BOOSTER_STAGE_DIMENSIONS } from '../../../physics/booster-stage-shape';

// 接続中ブースターの、そのフレームの表示入力。
export interface AttachedBoostersDisplay {
  readonly stageIds: readonly string[]; // 船体側から最後尾へ並ぶ段の識別子
  readonly firing: boolean; // 最後尾段が推力を出しているか
  readonly burnRatio: number; // 直近の区間のうち燃焼していた割合 (0..1)
}

// 接続中ブースターのモデルと噴射炎を所有し、供給された段の並びと燃焼へ同期する。
export class AttachedBoostersView {
  private readonly plumes: BoosterPlumeSet;
  private readonly models: THREE.Group[] = [];
  private stageIds: readonly string[] = [];

  public constructor(scene: THREE.Scene, private readonly root: THREE.Object3D) {
    this.plumes = new BoosterPlumeSet(scene);
  }

  // 段の顔ぶれが変わったときだけ、機体へ並べ直す。最後尾以外は段間カバーを被せる。
  private setStages(stageIds: readonly string[]): void {
    for (const model of this.models) model.removeFromParent();
    this.models.length = 0;
    for (let i = 0; i < stageIds.length; i++) {
      const model = buildBoosterStage(i < stageIds.length - 1);
      model.position.z = BOOSTER_MOUNT_Z - i * BOOSTER_STAGE_DIMENSIONS.length;
      this.root.add(model);
      this.models.push(model);
    }
    this.stageIds = stageIds;
  }

  // 段の並びを機体へ同期し、最下段のノズルへ噴射炎を置く。position は機体を置く表示時刻の
  // ECI 位置で、引けないフレームは null。噴射炎が出るのは、推力があって表示時刻が実時刻に
  // 一致しているときだけ(予測位置のゴーストからは吹かせない)。
  public sync(
    floatingOrigin: FloatingOrigin,
    position: Vec3 | null,
    displayTime: number,
    actualTime: number,
    attitude: Quat,
    boosters: AttachedBoostersDisplay,
    visible: boolean,
    cameraQuat: THREE.Quaternion,
    zoomActive: boolean,
    style: RenderStyle,
  ): void {
    // 段のモデルは顔ぶれが変わったときだけ組み直す。
    const stageIds = boosters.stageIds;
    if (stageIds.length !== this.stageIds.length
      || stageIds.some((id, index) => id !== this.stageIds[index])) {
      this.setStages(stageIds);
    }
    // 噴くのは最後尾段だけなので、条件が揃わないフレームはプルームを空にする。
    const activeIndex = stageIds.length - 1;
    const atCurrentTime = Math.abs(displayTime - actualTime) <= 1e-6;
    if (activeIndex < 0 || position === null || !boosters.firing || !visible
      || !atCurrentTime || zoomActive) {
      this.plumes.sync([], cameraQuat, style);
      return;
    }
    const nozzleZ = BOOSTER_MOUNT_Z
      - activeIndex * BOOSTER_STAGE_DIMENSIONS.length
      + BOOSTER_STAGE_DIMENSIONS.nozzleExitZ;
    const nozzleWorld = add(position, qRotate(attitude, v3(0, 0, nozzleZ)));
    const tail = qRotate(attitude, v3(0, 0, -1));
    this.plumes.sync([{
      position: floatingOrigin.RtoThreeV3(nozzleWorld),
      direction: new THREE.Vector3(tail.x, tail.y, tail.z),
      intensity: Math.max(0.25, boosters.burnRatio),
      visible: true,
    }], cameraQuat, style);
  }

  // 噴射炎を破棄し、段のモデルを機体から外す。
  public dispose(): void {
    this.plumes.dispose();
    for (const model of this.models) model.removeFromParent();
    this.models.length = 0;
  }
}
