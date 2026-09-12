import * as THREE from 'three/webgpu';
import type { KinematicState } from '../../../physics/kinematic-state';
import type { Vec3 } from '../../../math/vec3';
import { markLitOpaque, markShadowCaster } from '../../pipeline/lit-layer';
import { memoParseShared } from '../baked-model';
import { RcsEffects } from '../player/rcs-effects';
import { ThrustEffects } from '../player/thrust-effects';
import { DynamicView, type DynamicRenderSource, type DynamicViewFrame } from '../dynamic-view';
import baseData from '../../../assets/models/base.json';

// 基地のプルームは自艦より大きく描く倍率。
const BASE_PLUME_SCALE = 6;

const parseBase = memoParseShared<THREE.Group>(baseData);

// 基地のモデルを複製する。+Z が居住区側。geometry/material は全個体の共有物。
function buildBaseModel(): THREE.Group {
  const model = parseBase();
  markLitOpaque(model);
  markShadowCaster(model);
  return model;
}

// 基地の表示入力。
export interface BaseRenderSource extends DynamicRenderSource {
  // 今フレームの並進推力による加速度 [m/s^2](ECI)。噴いていなければ null。
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

  // 基地モデルと噴射用 THREE 資源を組み立てる。
  public constructor(
    protected override readonly scene: THREE.Scene,
    ownerId: string,
  ) {
    super(buildBaseModel(), scene);
    this.thrustEffects = new ThrustEffects(scene, ownerId);
    this.rcsEffects = new RcsEffects(scene, ownerId);
  }

  // そのフレームの推力・トルクから、基地の噴射表現を同期する。
  protected override syncModel(
    source: BaseRenderSource,
    displayed: KinematicState | null,
    viewFrame: DynamicViewFrame,
  ): void {
    const position = displayed?.r ?? null;
    const visible = this.object.visible;
    const cameraQuat = viewFrame.camera.camera.quaternion;
    const zoomActive = viewFrame.camera.zoomed;
    this.thrustEffects.sync(
      viewFrame.camera.floatingOrigin,
      position,
      source.thrust,
      source.maximumAcceleration,
      visible,
      cameraQuat,
      zoomActive,
      viewFrame.style,
      viewFrame.displayTime,
      BASE_PLUME_SCALE,
    );
    // 姿勢制御噴射も、並進噴射と同じ可視判定・倍率で出す。
    this.rcsEffects.sync(
      viewFrame.camera.floatingOrigin,
      position,
      source.torque,
      source.attitude,
      visible,
      cameraQuat,
      zoomActive,
      viewFrame.displayTime,
      BASE_PLUME_SCALE,
    );
  }

  // 基地固有の噴射資源を片付けてから共通 View 資源を破棄する。
  public override dispose(): void {
    this.thrustEffects.dispose(this.scene);
    this.rcsEffects.dispose(this.scene);
    super.dispose();
  }
}
