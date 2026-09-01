// ピンホールカメラ投影(Vec3 → NDC → ピクセル)。直交座標から射影座標への幾何変換であって
// 見た目の調整値も物理量も含まないので、`math/` に属する。THREE.js の PerspectiveCamera や
// フローティングオリジンに依存せず、カメラの絶対 ECI 視点状態と対象の絶対 ECI 位置
// だけから完結する。THREE.Object3D.lookAt / PerspectiveCamera と同じ基底構築・
// 透視除算の数式を踏襲しており、fov は垂直画角 [deg]。
import { Vec3, add, cross, dot, norm, scale, sub } from './vec3';

export type Projected = { x: number; y: number; front: boolean };
export type ProjectionMode = 'perspective' | 'orthographic';

export interface Viewpoint {
  position: Vec3; // 視点の絶対 ECI 位置
  lookTarget: Vec3; // 注視点の絶対 ECI 位置(forward = normalize(lookTarget - position))
  up: Vec3; // 上方向のヒント(forward と直交している必要はない — lookAt と同様に再直交化する)
  fovDeg: number; // 垂直画角
  aspect: number; // width / height
  projection?: ProjectionMode;
  // 直交投影時の画面中央から上下端までの実距離 [m]。
  orthographicHalfHeight?: number;
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
  if (view.projection === 'orthographic' && view.orthographicHalfHeight !== undefined) {
    const halfHeight = Math.max(MIN_DEPTH, view.orthographicHalfHeight);
    return {
      x: viewX / (view.aspect * halfHeight),
      y: viewY / halfHeight,
      front,
    };
  }
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

// 世界空間の寸法 [m] が、その位置の metersPerPixel の下で画面上何 px になるか。
// 見かけの大きさにも、画面上どれだけずれて見えるかにも同じ換算を使う。
export function apparentSizePx(worldSize: number, metersPerPixel: number): number {
  if (!(metersPerPixel > 0)) return 0;
  return worldSize / metersPerPixel;
}

// 視点から distance だけ離れたところにある物体の、画面1ピクセル相当の実距離 [m]。
// distance に何を渡すかは呼び出し側が決める — 視線方向の深度を渡せば画面上の見かけの大きさに、
// 視点からの直線距離を渡せば向きに依らない見かけの大きさになる。
export function metersPerPixelAtDistance(view: Viewpoint, distance: number, viewportHeight: number): number {
  if (view.projection === 'orthographic' && view.orthographicHalfHeight !== undefined) {
    return (2 * Math.max(MIN_DEPTH, view.orthographicHalfHeight)) / viewportHeight;
  }
  return metersPerPixelAtDepth(view.fovDeg, distance, viewportHeight);
}

// worldPos の位置における画面1ピクセル相当の実距離 [m]。画面上で一定に見せたい長さに
// 掛けると、その位置での実距離が得られる。**視線方向の深度で測る**ので、視点の背後にある
// worldPos では深度が MIN_DEPTH まで床打ちされ、目の前にあるのと同じ尺度が返る。
export function metersPerPixel(view: Viewpoint, worldPos: Vec3, viewportHeight: number): number {
  const forward = norm(sub(view.lookTarget, view.position));
  return metersPerPixelAtDistance(view, dot(sub(worldPos, view.position), forward), viewportHeight);
}

// 視線。始点と単位方向ベクトルの組で、どちらも絶対 ECI。
export type Ray = { origin: Vec3; dir: Vec3 };

// width×height のピクセル矩形の (x, y) を通る視線。projectToNdc + ndcToScreen の逆で、
// **カメラ基底の組み方(up の再直交化)も投影側と揃える** — 揃えないと、画面上で当たって
// 見える点が視線側では外れる。直交投影では画面上の位置に応じて始点がずれ、向きは一定になる。
export function rayThroughScreen(view: Viewpoint, x: number, y: number, width: number, height: number): Ray {
  const forward = norm(sub(view.lookTarget, view.position));
  const right = norm(cross(forward, view.up));
  const camUp = cross(right, forward);
  const ndcX = (x / width) * 2 - 1;
  const ndcY = 1 - (y / height) * 2;

  if (view.projection === 'orthographic' && view.orthographicHalfHeight !== undefined) {
    const halfHeight = Math.max(MIN_DEPTH, view.orthographicHalfHeight);
    const offset = add(
      scale(right, ndcX * view.aspect * halfHeight), scale(camUp, ndcY * halfHeight));
    return { origin: add(view.position, offset), dir: forward };
  }
  const tanHalfFov = Math.tan((view.fovDeg * Math.PI) / 360);
  const dir = add(forward, add(
    scale(right, ndcX * view.aspect * tanHalfFov), scale(camUp, ndcY * tanHalfFov)));
  return { origin: view.position, dir: norm(dir) };
}
