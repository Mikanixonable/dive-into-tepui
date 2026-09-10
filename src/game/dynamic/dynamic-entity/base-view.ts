import * as THREE from 'three/webgpu';
import type { KinematicState } from '../../../physics/kinematic-state';
import { buildBaseModel } from '../../../render/base-station-model';
import { RcsEffects } from '../../player/rcs-effects';
import { ThrustEffects } from '../../player/thrust-effects';
import { DynamicView, type DynamicViewFrame, type DynamicViewIdentity } from '../dynamic-view';
import type { DynamicMotion } from '../dynamic-motion';
import { BaseMotion } from './base-motion';
import type { MarkerSlots } from '../../marker/marker-slots';

// 基地モデルと噴射エフェクトを所有する。
export class BaseView extends DynamicView {
  private readonly thrustEffects: ThrustEffects;
  private readonly rcsEffects: RcsEffects;

  // 基地モデルと噴射用 THREE 資源だけを組み立てる。
  public constructor(
    scene: THREE.Scene,
    private readonly ownerId: string,
    private readonly markers: MarkerSlots,
  ) {
    super(buildBaseModel(), scene);
    this.thrustEffects = new ThrustEffects(scene);
    this.rcsEffects = new RcsEffects(scene);
  }

  // 外部の Motion とフレーム入力から、基地の噴射表現を同期する。
  protected override syncModel(
    _identity: DynamicViewIdentity,
    motion: DynamicMotion,
    displayed: KinematicState | null,
    context: DynamicViewFrame,
  ): void {
    if (!(motion instanceof BaseMotion)) throw new TypeError('BaseView requires BaseMotion');
    // 表示時刻を引けない場合も、現在状態を使って既存エフェクトを確実に畳む。
    const effectState = displayed ?? motion.state;
    const visible = this.object.visible;
    const cameraQuat = context.cameraSystem.activeCamera.quaternion;
    const zoomActive = context.cameraSystem.zoomActive;
    this.thrustEffects.sync(
      context.floatingOrigin,
      effectState.r,
      motion.thrust,
      motion.maximumAcceleration,
      visible,
      cameraQuat,
      zoomActive,
      context.style,
      6,
    );
    // 並進噴射と姿勢制御噴射は別資源なので、それぞれ同じ可視判定を渡す。
    this.rcsEffects.sync(
      context.floatingOrigin,
      effectState.r,
      motion.torque,
      motion.att,
      visible,
      cameraQuat,
      zoomActive,
      6,
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
