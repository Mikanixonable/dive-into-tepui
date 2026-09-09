import * as THREE from 'three/webgpu';
import type { WorldSfx } from '../../audio/sfx/world-sfx';
import { len, lenSq } from '../../math/vec3';
import type { KinematicState } from '../../physics/kinematic-state';
import { buildPlayerShip } from '../../render/ships';
import type { MarkerSlots } from '../marker/marker-slots';
import { DynamicView, type DynamicViewFrame } from '../dynamic/dynamic-view';
import type { DynamicMotion } from '../dynamic/dynamic-motion';
import { AttachedBoostersView } from './attached-boosters-view';
import { BOOSTER_MOUNT_Z } from '../../physics/booster-stage-shape';
import { BELT_MAX_VISIBLE } from './belt';
import { BeltView } from './belt-view';
import { PlayerMarkers } from './player-markers';
import { PlayerMotion } from './player-motion';
import { PowerView } from './power-view';
import { RCS_PUFF_TORQUE_EPS, RcsEffects } from './rcs-effects';
import { RadiatorView } from './radiator-view';
import { ReentryEffects } from './reentry-effects';
import { ThrustEffects } from './thrust-effects';

export interface PlayerVisualSource {
  readonly id: string;
  readonly roundsInMag: number;
  readonly magsLeft: number;
  readonly averageMuzzleVelocity: number;
  readonly totalThrust: number;
  readonly throttle: { readonly thrustAccelVec: import('../../math/vec3').Vec3 };
}

// 自機の全モデル、エフェクト、可動部、戦闘マーカーを所有する。
export class PlayerView extends DynamicView {
  private readonly thrustEffects: ThrustEffects;
  private readonly rcsEffects: RcsEffects;
  private readonly reentryEffects: ReentryEffects;
  private readonly belt: BeltView;
  private readonly radiator: RadiatorView;
  private readonly power: PowerView;
  private readonly boosters: AttachedBoostersView;
  private readonly markers: PlayerMarkers;

  public constructor(
    scene: THREE.Scene,
    private readonly source: PlayerVisualSource,
    markerSlots: MarkerSlots,
    private readonly worldSfx: WorldSfx,
  ) {
    const model = buildPlayerShip();
    super(model, scene);
    this.thrustEffects = new ThrustEffects(scene);
    this.rcsEffects = new RcsEffects(scene);
    this.reentryEffects = new ReentryEffects(scene);
    this.belt = new BeltView(model, BELT_MAX_VISIBLE);
    this.radiator = new RadiatorView(model);
    this.power = new PowerView(model);
    this.boosters = new AttachedBoostersView(scene, model);
    this.markers = new PlayerMarkers(markerSlots, source.id);
  }

  protected override syncModel(
    motion: DynamicMotion,
    displayed: KinematicState | null,
    context: DynamicViewFrame,
  ): void {
    if (!(motion instanceof PlayerMotion)) throw new TypeError('PlayerView requires PlayerMotion');
    const active = context.activeId === this.source.id;
    const effectState = displayed ?? motion.state;
    const effectVisible = this.object.visible;
    const rcsThrust = len(this.source.throttle.thrustAccelVec) > 0
      ? this.source.throttle.thrustAccelVec
      : null;
    const maximumAcceleration = motion.mass > 0 ? this.source.totalThrust / motion.mass : 0;

    this.boosters.sync(
      context.floatingOrigin,
      effectState.r,
      context.displayTime,
      motion.state.t,
      motion.att,
      motion.attachedBoosters.stages,
      motion.attachedBoosters.thrust,
      motion.attachedBoosters.burnRatio,
      effectVisible,
      context.cameraSystem,
      context.style,
      BOOSTER_MOUNT_Z,
    );
    if (active) {
      this.worldSfx.setThrust(
        effectVisible && (rcsThrust !== null || motion.attachedBoosters.thrust !== null),
      );
      this.worldSfx.setRcs(effectVisible
        && lenSq(motion.torque) > RCS_PUFF_TORQUE_EPS * RCS_PUFF_TORQUE_EPS);
    }
    this.thrustEffects.sync(
      context.floatingOrigin,
      effectState.r,
      rcsThrust,
      maximumAcceleration,
      effectVisible,
      context.cameraSystem,
      context.style,
    );
    this.rcsEffects.sync(
      context.floatingOrigin,
      effectState.r,
      motion.torque,
      motion.att,
      effectVisible,
      context.cameraSystem,
    );
    this.reentryEffects.sync(
      context.floatingOrigin,
      effectState.r,
      effectState.v,
      motion.aero.qdyn,
      effectVisible,
      context.cameraSystem,
    );
    this.belt.sync(this.source.magsLeft, motion.belt.viewState);
    this.radiator.sync(
      side => motion.radiator.wearOf(side),
      side => motion.radiator.viewTilt(side),
    );
    this.power.sync(side => motion.power.deployOf(side));
    this.markers.sync(
      motion.state,
      motion.att,
      context.cameraSystem.view,
      active,
      context.cameraSystem.activeCameraProjection,
      this.source.roundsInMag,
      this.source.magsLeft,
      this.source.averageMuzzleVelocity,
      context.orbitReference,
    );
    if (active && context.cameraSystem.zoomActive) this.object.visible = false;
  }

  public override dispose(): void {
    this.markers.dispose();
    this.boosters.dispose();
    this.thrustEffects.dispose(this.scene!);
    this.rcsEffects.dispose(this.scene!);
    this.reentryEffects.dispose(this.scene!);
    super.dispose();
  }
}
