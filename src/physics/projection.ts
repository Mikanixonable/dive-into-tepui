// ピンホールカメラ投影(Vec3 → NDC → ピクセル)。THREE.js の PerspectiveCamera や
// フローティングオリジンに依存せず、カメラの絶対 ECI 視点状態と対象の絶対 ECI 位置
// だけから完結する。THREE.Object3D.lookAt / PerspectiveCamera と同じ基底構築・
// 透視除算の数式を踏襲しており、fov は垂直画角 [deg]。
import { Vec3, cross, dot, norm, sub } from './vec3';

export type Projected = { x: number; y: number; front: boolean };

export interface ViewFrame {
  position: Vec3; // 視点の絶対 ECI 位置
  lookTarget: Vec3; // 注視点の絶対 ECI 位置(forward = normalize(lookTarget - position))
  up: Vec3; // 上方向のヒント(forward と直交している必要はない — lookAt と同様に再直交化する)
  fovDeg: number; // 垂直画角
  aspect: number; // width / height
}

// worldPos を NDC([-1,1] 、+Y が上)へ投影する。front = カメラの前方(near/far 非依存)。
export function projectToNdc(view: ViewFrame, worldPos: Vec3): Projected {
  const forward = norm(sub(view.lookTarget, view.position));
  const right = norm(cross(forward, view.up));
  const camUp = cross(right, forward);

  const rel = sub(worldPos, view.position);
  const viewX = dot(rel, right);
  const viewY = dot(rel, camUp);
  const viewZ = -dot(rel, forward);
  const front = viewZ < 0;

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
