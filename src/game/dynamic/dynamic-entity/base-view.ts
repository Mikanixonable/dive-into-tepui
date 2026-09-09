import * as THREE from 'three/webgpu';
import { lenSq } from '../../../math/vec3';
import type { KinematicState } from '../../../physics/kinematic-state';
import { buildBaseModel } from '../../../render/base-station-model';
import type { WorldSfx } from '../../../audio/sfx/world-sfx';
import { RCS_PUFF_TORQUE_EPS, RcsEffects } from '../../player/rcs-effects';
import { ThrustEffects } from '../../player/thrust-effects';
import { DynamicView, type DynamicViewFrame } from '../dynamic-view';
import type { DynamicMotion } from '../dynamic-motion';
import { BaseMotion } from './base-motion';
import type { MarkerSlots } from '../../marker/marker-slots';

// 基地モデル、噴射エフェクト、操作中の推進音を所有する。
export class BaseView extends DynamicView {
  private readonly thrustEffects: ThrustEffects;
  private readonly rcsEffects: RcsEffects;

  public constructor(
    scene: THREE.Scene,
    private readonly worldSfx: WorldSfx,
    private readonly ownerId: string,
    private readonly markers: MarkerSlots,
  ) {
    super(buildBaseModel(), scene);
    this.thrustEffects = new ThrustEffects(scene);
    this.rcsEffects = new RcsEffects(scene);
  }

  protected override syncModel(
    motion: DynamicMotion,
    displayed: KinematicState | null,
    context: DynamicViewFrame,
  ): void {
    if (!(motion instanceof BaseMotion)) throw new TypeError('BaseView requires BaseMotion');
    const controlled = context.activeId === this.ownerId;
    const effectState = displayed ?? motion.state;
    const visible = this.object.visible;
    this.worldSfx.setThrust(controlled && visible && motion.thrust !== null);
    this.worldSfx.setRcs(controlled && visible
      && lenSq(motion.torque) > RCS_PUFF_TORQUE_EPS * RCS_PUFF_TORQUE_EPS);
    this.thrustEffects.sync(
      context.floatingOrigin,
      effectState.r,
      motion.thrust,
      motion.maximumAcceleration,
      visible,
      context.cameraSystem,
      context.style,
      6,
    );
    this.rcsEffects.sync(
      context.floatingOrigin,
      effectState.r,
      motion.torque,
      motion.att,
      visible,
      context.cameraSystem,
      6,
    );
  }

  public override dispose(): void {
    this.markers.remove(`base-${this.ownerId}`);
    this.markers.remove(`base-${this.ownerId}-bearing`);
    this.thrustEffects.dispose(this.scene!);
    this.rcsEffects.dispose(this.scene!);
    super.dispose();
  }
}
