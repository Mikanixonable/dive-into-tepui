import * as THREE from 'three/webgpu';
import { len } from '../../math/vec3';
import type { KinematicState } from '../../physics/kinematic-state';
import { buildPlayerShip } from '../../render/ships';
import type { MarkerSlots } from '../marker/marker-slots';
import {
  DynamicView, type DynamicViewFrame, type DynamicViewIdentity,
} from '../dynamic/dynamic-view';
import type { DynamicMotion } from '../dynamic/dynamic-motion';
import { AttachedBoostersView } from './attached-boosters-view';
import { BOOSTER_MOUNT_Z } from '../../physics/booster-stage-shape';
import { BELT_MAX_VISIBLE } from './belt';
import { BeltView } from './belt-view';
import { PlayerMarkers } from './player-markers';
import { PlayerMotion } from './player-motion';
import { PowerView } from './power-view';
import { RcsEffects } from './rcs-effects';
import { RadiatorView } from './radiator-view';
import { ReentryEffects } from './reentry-effects';
import { ThrustEffects } from './thrust-effects';

export interface PlayerVisualSource extends DynamicViewIdentity {
  readonly id: string;
  readonly roundsInMag: number;
  readonly magsLeft: number;
  readonly averageMuzzleVelocity: number;
  readonly totalThrust: number;
  readonly throttle: { readonly thrustAccelVec: import('../../math/vec3').Vec3 };
}

function isPlayerVisualSource(identity: DynamicViewIdentity): identity is PlayerVisualSource {
  return identity.mapKind === 'player'
    && 'roundsInMag' in identity
    && 'magsLeft' in identity
    && 'averageMuzzleVelocity' in identity
    && 'totalThrust' in identity
    && 'throttle' in identity;
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
    ownerId: string,
    markerSlots: MarkerSlots,
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
    this.markers = new PlayerMarkers(markerSlots, ownerId);
  }

  protected override syncModel(
    identity: DynamicViewIdentity,
    motion: DynamicMotion,
    displayed: KinematicState | null,
    context: DynamicViewFrame,
  ): void {
    if (!(motion instanceof PlayerMotion) || !isPlayerVisualSource(identity)) {
      throw new TypeError('PlayerView requires Player and PlayerMotion');
    }
    const source = identity;
    const active = context.activeId === source.id;
    const effectState = displayed ?? motion.state;
    const effectVisible = this.object.visible;
    const rcsThrust = len(source.throttle.thrustAccelVec) > 0
      ? source.throttle.thrustAccelVec
      : null;
    const maximumAcceleration = motion.mass > 0 ? source.totalThrust / motion.mass : 0;

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
    this.belt.sync(source.magsLeft, motion.belt.viewState);
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
      source.roundsInMag,
      source.magsLeft,
      source.averageMuzzleVelocity,
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
