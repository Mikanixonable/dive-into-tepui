import * as THREE from 'three/webgpu';
import { Vec3 } from '../../physics/vec3';
import { Hud } from '../../hud/hud';
import { ChaseCamera } from './chase-camera';
import { MapCamera } from './map-camera';
import { MouseDelta } from '../input';
import { Player } from '../player/player';

export interface CameraUpdateCtx {
  zoomActive: boolean;
  player: Player;
  mapMode: boolean;
  sunAz: number;
  focusRel: Vec3; // MapCamera の注視点(origin 相対)。解決は map-mode-system.ts の責務。
  mouse: MouseDelta;
  keyYaw: number;
  keyPitch: number;
  dt: number;
  origin: Vec3;
  playerVelocity: Vec3;
}

// 戦闘ビュー(ChaseCamera)とマップビュー(MapCamera)を切り替えて駆動する。
// どちらも視点操作のみの責務のカメラで、このクラスが対称に内部保持する
// (マップモードの有無・ラベル一覧など、カメラ外の状態は ctx 経由で受け取るだけで、
// map-mode-system.ts を import しない)。
export class CameraSystem {
  readonly chaseCamera = new ChaseCamera();
  readonly mapCamera: MapCamera;

  constructor(hud: Hud) {
    this.mapCamera = new MapCamera(hud);
  }

  activeCamera(mapMode: boolean): THREE.PerspectiveCamera {
    return mapMode ? this.mapCamera.camera : this.chaseCamera.camera;
  }

  updateActiveCamera(ctx: CameraUpdateCtx): THREE.PerspectiveCamera {
    if (ctx.mapMode) {
      this.mapCamera.update(ctx.mouse, ctx.keyYaw, ctx.keyPitch, ctx.dt, ctx.focusRel, ctx.sunAz);
      return this.mapCamera.camera;
    }
    this.chaseCamera.update(ctx);
    return this.chaseCamera.camera;
  }
}
