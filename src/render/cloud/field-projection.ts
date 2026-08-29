// 単位方向とテクスチャの uv の対応。雲の場を焼く側も読む側も、往復はこの契約だけを通る —
// どの図法で持っているかを、写しの器も読み手も知らない。
import * as THREE from 'three/webgpu';
import { asin, atan, clamp, cos, float, sin, vec2, vec3 } from 'three/tsl';
import type { FloatNode, Vec2Node, Vec3Node } from '../tsl-types';

export type FieldProjection = {
  // 写しの大きさ [texel]。図法が持つ縦横比はここに出る。
  readonly width: number;
  readonly height: number;
  readonly wrapS: THREE.Wrapping;
  readonly wrapT: THREE.Wrapping;
  // uv(0..1)の指す単位方向。1 texel を焼くのに 1 回走る。
  directionAt(uv: Vec2Node): Vec3Node;
  // 単位方向を写す uv(0..1)。1 texel を焼くのに何度も走るので、費用はこちらが効く。
  uvAt(direction: Vec3Node): Vec2Node;
  // その uv に値を持つなら 1、持たないなら 0。正方形の写しへ円板を入れる図法では四隅が 0 になる。
  insideAt(uv: Vec2Node): FloatNode;
};

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
  const v = float(0.5).sub(asin(clamp(direction.y, -1, 1)).div(Math.PI));
  return vec2(u, v);
}

// 全球を正距円筒で持つ。u は経度なので繰り返し、v は緯度なので端に留まる。
export class EquirectProjection implements FieldProjection {
  public readonly width: number;
  public readonly wrapS: THREE.Wrapping = THREE.RepeatWrapping;
  public readonly wrapT: THREE.Wrapping = THREE.ClampToEdgeWrapping;

  // height は緯度 180° を割る texel 数。幅はその 2 倍。
  public constructor(public readonly height: number) {
    this.width = height * 2;
  }

  public directionAt(uv: Vec2Node): Vec3Node {
    return directionFromEquirectUv(uv);
  }

  public uvAt(direction: Vec3Node): Vec2Node {
    return equirectUvFromDirection(direction);
  }

  // 全球を覆うので、どの uv も値を持つ。
  public insideAt(): FloatNode {
    return float(1);
  }
}
