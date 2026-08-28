// 天体固定の単位方向まわりの向きの規約: 自転軸、正距円筒図法との往復、接平面の東・北。
// 雲の場を書く側も読む側も、方向と uv の対応はここだけを通す。
import { asin, atan, clamp, cos, cross, float, length, max, sin, vec2, vec3 } from 'three/tsl';
import type { FloatNode, Vec2Node, Vec3Node } from '../tsl-types';

// 自転軸。正距円筒図法の v=0 がこの向きの極。
export const POLE = vec3(0, 1, 0);

// 正距円筒図法の uv から単位方向へ。u は経度(0.5 が本初子午線 +Z、東が +X)、v は緯度
// (0 が北極 +Y)。
export function directionFromEquirectUv(uv: Vec2Node): Vec3Node {
  const longitude = uv.x.sub(0.5).mul(2 * Math.PI);
  const latitude = uv.y.sub(0.5).negate().mul(Math.PI);
  const flat = cos(latitude);
  return vec3(flat.mul(sin(longitude)), sin(latitude), flat.mul(cos(longitude)));
}

// 単位方向から正距円筒図法の uv へ(directionFromEquirectUv の逆)。u は 0..1 に畳む。
export function equirectUvFromDirection(direction: Vec3Node): Vec2Node {
  const u = atan(direction.x, direction.z).div(2 * Math.PI).add(0.5);
  const v = float(0.5).sub(latitudeOf(direction).div(Math.PI));
  return vec2(u, v);
}

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
