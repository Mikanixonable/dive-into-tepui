// そのフレームの表示に使うカメラの確定値。1フレームに1つ作り、フレーム内では変わらない。
import type * as THREE from 'three/webgpu';
import type { ProjectFn, ScaleFn, Viewpoint } from '../../math/projection';
import type { Vec3 } from '../../math/vec3';
import type { FloatingOrigin } from './floating-origin';
import type { ViewMode } from '../view-mode';
import type { Viewport } from '../viewport';

export interface CameraFrame {
  readonly camera: THREE.Camera; // 描画に使う THREE カメラ
  readonly position: Vec3; // カメラの ECI 位置。描画原点でもある
  readonly viewpoint: Viewpoint; // 投影の基底になる論理視点
  readonly viewport: Viewport;
  readonly mode: ViewMode;
  readonly zoomed: boolean; // 照準ズーム中か
  readonly floatingOrigin: FloatingOrigin;
  readonly project: ProjectFn;
  // 画面1ピクセル相当の実距離 [m] を、視線方向の深度で測って答える。
  readonly scale: ScaleFn;
  // 同じ尺度を、視点からの直線距離で測って答える。画面外(視点の背後を含む)の物体の見かけの
  // 大きさはこちらで測る — scale は視点の背後で床打ちされる。
  readonly radialScale: ScaleFn;
}
