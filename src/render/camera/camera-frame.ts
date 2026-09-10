// そのフレームの表示に使うカメラの確定値。CameraView.sync が1回で作り、以降の表示同期は
// すべて同じ値を読む。
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
  // 同じ尺度を、視点からの直線距離で測って答える。画面に写らない位置にある物体の見かけの
  // 大きさを測るのはこちら — 深度で測る側は視点の背後で床打ちされ、遠く後方にある物体が
  // 目の前にあるのと同じ尺度を返す。
  readonly radialScale: ScaleFn;
}
