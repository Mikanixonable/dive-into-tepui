import * as THREE from 'three/webgpu';
import { qRotate } from '../../../math/quat';
import { add, v3 } from '../../../math/vec3';
import type { KinematicState } from '../../../physics/kinematic-state';
import { BoosterPlume } from '../booster-plume';
import { buildBoosterStage } from '../booster-model';
import { BOOSTER_STAGE_DIMENSIONS } from '../../../physics/booster-stage-shape';
import { DynamicView, type DynamicRenderSource, type DynamicViewFrame } from '../dynamic-view';

// 段の前端と後端の中点。剛体の原点はここに置く。
const STAGE_CENTER_Z = (BOOSTER_STAGE_DIMENSIONS.frontZ + BOOSTER_STAGE_DIMENSIONS.aftZ) / 2;

// 噴射炎の最小の太さ。燃焼比がこれを下回っても、炎そのものは見える大きさで残す。
const MIN_PLUME_INTENSITY = 0.25;

// 分離段の表示入力。
export interface DetachedBoosterRenderSource extends DynamicRenderSource {
  // このフレームに噴いている割合(0..1)。燃焼を描かないフレームは null。
  readonly burnRatio: number | null;
}

// 分離ブースターの機体モデルと噴射炎を所有し、運動状態へ同期する。
export class DetachedBoosterView extends DynamicView<DetachedBoosterRenderSource> {
  private readonly plume: BoosterPlume;

  // 分離段の本体と、scene 直下に置く噴射炎を同じ寿命で組み立てる。
  public constructor(scene: THREE.Scene) {
    const root = new THREE.Group();
    super(root, scene);
    const model = buildBoosterStage(false);
    model.position.z = -STAGE_CENTER_Z;
    root.add(model);
    this.plume = new BoosterPlume(scene);
  }

  // 分離段が示す燃焼状態を、噴射炎へ同期する。
  protected override syncModel(
    source: DetachedBoosterRenderSource,
    displayed: KinematicState | null,
    context: DynamicViewFrame,
  ): void {
    // 照準ズーム中は機体そのものを覗き込むので、炎で視界を潰さない。
    if (displayed === null || source.burnRatio === null || context.camera.zoomed) {
      this.plume.hide();
      return;
    }
    // ノズル位置と後方軸を表示時刻の姿勢でワールドへ写す。
    const nozzleFromCenter = BOOSTER_STAGE_DIMENSIONS.nozzleExitZ - STAGE_CENTER_Z;
    const nozzleWorld = add(displayed.r, qRotate(source.attitude, v3(0, 0, nozzleFromCenter)));
    const tailDirection = qRotate(source.attitude, v3(0, 0, -1));
    this.plume.sync({
      position: context.camera.floatingOrigin.RtoThreeV3(nozzleWorld),
      direction: new THREE.Vector3(tailDirection.x, tailDirection.y, tailDirection.z),
      intensity: Math.max(MIN_PLUME_INTENSITY, source.burnRatio),
      visible: true,
    }, context.camera.camera.quaternion, context.style);
  }

  // 噴射炎を破棄してから、共通 View 資源を片付ける。
  public override dispose(): void {
    this.plume.dispose(this.scene!);
    super.dispose();
  }
}
