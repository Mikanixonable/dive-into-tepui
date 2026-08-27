// THREE.Camera から「その点における画面1ピクセル相当の実距離 [m]」を求める。カメラの基底と
// 画角換算値は構築時に1度だけ取り出すので、同じカメラで多数の点を評価するなら1つ作って
// 使い回す。
import * as THREE from 'three/webgpu';
import { metersPerPixelFromTanHalfFov, MIN_DEPTH } from '../physics/projection';

// PerspectiveCamera でも OrthographicCamera でもないカメラに使う垂直画角 [deg]。
const FALLBACK_FOV_DEG = 50;

export class CameraScale {
  // ワールド空間でのカメラの前方向と視点位置。
  readonly forward = new THREE.Vector3();
  readonly position = new THREE.Vector3();

  private readonly tanHalfFov: number;
  private readonly orthoHalfHeight: number;
  private readonly near: number;
  private readonly viewportHeight: number;

  // カメラの姿勢と画角換算値をこの時点の値で読み取る。以降 camera は参照しない。
  constructor(camera: THREE.Camera) {
    camera.getWorldDirection(this.forward);
    this.position.setFromMatrixPosition(camera.matrixWorld);
    this.viewportHeight = Math.max(1, window.innerHeight);
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

  // 視点から前方へ depth [m] 離れた点における m/px。注視点までの距離を既に持っている
  // 呼び出し側は、点を渡さずこちらを直接呼べる。
  atDepth(depth: number): number {
    if (this.orthoHalfHeight > 0) return (2 * this.orthoHalfHeight) / this.viewportHeight;
    return metersPerPixelFromTanHalfFov(this.tanHalfFov, depth, this.viewportHeight);
  }

  // ワールド座標 (x,y,z) の点における m/px。視点より手前の点は画面上のどこにも映らないので、
  // 前方奥行きではなくカメラからの距離を尺度にする — そうしないと尺度が下限まで潰れ、背後へ
  // 回り込んだ点だけが画面上の判定を常に外してしまう。
  at(x: number, y: number, z: number): number {
    const dx = x - this.position.x, dy = y - this.position.y, dz = z - this.position.z;
    const depth = dx * this.forward.x + dy * this.forward.y + dz * this.forward.z;
    if (depth >= this.near) return this.atDepth(depth);
    return this.atDepth(Math.max(this.near, Math.sqrt(dx * dx + dy * dy + dz * dz)));
  }
}
