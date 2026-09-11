// THREE.Camera から、ある点における画面 1 px 相当の実距離 [m] を求める。
import * as THREE from 'three/webgpu';
import { metersPerPixelFromTanHalfFov, MIN_DEPTH } from '../math/projection';

// PerspectiveCamera でも OrthographicCamera でもないカメラに使う垂直画角 [deg]。
const FALLBACK_FOV_DEG = 50;

export class CameraScale {
  // ワールド空間でのカメラの前方向と視点位置。
  private readonly forward = new THREE.Vector3();
  public readonly position = new THREE.Vector3();

  private readonly tanHalfFov: number;
  private readonly orthoHalfHeight: number;
  private readonly near: number;
  private readonly viewportHeight: number;

  // camera の姿勢と画角をこの時点の値で固定する。camera が動いたら作り直す。
  // viewportHeight は描画先の高さ [CSS px]。
  public constructor(camera: THREE.Camera, viewportHeight: number) {
    camera.getWorldDirection(this.forward);
    this.position.setFromMatrixPosition(camera.matrixWorld);
    this.viewportHeight = Math.max(1, viewportHeight);
    // 平行投影は半高さ、透視は画角から尺度を決める。どちらでもなければ既定の画角の透視とみなす。
    if (camera instanceof THREE.OrthographicCamera) {
      this.tanHalfFov = 0;
      this.orthoHalfHeight = (camera.top - camera.bottom) * 0.5;
      this.near = camera.near;
    } else if (camera instanceof THREE.PerspectiveCamera) {
      this.tanHalfFov = Math.tan((camera.fov * Math.PI) / 360);
      this.orthoHalfHeight = 0;
      this.near = camera.near;
    } else {
      this.tanHalfFov = Math.tan((FALLBACK_FOV_DEG * Math.PI) / 360);
      this.orthoHalfHeight = 0;
      this.near = MIN_DEPTH;
    }
  }

  // 視点から前方へ奥行き depth [m] の点における m/px。平行投影では depth によらない。
  public atDepth(depth: number): number {
    if (this.orthoHalfHeight > 0) return (2 * this.orthoHalfHeight) / this.viewportHeight;
    return metersPerPixelFromTanHalfFov(this.tanHalfFov, depth, this.viewportHeight);
  }

  // ワールド座標 (x,y,z) の点における m/px。近クリップより手前・背後の点はカメラからの距離で測る。
  public at(x: number, y: number, z: number): number {
    const dx = x - this.position.x, dy = y - this.position.y, dz = z - this.position.z;
    const depth = dx * this.forward.x + dy * this.forward.y + dz * this.forward.z;
    if (depth >= this.near) return this.atDepth(depth);
    // 奥行きで測ると背後の点の尺度が下限まで潰れ、画面上の判定を常に外す。
    return this.atDepth(Math.max(this.near, Math.sqrt(dx * dx + dy * dy + dz * dz)));
  }
}
