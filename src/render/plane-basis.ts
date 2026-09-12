// 天球グリッド・縮尺グリッドが平面を張るのに使う直交基底。赤道面・黄道面の向きは
// physics/ecliptic の座標変換そのものから組み、目盛りの向きが天球座標とずれないようにする。
import * as THREE from 'three/webgpu';
import { eclToEci, raDecToEci } from '../physics/ecliptic';
import type { Vec3 } from '../math/vec3';

// 面を張る直交基底。e1/e2 が面内、pole が法線(北極方向)で、e1×e2 = pole の右手系。
// 経度は e1 から e2 へ増える。
export interface PlaneBasis {
  readonly e1: THREE.Vector3;
  readonly e2: THREE.Vector3;
  readonly pole: THREE.Vector3;
}

// math/vec3 の Vec3 を THREE.Vector3 へ写す。
function axis(v: Vec3): THREE.Vector3 {
  return new THREE.Vector3(v.x, v.y, v.z);
}

// 経度=赤経、緯度=赤緯。
export const EQUATOR_BASIS: PlaneBasis = {
  e1: axis(raDecToEci(0, 0)),
  e2: axis(raDecToEci(90, 0)),
  pole: axis(raDecToEci(0, 90)),
};

// 経度=黄経、緯度=黄緯。
export const ECLIPTIC_BASIS: PlaneBasis = {
  e1: axis(eclToEci(1, 0, 0)),
  e2: axis(eclToEci(0, 1, 0)),
  pole: axis(eclToEci(0, 0, 1)),
};

// 法線だけが与えられる面の基底。経度の原点を決める基準が無く e1 の向きは任意になるので、
// 経度の目盛りを持たない面に使う。
export function planeBasisFromPole(poleInput: THREE.Vector3): PlaneBasis {
  const pole = poleInput.clone().normalize();
  const e1 = new THREE.Vector3(1, 0, 0).projectOnPlane(pole);
  if (e1.lengthSq() < 1e-8) e1.set(0, 0, 1).projectOnPlane(pole);
  e1.normalize();
  // e1×e2 = pole の右手系にする — makeBasis→setFromRotationMatrix は回転行列しか四元数化できない。
  const e2 = pole.clone().cross(e1).normalize();
  return { e1, e2, pole };
}
