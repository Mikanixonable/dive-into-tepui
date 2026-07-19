import * as THREE from 'three/webgpu';
import { qRotate } from '../../physics/attitude';
import { sunAzimuth } from '../../physics/ephemeris';
import { Vec3, len, norm, scale, v3 } from '../../physics/vec3';
import * as C from '../const';
import { ChaseCamera } from '../camera/chase-camera';
import { MouseDelta } from '../input';
import { MapView } from '../map-mode/mapview';
import { Player } from '../player/player';

export interface CameraUpdateCtx {
  mapMode: boolean;
  zoomActive: boolean;
  simTime: number;
  sunPhase0: number;
  player: Player;
  mapView: MapView;
  chase: ChaseCamera;
  camera: THREE.PerspectiveCamera;
  mouse: MouseDelta;
  keyYaw: number;
  keyPitch: number;
  dt: number;
  origin: Vec3;
  playerVelocity: Vec3;
}

export class CameraSystem {
  updateActiveCamera(ctx: CameraUpdateCtx): THREE.PerspectiveCamera {
    if (ctx.mapMode) {
      this.updateMapCamera(ctx);
      return ctx.mapView.camera;
    }
    this.updateCombatCamera(ctx);
    return ctx.camera;
  }

  private updateMapCamera(ctx: CameraUpdateCtx): void {
    const sunAz = sunAzimuth(ctx.simTime, ctx.sunPhase0);
    ctx.mapView.updateCamera(ctx.mouse, ctx.keyYaw, ctx.keyPitch, ctx.dt, ctx.origin, sunAz);
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
    ctx.chase.update(ctx.camera, ctx.mouse, camUp, camFwd, ctx.zoomActive, ctx.dt, boreFwd, boreUp);
    ctx.camera.updateMatrixWorld();
  }

  placeCombatMoon(moonMesh: THREE.Mesh, cam: THREE.PerspectiveCamera, moonRel: Vec3, moonRadius: number, moonVisDist: number): void {
    const moonDist = len(moonRel);
    const md = scale(moonRel, 1 / moonDist);
    moonMesh.position.set(
      cam.position.x + md.x * moonVisDist,
      cam.position.y + md.y * moonVisDist,
      cam.position.z + md.z * moonVisDist,
    );
    moonMesh.scale.setScalar(moonVisDist * (moonRadius / moonDist));
  }
}
