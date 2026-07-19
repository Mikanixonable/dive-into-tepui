// 自機を画面中心に置く三人称軌道カメラ。
// 基準フレームは「上 = 動径方向(地球と反対)、前 = 速度方向」で、
// 軌道運動とともにゆっくり共回転するため地球が常に足元に見える。
import * as THREE from 'three/webgpu';
import { Vec3 } from '../physics/vec3';
import { MouseDelta } from './input';
import * as C from './const';

export class ChaseCamera {
  yaw = 0; // 0 = 機体後方(プログレード側から見る)
  pitch = 0.3 - (10 * Math.PI) / 180; // 初期カメラ位置を5度低く
  dist = 38;
  private fov = C.BASE_FOV;

  private readonly upV = new THREE.Vector3();
  private readonly fwdV = new THREE.Vector3();
  private readonly sideV = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();

  update(
    camera: THREE.PerspectiveCamera,
    mouse: MouseDelta,
    up: Vec3,
    fwd: Vec3,
    zoomActive: boolean,
    dt: number,
    boreFwd: Vec3 | null,
    boreUp: Vec3 | null,
  ): void {
    const targetFov = zoomActive ? C.ZOOM_FOV : C.BASE_FOV;
    const k = 1 - Math.exp(-C.ZOOM_LERP_RATE * dt);
    this.fov += (targetFov - this.fov) * k;
    if (Math.abs(this.fov - camera.fov) > 1e-3) {
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
    }

    // 照準ズーム中: 三人称視点をやめ、機体位置(原点)から機首方向を狙う
    // 固定ガンサイト視点にする(画面中心 = 照準先、自機は呼び出し側で非表示にする)。
    // 姿勢操作(I/K/J/L)で狙いを付ける設計のため、マウスでの視点回転は行わない。
    if (zoomActive && boreFwd && boreUp) {
      this.fwdV.set(boreFwd.x, boreFwd.y, boreFwd.z).normalize();
      this.upV.set(boreUp.x, boreUp.y, boreUp.z).normalize();
      camera.position.set(0, 0, 0);
      camera.up.copy(this.upV);
      camera.lookAt(this.fwdV.x * 1000, this.fwdV.y * 1000, this.fwdV.z * 1000);
      return;
    }

    this.yaw -= mouse.dx * 0.005;
    this.pitch += mouse.dy * 0.005;
    this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch));
    this.dist *= Math.exp(mouse.wheel * 0.0012);
    this.dist = Math.max(12, Math.min(8000, this.dist));

    this.upV.set(up.x, up.y, up.z);
    this.fwdV.set(fwd.x, fwd.y, fwd.z);
    // 前方向を上方向と直交化
    this.fwdV.addScaledVector(this.upV, -this.fwdV.dot(this.upV)).normalize();
    this.sideV.crossVectors(this.fwdV, this.upV).normalize();

    const cp = Math.cos(this.pitch);
    this.offset
      .set(0, 0, 0)
      .addScaledVector(this.fwdV, -cp * Math.cos(this.yaw))
      .addScaledVector(this.sideV, cp * Math.sin(this.yaw))
      .addScaledVector(this.upV, Math.sin(this.pitch))
      .multiplyScalar(this.dist);

    camera.position.copy(this.offset);
    camera.up.copy(this.upV);
    camera.lookAt(0, 0, 0);
  }
}
