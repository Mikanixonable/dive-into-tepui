import * as THREE from 'three/webgpu';
import type { KinematicState } from '../../../physics/kinematic-state';
import type { Vec3 } from '../../../math/vec3';
import { buildBaseModel } from '../ships';
import { RcsEffects } from '../player/rcs-effects';
import { ThrustEffects } from '../player/thrust-effects';
import { DynamicView, type DynamicRenderSource, type DynamicViewFrame } from '../dynamic-view';
import type { MarkerSlots } from '../../../game/marker/marker-slots';

// 基地のプルームは自艦より大きく描く倍率。
const BASE_PLUME_SCALE = 6;

// 基地の表示入力。
export interface BaseRenderSource extends DynamicRenderSource {
  // 今フレームの並進推力。噴いていなければ null。
  readonly thrust: Vec3 | null;
  // 全開時の加速度 [m/s^2]。プルームの大きさを出力比で決めるのに使う。
  readonly maximumAcceleration: number;
  // 今フレームの指令トルク(機体座標)。
  readonly torque: Vec3;
}

// 基地モデルと噴射エフェクトを所有する。
export class BaseView extends DynamicView<BaseRenderSource> {
  private readonly thrustEffects: ThrustEffects;
  private readonly rcsEffects: RcsEffects;

  // 基地モデルと噴射用 THREE 資源だけを組み立てる。
  public constructor(
    scene: THREE.Scene,
    private readonly ownerId: string,
    private readonly markers: MarkerSlots,
  ) {
    super(buildBaseModel(), scene);
    this.thrustEffects = new ThrustEffects(scene, ownerId);
    this.rcsEffects = new RcsEffects(scene, ownerId);
  }

  // そのフレームの推力・トルクから、基地の噴射表現を同期する。
  protected override syncModel(
    source: BaseRenderSource,
    displayed: KinematicState | null,
    context: DynamicViewFrame,
  ): void {
    const position = displayed?.r ?? null;
    const visible = this.object.visible;
    const cameraQuat = context.camera.camera.quaternion;
    const zoomActive = context.camera.zoomed;
    this.thrustEffects.sync(
      context.camera.floatingOrigin,
      position,
      source.thrust,
      source.maximumAcceleration,
      visible,
      cameraQuat,
      zoomActive,
      context.style,
      context.displayTime,
      BASE_PLUME_SCALE,
    );
    // 並進噴射と姿勢制御噴射は別資源なので、それぞれ同じ可視判定を渡す。
    this.rcsEffects.sync(
      context.camera.floatingOrigin,
      position,
      source.torque,
      source.attitude,
      visible,
      cameraQuat,
      zoomActive,
      context.displayTime,
      BASE_PLUME_SCALE,
    );
  }

  // 基地固有の DOM・噴射資源を片付けてから共通 View 資源を破棄する。
  public override dispose(): void {
    this.markers.remove(`base-${this.ownerId}`);
    this.markers.remove(`base-${this.ownerId}-bearing`);
    this.thrustEffects.dispose(this.scene!);
    this.rcsEffects.dispose(this.scene!);
    super.dispose();
  }
}
