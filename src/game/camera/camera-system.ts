import * as THREE from 'three/webgpu';
import { Vec3 } from '../../physics/vec3';
import { Hud } from '../../hud/hud';
import { Sfx } from '../../audio/sfx';
import { ChaseCamera } from './chase-camera';
import { MapCamera } from './map-camera';
import { Input } from '../input';
import { Player } from '../player/player';

// 戦闘ビュー(ChaseCamera)とマップビュー(MapCamera)を切り替えて駆動する。
// どちらも視点操作のみの責務のカメラで、このクラスが対称に内部保持する。
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

  updateActiveCamera(
    player: Player,
    sunAz: number,
    focusRel: Vec3, // MapCamera の注視点(origin 相対)。解決は map-mode-system.ts の責務。
    input: Input,
    dt: number,
    origin: Vec3,
  ): void {
    const keyYaw = (input.down('ArrowLeft') ? 1 : 0) + (input.down('ArrowRight') ? -1 : 0);
    const keyPitch = (input.down('ArrowDown') ? 1 : 0) + (input.down('ArrowUp') ? -1 : 0);
    const mouse = input.mouse();

    if (this.mapMode) {
      this.mapCamera.update(mouse, keyYaw, keyPitch, dt, focusRel, sunAz);
    }
    else {
      this.chaseCamera.update(mouse, keyYaw, keyPitch, dt, origin, player, this.zoomActive);
    }
  }
}
