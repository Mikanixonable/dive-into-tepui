import * as THREE from 'three/webgpu';
import { len } from '../../../math/vec3';
import type { KinematicState } from '../../../physics/kinematic-state';
import { buildPlayerShip } from '../ships';
import type { MarkerSlots } from '../../../game/marker/marker-slots';
import {
  DynamicView, type DynamicViewFrame, type DynamicViewIdentity,
} from '../dynamic-view';
import type { DynamicMotion } from '../../../game/dynamic/dynamic-motion';
import { AttachedBoostersView } from './attached-boosters-view';
import { BELT_MAX_VISIBLE } from '../../../game/player/belt';
import { BeltView } from './belt-view';
import { PlayerMarkers } from '../../../game/player/player-markers';
import { PlayerMotion } from '../../../game/player/player-motion';
import { PowerView } from './power-view';
import { RcsEffects } from './rcs-effects';
import { RadiatorView } from './radiator-view';
import { ReentryEffects } from '../../../game/player/reentry-effects';
import { ThrustEffects } from './thrust-effects';

interface PlayerVisualSource extends DynamicViewIdentity {
  readonly id: string;
  readonly roundsInMag: number;
  readonly magsLeft: number;
  readonly averageMuzzleVelocity: number;
  readonly totalThrust: number;
  readonly throttle: { readonly thrustAccelVec: import('../../../math/vec3').Vec3 };
}

// DynamicView の共通識別入力が Player 固有の表示値も備えることを確認する。
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

  // 自機モデルと、その子表示・噴射・DOM マーカー資源を組み立てる。
  public constructor(
    scene: THREE.Scene,
    ownerId: string,
    markerSlots: MarkerSlots,
  ) {
    // 船体を根にして、形状に密着する子表示を同じツリーへ結び付ける。
    const model = buildPlayerShip();
    super(model, scene);
    this.thrustEffects = new ThrustEffects(scene);
    this.rcsEffects = new RcsEffects(scene);
    this.reentryEffects = new ReentryEffects(scene);
    this.belt = new BeltView(model, BELT_MAX_VISIBLE);
    this.radiator = new RadiatorView(model);
    this.power = new PowerView(model);
    // scene 直下へ出る噴射と DOM マーカーも、この View の寿命に揃える。
    this.boosters = new AttachedBoostersView(scene, model);
    this.markers = new PlayerMarkers(markerSlots, ownerId);
  }

  // Player が毎フレーム供給する値を、船体の全表示資源へ一括して反映する。
  protected override syncModel(
    identity: DynamicViewIdentity,
    motion: DynamicMotion,
    displayed: KinematicState | null,
    context: DynamicViewFrame,
  ): void {
    if (!(motion instanceof PlayerMotion) || !isPlayerVisualSource(identity)) {
      throw new TypeError('PlayerView requires Player and PlayerMotion');
    }
    // 表示時刻の状態を各エフェクトへ渡し、欠けた場合は現在状態で非表示処理を完遂する。
    const source = identity;
    const active = context.activeId === source.id;
    const effectState = displayed ?? motion.state;
    const effectVisible = this.object.visible;
    const cameraQuat = context.cameraSystem.activeCamera.quaternion;
    const zoomActive = context.cameraSystem.zoomActive;
    const rcsThrust = len(source.throttle.thrustAccelVec) > 0
      ? source.throttle.thrustAccelVec
      : null;
    const maximumAcceleration = motion.mass > 0 ? source.totalThrust / motion.mass : 0;

    // 船外へ出るブースター・推力・RCS・再突入表現は同じ可視性に揃える。
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
      cameraQuat,
      zoomActive,
      context.style,
    );
    this.thrustEffects.sync(
      context.floatingOrigin,
      effectState.r,
      rcsThrust,
      maximumAcceleration,
      effectVisible,
      cameraQuat,
      zoomActive,
      context.style,
    );
    this.rcsEffects.sync(
      context.floatingOrigin,
      effectState.r,
      motion.torque,
      motion.att,
      effectVisible,
      cameraQuat,
      zoomActive,
    );
    this.reentryEffects.sync(
      context.floatingOrigin,
      effectState.r,
      effectState.v,
      motion.aero.qdyn,
      effectVisible,
      cameraQuat,
    );
    // 船体に属する可動部と、操作対象だけの DOM マーカーを外部状態へ合わせる。
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
    if (active && zoomActive) this.object.visible = false;
  }

  // 自機固有の子表示を片付けてから、共通 View の THREE 資源を破棄する。
  public override dispose(): void {
    this.markers.dispose();
    this.boosters.dispose();
    this.thrustEffects.dispose(this.scene!);
    this.rcsEffects.dispose(this.scene!);
    this.reentryEffects.dispose(this.scene!);
    super.dispose();
  }
}
