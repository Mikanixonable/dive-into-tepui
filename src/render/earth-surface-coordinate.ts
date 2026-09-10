// 地球の地理UVと、天体固定の楕円体表面・放射方向・法線との変換を担う。
import * as THREE from 'three/webgpu';
import { normalize, vec2 } from 'three/tsl';
import type { Vec2Node, Vec3Node } from './tsl-types';

const FULL_TURN = 2 * Math.PI;

// 半軸は天体固定XYZの正の実長 [m]。
export function validateEarthAxes(axes: THREE.Vector3): void {
  if (![axes.x, axes.y, axes.z].every((axis) => Number.isFinite(axis) && axis > 0)) {
    throw new RangeError('Earth semi-axes must be finite and positive');
  }
}

// 実楕円体上の位置 [m] から、天体固定の外向き単位法線を返す。
export function earthSurfaceNormal(position: THREE.Vector3, axes: THREE.Vector3): THREE.Vector3 {
  validateEarthAxes(axes);
  const normal = position.clone().divide(axes).divide(axes);
  if (normal.lengthSq() === 0) throw new RangeError('Earth surface direction must be nonzero');
  return normal.normalize();
}

// 実位置 [m] を正距円筒UVへ写す。u=0/1は西経/東経180度、v=0は北極。
// 経度の両端を保持し、索引化する呼び出し側で周期を畳む。
export function earthSurfaceUv(position: THREE.Vector3, axes: THREE.Vector3): THREE.Vector2 {
  const normal = earthSurfaceNormal(position, axes);
  return new THREE.Vector2(
    Math.atan2(normal.x, normal.z) / FULL_TURN + 0.5,
    0.5 - Math.asin(THREE.MathUtils.clamp(normal.y, -1, 1)) / Math.PI,
  );
}

// 地理UVから天体固定の外向き単位法線を返す。uは周期、vは北極から南極まで。
export function earthNormalAtUv(u: number, v: number): THREE.Vector3 {
  if (!Number.isFinite(u) || !Number.isFinite(v) || v < 0 || v > 1) {
    throw new RangeError('Invalid geographic UV');
  }
  if (v === 0 || v === 1) return new THREE.Vector3(0, v === 0 ? 1 : -1, 0);
  const longitude = (u - 0.5) * FULL_TURN;
  const latitude = (0.5 - v) * Math.PI;
  return new THREE.Vector3(
    Math.cos(latitude) * Math.sin(longitude), Math.sin(latitude), Math.cos(latitude) * Math.cos(longitude),
  );
}

// 地理UVが指す実楕円体表面の位置 [m] を返す。
export function earthPositionAtUv(u: number, v: number, axes: THREE.Vector3): THREE.Vector3 {
  validateEarthAxes(axes);
  const scaledNormal = earthNormalAtUv(u, v).multiply(axes);
  return scaledNormal.clone().multiply(axes).divideScalar(scaledNormal.length());
}

// 地理UVから天体固定の放射方向へ写す。
export function earthRadialAtUv(u: number, v: number, axes: THREE.Vector3): THREE.Vector3 {
  return earthPositionAtUv(u, v, axes).normalize();
}

// 天体固定の放射方向を地理UVへ写す。方向の長さは任意の正値。
export function earthUvFromRadial(direction: THREE.Vector3, axes: THREE.Vector3): THREE.Vector2 {
  return earthSurfaceUv(direction, axes);
}

// 天体固定の放射方向を、楕円体の地理緯度・経度へGPU上で写す。axesは天体固定XYZの半軸 [m]。
export function earthSurfaceUvFromRadialNode(direction: Vec3Node, axes: Vec3Node): Vec2Node {
  const normal = normalize(direction.div(axes.mul(axes)));
  const longitude = normal.z.atan(normal.x.negate());
  return vec2(
    longitude.add(Math.PI / 2).div(2 * Math.PI).fract(),
    normal.y.clamp(-1, 1).asin().div(Math.PI).negate().add(0.5),
  );
}

// 天体固定の実法線をview空間へ回す。bodyToViewは姿勢とカメラ回転から作る正規直交行列。
export function earthNormalToView(normal: THREE.Vector3, bodyToView: THREE.Matrix3): THREE.Vector3 {
  return normal.clone().applyMatrix3(bodyToView).normalize();
}
