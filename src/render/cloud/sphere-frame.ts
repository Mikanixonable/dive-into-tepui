// 天体固定の単位方向まわりの向きの規約: 自転軸と、そこから決まる緯度・接平面の東と北。
import { asin, clamp, cross, length, max, vec3 } from 'three/tsl';
import type { FloatNode, Vec3Node } from '../tsl-types';

// 自転軸。
const POLE = vec3(0, 1, 0);

// 単位方向の緯度 [rad]。
export function latitudeOf(direction: Vec3Node): FloatNode {
  return asin(clamp(direction.y, -1, 1));
}

// 東向きの単位接ベクトル。極では向きが決まらないので、長さに床を張って発散を避ける。
export function eastAt(direction: Vec3Node): Vec3Node {
  const raw = cross(POLE, direction);
  return raw.div(max(length(raw), 1e-6));
}

// 北向きの単位接ベクトル。
export function northAt(direction: Vec3Node): Vec3Node {
  return cross(direction, eastAt(direction));
}
