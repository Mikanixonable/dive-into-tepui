// 天体固定の単位方向まわりの向きの規約: 自転軸と、そこから決まる緯度・接平面の東と北。
import { asin, clamp, cross, length, max, vec3 } from 'three/tsl';
import * as vec from '../../math/vec3';
import type { Vec3 } from '../../math/vec3';
import type { FloatNode, Vec3Node } from '../tsl-types';

// 自転軸。
const POLE = vec3(0, 1, 0);
const POLE_CPU = vec.v3(0, 1, 0);

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

// latitudeOf の数値版。
export function latitudeAtCpu(direction: Vec3): number {
  return Math.asin(Math.min(1, Math.max(-1, direction.y)));
}

// eastAt の数値版。極では同じ床で退化する。
export function eastAtCpu(direction: Vec3): Vec3 {
  const raw = vec.cross(POLE_CPU, direction);
  return vec.scale(raw, 1 / Math.max(vec.len(raw), 1e-6));
}

// northAt の数値版。
export function northAtCpu(direction: Vec3): Vec3 {
  return vec.cross(direction, eastAtCpu(direction));
}
