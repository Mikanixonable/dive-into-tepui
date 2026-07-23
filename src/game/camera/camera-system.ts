import * as THREE from 'three/webgpu';
import { Vec3 } from '../../physics/vec3';
import { Hud } from '../../hud/hud';
import { Sfx } from '../../audio/sfx';
import { ChaseCamera } from './chase-camera';
import { MapCamera } from './map-camera';
import { Input } from '../input';
import { Player } from '../player/player';
import type { MapMarkers } from '../map-mode/map-markers';

const tmpV = new THREE.Vector3();

export type ProjectFn = (rel: Vec3) => { x: number; y: number; front: boolean; };

// 戦闘ビュー(ChaseCamera)とマップビュー(MapCamera)を切り替えて駆動する。
// どちらも視点操作のみの責務のカメラで、このクラスが対称に内部保持する。
export class CameraSystem {
  readonly chaseCamera: ChaseCamera;
  readonly mapCamera: MapCamera;
  mapMode = false;
  zoomActive = false;

  constructor(hud: Hud, sfx: Sfx, mapMarkers: MapMarkers) {
    this.chaseCamera = new ChaseCamera(hud, sfx);
    this.mapCamera = new MapCamera(hud, sfx, mapMarkers);
  }

  get activeCamera(): THREE.PerspectiveCamera {
    return this.mapMode ? this.mapCamera.camera : this.chaseCamera.camera;
  }

  update(
    player: Player,
    sunAz: number,
    input: Input,
    dt: number,
    origin: Vec3,
  ): void {
    this.zoomActive = !this.mapMode && input.down('KeyZ');

    const keyYaw = (input.down('ArrowLeft') ? 1 : 0) + (input.down('ArrowRight') ? -1 : 0);
    const keyPitch = (input.down('ArrowDown') ? 1 : 0) + (input.down('ArrowUp') ? -1 : 0);
    const mouse = input.mouse();

    if (this.mapMode) {
      this.mapCamera.update(mouse, keyYaw, keyPitch, dt, origin, sunAz);
    }
    else {
      this.chaseCamera.update(mouse, keyYaw, keyPitch, dt, origin, player, this.zoomActive);
    }
  }


  get activeCameraProjection(): ProjectFn {
    return (rel: Vec3) => {
      const cam = this.activeCamera;

      tmpV.set(rel.x, rel.y, rel.z).applyMatrix4(cam.matrixWorldInverse);
      const front = tmpV.z < 0;
      tmpV.applyMatrix4(cam.projectionMatrix);
      return {
        x: (tmpV.x * 0.5 + 0.5) * window.innerWidth,
        y: (-tmpV.y * 0.5 + 0.5) * window.innerHeight,
        front,
      };
    };
  }
}