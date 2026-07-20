import * as THREE from 'three/webgpu';
import { qRotate } from '../../physics/attitude';
import { Vec3, norm, v3 } from '../../physics/vec3';
import * as C from '../const';
import { ChaseCamera } from '../camera/chase-camera';
import { MouseDelta } from '../input';
import { MapModeSystem } from '../map-mode/map-mode-system';
import { Player } from '../player/player';

export interface CameraUpdateCtx {
  zoomActive: boolean;
  player: Player;
  maneuver: MapModeSystem;
  chase: ChaseCamera;
  mouse: MouseDelta;
  keyYaw: number;
  keyPitch: number;
  dt: number;
  origin: Vec3;
  playerVelocity: Vec3;
}

export class CameraSystem {

  activeCamera(maneuver: MapModeSystem, chase: ChaseCamera): THREE.PerspectiveCamera {
    return maneuver.mapMode ? maneuver.camera : chase.camera;
  }

  updateActiveCamera(ctx: CameraUpdateCtx): THREE.PerspectiveCamera {
    if (ctx.maneuver.mapMode) {
      ctx.maneuver.updateCamera(ctx.mouse, ctx.keyYaw, ctx.keyPitch, ctx.dt);
      return ctx.maneuver.camera;
    }
    this.updateCombatCamera(ctx);
    return ctx.chase.camera;
  }

  private updateCombatCamera(ctx: CameraUpdateCtx): void {
    if (!ctx.zoomActive) {
      ctx.chase.yaw -= ctx.keyYaw * C.CAM_KEY_YAW_RATE * ctx.dt;
      ctx.chase.pitch = Math.max(
        -1.35,
        Math.min(1.35, ctx.chase.pitch + ctx.keyPitch * C.CAM_KEY_PITCH_RATE * ctx.dt),
      );
    }
    const boreFwd = ctx.player.alive ? qRotate(ctx.player.att.q, v3(0, 0, 1)) : null;
    const boreUp = ctx.player.alive ? qRotate(ctx.player.att.q, v3(0, 1, 0)) : null;
    const useAttitudeFrame = ctx.chase.camFollowAttitude && ctx.player.alive && boreFwd && boreUp;
    const camFwd = useAttitudeFrame ? boreFwd! : norm(ctx.playerVelocity);
    const camUp = useAttitudeFrame ? boreUp! : norm(ctx.origin);
    ctx.chase.update(ctx.mouse, camUp, camFwd, ctx.zoomActive, ctx.dt, boreFwd, boreUp);
    ctx.chase.camera.updateMatrixWorld();
  }
}
