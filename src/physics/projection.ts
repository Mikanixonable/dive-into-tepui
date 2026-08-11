// ピンホールカメラ投影(Vec3 → NDC → ピクセル)。直交座標から射影座標への幾何変換であって
// 見た目の調整値を含まないので、`physics/` に属する。THREE.js の PerspectiveCamera や
// フローティングオリジンに依存せず、カメラの絶対 ECI 視点状態と対象の絶対 ECI 位置
// だけから完結する。THREE.Object3D.lookAt / PerspectiveCamera と同じ基底構築・
// 透視除算の数式を踏襲しており、fov は垂直画角 [deg]。
import { Vec3, cross, dot, norm, sub } from './vec3';

export type Projected = { x: number; y: number; front: boolean };

export interface Viewpoint {
  position: Vec3; // 視点の絶対 ECI 位置
  lookTarget: Vec3; // 注視点の絶対 ECI 位置(forward = normalize(lookTarget - position))
  up: Vec3; // 上方向のヒント(forward と直交している必要はない — lookAt と同様に再直交化する)
  fovDeg: number; // 垂直画角
  aspect: number; // width / height
}

// worldPos を NDC([-1,1] 、+Y が上)へ投影する。front = カメラの前方(near/far 非依存)。
export function projectToNdc(view: Viewpoint, worldPos: Vec3): Projected {
  // up を再直交化してカメラ基底(forward/right/camUp)を組む
  const forward = norm(sub(view.lookTarget, view.position));
  const right = norm(cross(forward, view.up));
  const camUp = cross(right, forward);

  // カメラ視点座標系へ変換
  const rel = sub(worldPos, view.position);
  const viewX = dot(rel, right);
  const viewY = dot(rel, camUp);
  const viewZ = -dot(rel, forward);
  const front = viewZ < 0;

  // 透視除算で NDC へ
  const tanHalfFov = Math.tan((view.fovDeg * Math.PI) / 360);
  const ndcX = viewX / (view.aspect * tanHalfFov * -viewZ);
  const ndcY = viewY / (tanHalfFov * -viewZ);
  return { x: ndcX, y: ndcY, front };
}

// NDC を width×height のピクセル矩形(左上 = offsetX,offsetY)へ写像する。
export function ndcToScreen(ndc: Projected, width: number, height: number, offsetX = 0, offsetY = 0): Projected {
  return {
    x: offsetX + (ndc.x * 0.5 + 0.5) * width,
    y: offsetY + (-ndc.y * 0.5 + 0.5) * height,
    front: ndc.front,
  };
}

// depth の下限。視点上・視点の背後の点で 0 や負の尺度を返さないための床。
export const MIN_DEPTH = 1e-6;

// 垂直画角の半分の tan を既に持っている呼び出し側(同じカメラで多数回評価する適応分割等)が
// 三角関数を再計算せずに呼べる下位関数。
export function metersPerPixelFromTanHalfFov(tanHalfFov: number, depth: number, viewportHeight: number): number {
  return (2 * Math.max(MIN_DEPTH, depth) * tanHalfFov) / viewportHeight;
}

// 垂直画角 fovDeg のピンホールカメラで、視点から depth 離れた点における画面1ピクセル
// 相当の実距離 [m]。注視点までの距離を既に持っているカメラ実装(注視点固定のオービット
// カメラ等)はこれを直接呼べる — worldPos/position の差分から改めて depth を導く必要がない。
export function metersPerPixelAtDepth(fovDeg: number, depth: number, viewportHeight: number): number {
  return metersPerPixelFromTanHalfFov(Math.tan((fovDeg * Math.PI) / 360), depth, viewportHeight);
}

// worldPos の位置における画面1ピクセル相当の実距離 [m]。画面上で一定に見せたい長さに
// 掛けると、その位置での実距離が得られる。
export function metersPerPixel(view: Viewpoint, worldPos: Vec3, viewportHeight: number): number {
  const forward = norm(sub(view.lookTarget, view.position));
  const depth = dot(sub(worldPos, view.position), forward);
  return metersPerPixelAtDepth(view.fovDeg, depth, viewportHeight);
}
