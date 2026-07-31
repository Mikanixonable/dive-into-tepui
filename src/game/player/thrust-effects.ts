// マヌーバ噴射プルーム: 推力方向の逆側に置く発光ビルボード 2 枚(コア+アウター)。
import * as THREE from 'three/webgpu';
import { Vec3, addScaled } from '../../physics/vec3';
import { Billboard } from '../../render/billboard';
import type { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';

export class ThrustEffects {
  private readonly core = new Billboard(0xaee6ff);
  private readonly outer = new Billboard(0x4f9fff);

  constructor(scene: THREE.Scene) {
    scene.add(this.core.mesh);
    scene.add(this.outer.mesh);
  }

  sync(fo: FloatingOrigin, playerPos: Vec3, dir: Vec3 | null, throttleIdx: number, alive: boolean, camera: CameraSystem): void {
    const show = dir !== null && alive && !camera.zoomActive;
    if (!show) {
      this.core.hide();
      this.outer.hide();
      return;
    }
    const d = dir!;
    const flick = 0.8 + 0.2 * Math.random();
    const sc = (1.5 + 2.5 * (throttleIdx / 3.0)) * flick;
    const camQuat = camera.activeCamera.quaternion;
    this.core.sync(fo.RtoThreeV3(addScaled(playerPos, d, -3.4)), sc * 1.6, 0.85 * flick, camQuat);
    this.outer.sync(fo.RtoThreeV3(addScaled(playerPos, d, -5.6)), sc * 3.6, 0.32 * flick, camQuat);
  }
}
