// 透視/平行の THREE カメラ実体を所有し、論理視点をそのフレームの表示値へ確定する。
// 投影行列・近遠クリップ面・描画原点は、1回の sync が作る CameraFrame にまとまる。
import * as THREE from 'three/webgpu';
import { CELESTIAL_SHELL_RADIUS } from '../stars';
import { FloatingOrigin } from './floating-origin';
import { len, sub, Vec3 } from '../../math/vec3';
import {
  metersPerPixel, metersPerPixelAtDistance, screenProjection, Viewpoint,
} from '../../math/projection';
import type { CameraFrame } from './camera-frame';
import type { ViewMode } from '../view-mode';
import type { Viewport } from '../viewport';

// 近クリップ距離 = 注視距離 / NEAR_RATIO。比を大きくするほど手前がクリップされにくい。
// 反転 32bit 深度では分解能が near に依らないので、大きくしても深度精度は落ちない。
const NEAR_RATIO = 1000;

// 注視距離が大きいと near が星球シェル半径 R を超える(dist=1e14 で near=1e11)。near 面は光軸から
// θ の点を R·cosθ まで切り詰めるので、上限は R でなく画面対角の半視野角での R·cosθ_diag に取る
// (R で抑えると周辺・四隅の星が消える)。これはその余弦に掛ける 1 未満の安全マージン。
const NEAR_SHELL_MARGIN = 0.9;

// 遠クリップ距離の注視距離に対する比。引いたカメラでも太陽・木星のような遠方天体を far の内に
// 収める。反転 32bit 深度では far を大きく取る費用は事実上ゼロ。
const FAR_RATIO = 100;

// 艦至近(dist = ENTITY_MIN_DIST)まで寄っても、見かけ直径が残る最遠の天体
// (直径 1.4e9 m の恒星を LOD 上限で見た 1.4e12 m)が far の外に出ないための下限。
const FAR_MIN = 2e12;

// 注視距離の上限 × FAR_RATIO。これより小さいと、最大ズームアウト付近で注視点より奥の
// 軌道線・天体が far 平面で切れる。
const FAR_MAX = 1e16;

// 平行投影の半画面高さ [m] の下限。0 では投影行列が退化する。
const ORTHOGRAPHIC_HALF_HEIGHT_MIN = 1e-3;

// 近クリップ距離 [m]。どのズーム段でも注視点を切り落とさず、星球シェル・天球グリッドを
// 画面の四隅まで残す値を返す。
function nearClip(clipFovDeg: number, clipDistance: number, viewport: Viewport): number {
  const halfV = THREE.MathUtils.degToRad(clipFovDeg * 0.5);
  const halfH = Math.atan(Math.tan(halfV) * viewport.width / viewport.height);
  const halfDiag = Math.atan(Math.hypot(Math.tan(halfV), Math.tan(halfH)));
  const nearMax = CELESTIAL_SHELL_RADIUS * Math.cos(halfDiag) * NEAR_SHELL_MARGIN;
  return Math.min(nearMax, clipDistance / NEAR_RATIO);
}

// 遠クリップ距離 [m]。引いたカメラでも、遠方天体と注視点より奥の軌道線を far の内に収める。
function farClip(clipDistance: number): number {
  return Math.min(FAR_MAX, Math.max(FAR_MIN, clipDistance * FAR_RATIO));
}

// 論理カメラの状態(Viewpoint)を、描画原点 origin を差し引いて THREE カメラへ反映する。
function syncCameraToViewpoint(
  camera: THREE.Camera, view: Viewpoint, near: number, far: number, origin: Vec3,
): void {
  const position = sub(view.position, origin);
  const lookTarget = sub(view.lookTarget, origin);
  camera.position.set(position.x, position.y, position.z);
  camera.up.set(view.up.x, view.up.y, view.up.z);
  camera.lookAt(lookTarget.x, lookTarget.y, lookTarget.z);
  // アスペクト比・FOV・near・far が変わったときだけ投影行列を再計算する
  let projectionDirty = false;
  if (camera instanceof THREE.PerspectiveCamera) {
    if (Math.abs(camera.aspect - view.aspect) > 1e-6) {
      camera.aspect = view.aspect;
      projectionDirty = true;
    }
    if (Math.abs(camera.fov - view.fovDeg) > 1e-3) {
      camera.fov = view.fovDeg;
      projectionDirty = true;
    }
    if (Math.abs(camera.near - near) > near * 1e-6) {
      camera.near = near;
      projectionDirty = true;
    }
    if (Math.abs(camera.far - far) > far * 1e-6) {
      camera.far = far;
      projectionDirty = true;
    }
  } else if (camera instanceof THREE.OrthographicCamera) {
    const halfHeight = Math.max(ORTHOGRAPHIC_HALF_HEIGHT_MIN, view.orthographicHalfHeight ?? 1);
    const halfWidth = halfHeight * view.aspect;
    if (Math.abs(camera.left + halfWidth) > halfWidth * 1e-6
      || Math.abs(camera.right - halfWidth) > halfWidth * 1e-6
      || Math.abs(camera.top - halfHeight) > halfHeight * 1e-6
      || Math.abs(camera.bottom + halfHeight) > halfHeight * 1e-6) {
      camera.left = -halfWidth;
      camera.right = halfWidth;
      camera.top = halfHeight;
      camera.bottom = -halfHeight;
      projectionDirty = true;
    }
    if (Math.abs(camera.near - near) > near * 1e-6) {
      camera.near = near;
      projectionDirty = true;
    }
    if (Math.abs(camera.far - far) > far * 1e-6) {
      camera.far = far;
      projectionDirty = true;
    }
  }
  if (projectionDirty && (camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera)) {
    camera.updateProjectionMatrix();
  }
  camera.updateMatrixWorld();
}

export class CameraView {
  // 透視/平行の THREE カメラ実体。どちらを描画に使うかは視点の投影方式で決まる。
  private readonly perspectiveCamera = new THREE.PerspectiveCamera();
  private readonly orthographicCamera = new THREE.OrthographicCamera();

  // 論理視点をこのフレームの表示値へ確定して返す。clipFovDeg/clipDistance は近遠クリップ面を
  // 決める軌道視点の画角[deg]と注視距離[m]、focusVelocity は描画原点の速度基準になる ECI 速度。
  public sync(
    viewpoint: Viewpoint,
    clipFovDeg: number,
    clipDistance: number,
    viewport: Viewport,
    mode: ViewMode,
    zoomed: boolean,
    focusVelocity: Vec3,
  ): CameraFrame {
    // TODO: 照準ズーム中は表示視点の画角が絞られるのに、近遠クリップ面は軌道視点の画角と
    // 注視距離が決める。明言された仕様に基づくものではない。
    const near = nearClip(clipFovDeg, clipDistance, viewport);
    const far = farClip(clipDistance);
    // 描画原点をカメラの ECI 位置に揃えないと、遠方の描画対象が f32 の桁落ちで振動する。
    const position = viewpoint.position;
    const camera = viewpoint.projection === 'orthographic' ? this.orthographicCamera : this.perspectiveCamera;
    syncCameraToViewpoint(camera, viewpoint, near, far, position);
    return {
      camera,
      position,
      viewpoint,
      viewport,
      mode,
      zoomed,
      floatingOrigin: new FloatingOrigin(position, focusVelocity),
      project: screenProjection(viewpoint, viewport.width, viewport.height),
      scale: (worldPos) => metersPerPixel(viewpoint, worldPos, viewport.height),
      radialScale: (worldPos) => metersPerPixelAtDistance(
        viewpoint, len(sub(worldPos, viewpoint.position)), viewport.height),
    };
  }
}
