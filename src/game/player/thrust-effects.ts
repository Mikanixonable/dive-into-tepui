// マヌーバ噴射プルーム: 推力方向の逆側に置く発光ビルボード 2 枚(コア+アウター)。
import * as THREE from 'three/webgpu';
import { Vec3, addScaled } from '../../physics/vec3';
import { Billboard } from '../../render/billboard';
import type { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';

export class ThrustEffects {
  private readonly core = new Billboard(0xaee6ff);
  private readonly outer = new Billboard(0x4f9fff);

  // core/outer ビルボードを scene に登録する。
  constructor(scene: THREE.Scene) {
    scene.add(this.core.mesh);
    scene.add(this.outer.mesh);
  }

  // 噴射プルームの表示を dir(推力方向、非噴射時は null)に合わせて同期する。
  // ズームガンサイト表示中や自機死亡時は隠す。
  sync(fo: FloatingOrigin, playerPos: Vec3, dir: Vec3 | null, throttleIdx: number, alive: boolean, camera: CameraSystem): void {
    const show = dir !== null && alive && !camera.zoomActive;
    if (!show) {
      this.core.hide();
      this.outer.hide();
      return;
    }
    const d = dir!;
    // 揺らぎとスロットル段階からサイズを決める
    const flick = 0.8 + 0.2 * Math.random();
    const sc = (1.5 + 2.5 * (throttleIdx / 3.0)) * flick;
    const camQuat = camera.activeCamera.quaternion;
    // 推力方向の逆側にコア・アウターを置く
    this.core.sync(fo.RtoThreeV3(addScaled(playerPos, d, -3.4)), sc * 1.6, 0.85 * flick, camQuat);
    this.outer.sync(fo.RtoThreeV3(addScaled(playerPos, d, -5.6)), sc * 3.6, 0.32 * flick, camQuat);
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.core.mesh, this.outer.mesh);
    this.core.dispose();
    this.outer.dispose();
  }
}
