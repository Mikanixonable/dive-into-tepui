// マヌーバ噴射プルーム: 推力方向の逆側に置く発光ビルボード 2 枚(コア+アウター)。
import * as THREE from 'three/webgpu';
import { Vec3 } from '../../physics/vec3';
import { Billboard } from '../../render/billboard';
import type { CameraSystem } from '../camera/camera-system';

export class ThrustEffects {
  private readonly core = new Billboard(0xaee6ff);
  private readonly outer = new Billboard(0x4f9fff);

  constructor(scene: THREE.Scene) {
    scene.add(this.core.mesh);
    scene.add(this.outer.mesh);
  }

  sync(dir: Vec3 | null, throttleIdx: number, alive: boolean, camera: CameraSystem): void {
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
    this.core.sync({ x: -d.x * 3.4, y: -d.y * 3.4, z: -d.z * 3.4 }, sc * 1.6, 0.85 * flick, camQuat);
    this.outer.sync({ x: -d.x * 5.6, y: -d.y * 5.6, z: -d.z * 5.6 }, sc * 3.6, 0.32 * flick, camQuat);
  }
}
