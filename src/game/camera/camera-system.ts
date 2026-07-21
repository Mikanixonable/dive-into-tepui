import * as THREE from 'three/webgpu';
import { Vec3 } from '../../physics/vec3';
import { Hud } from '../../hud/hud';
import { Sfx } from '../../audio/sfx';
import { ChaseCamera } from './chase-camera';
import { MapCamera } from './map-camera';
import { Input } from '../input';
import { Player } from '../player/player';

export interface CameraUpdateCtx {
  zoomActive: boolean;
  player: Player;
  sunAz: number;
  focusRel: Vec3; // MapCamera の注視点(origin 相対)。解決は map-mode-system.ts の責務。
  input: Input;
  dt: number;
  origin: Vec3;
}

// 戦闘ビュー(ChaseCamera)とマップビュー(MapCamera)を切り替えて駆動する。
// どちらも視点操作のみの責務のカメラで、このクラスが対称に内部保持する。
// マップモードの有無・ラベル一覧など、カメラ外の状態は ctx 経由で受け取る。
export class CameraSystem {
  readonly chaseCamera: ChaseCamera;
  readonly mapCamera: MapCamera;
  mapMode = false;
  zoomActive = false;

  constructor(hud: Hud, sfx: Sfx) {
    this.chaseCamera = new ChaseCamera(hud, sfx);
    this.mapCamera = new MapCamera(hud, sfx);
  }

  get activeCamera(): THREE.PerspectiveCamera {
    return this.mapMode ? this.mapCamera.camera : this.chaseCamera.camera;
  }

  updateActiveCamera(ctx: CameraUpdateCtx): THREE.PerspectiveCamera {
    const keyYaw = (ctx.input.down('ArrowLeft') ? 1 : 0) + (ctx.input.down('ArrowRight') ? -1 : 0);
    const keyPitch = (ctx.input.down('ArrowDown') ? 1 : 0) + (ctx.input.down('ArrowUp') ? -1 : 0);
    const mouse = ctx.input.mouse();

    if (this.mapMode) {
      this.mapCamera.update(mouse, keyYaw, keyPitch, ctx.dt, ctx.focusRel, ctx.sunAz);
      return this.mapCamera.camera;
    }
    this.chaseCamera.update(mouse, keyYaw, keyPitch, ctx.dt, ctx.origin, ctx.player, this.zoomActive);
    return this.chaseCamera.camera;
  }
}
