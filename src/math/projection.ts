// ピンホールカメラ投影(Vec3 → NDC → ピクセル)と、その逆の画面上の点を通る視線。
// カメラの絶対 ECI 視点状態と対象の絶対 ECI 位置から計算する。基底の組み方と透視除算は
// THREE.Object3D.lookAt / PerspectiveCamera と同じ式なので、描画と画面上の位置が一致する。
import { Vec3, add, cross, dot, norm, scale, sub } from './vec3';
import type { Ray } from './ray';

export interface Projected { readonly x: number; readonly y: number; readonly front: boolean }
export type ProjectionMode = 'perspective' | 'orthographic';

export interface Viewpoint {
  readonly position: Vec3; // 視点の絶対 ECI 位置
  readonly lookTarget: Vec3; // 注視点の絶対 ECI 位置(forward = normalize(lookTarget - position))
  readonly up: Vec3; // 上方向のヒント(forward と平行でなければよく、再直交化して使う)
  readonly fovDeg: number; // 垂直画角 [deg]
  readonly aspect: number; // width / height
  readonly projection?: ProjectionMode;
  // 直交投影時の画面中央から上下端までの実距離 [m]。
  readonly orthographicHalfHeight?: number;
}

// 視点を束縛した投影。worldPos を画面ピクセルへ写す。
export type ProjectFn = (worldPos: Vec3) => Projected;
// 視点を束縛した尺度。worldPos の位置で画面1ピクセルに相当する実距離 [m] を答える。
export type ScaleFn = (worldPos: Vec3) => number;

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

  // NDC へ(直交投影は半高さで割り、透視投影は深度で除算する)
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

// 視点と描画先の寸法を束縛した投影。同じ視点で多数の点を写す呼び出し側は、これを1つ作って
// 使い回す。
export function screenProjection(view: Viewpoint, width: number, height: number): ProjectFn {
  return (worldPos) => ndcToScreen(projectToNdc(view, worldPos), width, height);
}

// depth の下限。視点上・視点の背後の点で 0 や負の尺度を返さないための床。
export const MIN_DEPTH = 1e-6;

// metersPerPixelAtDepth の、垂直画角を半分の tan で受け取る版。
export function metersPerPixelFromTanHalfFov(tanHalfFov: number, depth: number, viewportHeight: number): number {
  return (2 * Math.max(MIN_DEPTH, depth) * tanHalfFov) / viewportHeight;
}

// 垂直画角 fovDeg のピンホールカメラで、視点から視線方向に depth 離れた点における
// 画面1ピクセル相当の実距離 [m]。depth は MIN_DEPTH で床打ちする。
export function metersPerPixelAtDepth(fovDeg: number, depth: number, viewportHeight: number): number {
  return metersPerPixelFromTanHalfFov(Math.tan((fovDeg * Math.PI) / 360), depth, viewportHeight);
}

// 世界空間の長さ [m] が、その位置の metersPerPixel の下で画面上何 px になるか。
// 大きさにもずれにも使える。metersPerPixel が正でなければ 0。
export function apparentSizePx(worldSize: number, metersPerPixel: number): number {
  if (!(metersPerPixel > 0)) return 0;
  return worldSize / metersPerPixel;
}

// 視点から distance だけ離れたところにある物体の、画面1ピクセル相当の実距離 [m]。
// 視線方向の深度を渡せば画面上の見かけの大きさに、視点からの直線距離を渡せば向きに依らない
// 見かけの大きさになる。直交投影では distance に依らず一定。
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

// width×height のピクセル矩形の (x, y) を通る視線(projectToNdc + ndcToScreen の逆)。
// 直交投影では画面上の位置に応じて始点がずれ、向きは一定になる。
export function rayThroughScreen(view: Viewpoint, x: number, y: number, width: number, height: number): Ray {
  // 基底は projectToNdc と同じ組み方にする — ずれると画面上で当たって見える点が視線側では外れる
  const forward = norm(sub(view.lookTarget, view.position));
  const right = norm(cross(forward, view.up));
  const camUp = cross(right, forward);
  const ndcX = (x / width) * 2 - 1;
  const ndcY = 1 - (y / height) * 2;

  // 直交投影: 画面上の位置ぶん始点をずらし、向きは視線方向
  if (view.projection === 'orthographic' && view.orthographicHalfHeight !== undefined) {
    const halfHeight = Math.max(MIN_DEPTH, view.orthographicHalfHeight);
    const offset = add(
      scale(right, ndcX * view.aspect * halfHeight), scale(camUp, ndcY * halfHeight));
    return { origin: add(view.position, offset), dir: forward };
  }
  // 透視投影: 視点から画面上の点へ向かう
  const tanHalfFov = Math.tan((view.fovDeg * Math.PI) / 360);
  const dir = add(forward, add(
    scale(right, ndcX * view.aspect * tanHalfFov), scale(camUp, ndcY * tanHalfFov)));
  return { origin: view.position, dir: norm(dir) };
}
