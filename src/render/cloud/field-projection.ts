// 単位方向とテクスチャの uv の対応を図法ごとに持つ。雲の場を焼く側と読む側は、この契約を通して
// 同じ図法を共有する。
import * as THREE from 'three/webgpu';
import { asin, atan, clamp, cos, dot, float, max, sin, sqrt, step, uniform, vec2, vec3 } from 'three/tsl';
import type { FloatNode, FloatUniform, Vec2Node, Vec3Node, Vec3Uniform } from '../tsl-types';

export type FieldProjection = {
  // 写しの大きさ [texel]。図法が持つ縦横比はここに出る。
  readonly width: number;
  readonly height: number;
  readonly wrapS: THREE.Wrapping;
  readonly wrapT: THREE.Wrapping;
  // 1 texel が張る角 [rad](写しの中でいちばん細かい所)。標本化できない細かさを畳むのに使う。
  readonly texelAngle: FloatNode;
  // 同じ角のいまの値。写しをどこまで粗く焼いてよいかを CPU 側で決めるのに使う。
  readonly texelAngleValue: number;
  // 写しの置き方の版。置き方が変わるたびに進むので、焼いた写しがいまの置き方のものかを見分けられる。
  readonly revision: number;
  // uv(0..1)の指す単位方向。1 texel を焼くのに 1 回走る。
  directionAt(uv: Vec2Node): Vec3Node;
  // 単位方向を写す uv(0..1)。1 texel を焼くのに何度も走るので、費用はこちらが効く。
  uvAt(direction: Vec3Node): Vec2Node;
  // その uv に値を持つなら 1、持たないなら 0。正方形の写しへ円板を入れる図法では四隅が 0 になる。
  insideAt(uv: Vec2Node): FloatNode;
};

// 正距円筒図法の uv から単位方向へ。u は経度(0.5 が本初子午線 +Z、東が +X)、v は緯度
// (0 が北極 +Y)。
function directionFromEquirectUv(uv: Vec2Node): Vec3Node {
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
  public readonly texelAngle: FloatNode;
  public readonly texelAngleValue: number;
  // 全球を覆う置き方は構築時に決まるので、版は 0 のまま。
  public readonly revision = 0;

  // height は緯度 180° を割る texel 数。幅はその 2 倍。
  public constructor(public readonly height: number) {
    this.width = height * 2;
    this.texelAngleValue = Math.PI / height;
    this.texelAngle = float(this.texelAngleValue);
  }

  // u を経度、v を緯度(0 が北極)として読んだ単位方向。
  public directionAt(uv: Vec2Node): Vec3Node {
    return directionFromEquirectUv(uv);
  }

  // 単位方向の経度・緯度の uv。u は 0..1 に畳む。
  public uvAt(direction: Vec3Node): Vec2Node {
    return equirectUvFromDirection(direction);
  }

  // 全球を覆うので、どの uv も値を持つ。
  public insideAt(): FloatNode {
    return float(1);
  }
}

// 中心のまわりの円板だけを正方形の写しで持つ正射影 — 中心からの球面上距離 θ を、投影面上の
// 半径 sin θ へ写す。遠方から球を見た画面そのものの写像なので、texel と画素の比が円板の全域で
// ほぼ一定になる。円板の外側(四隅)は値を持たない。
export class OrthographicCap implements FieldProjection {
  public readonly width: number;
  public readonly height: number;
  public readonly wrapS: THREE.Wrapping = THREE.ClampToEdgeWrapping;
  public readonly wrapT: THREE.Wrapping = THREE.ClampToEdgeWrapping;
  // 中心の単位方向と、そこでの接平面の枠。テクスチャ全域で定数なので CPU 側で組む。
  private readonly center: Vec3Uniform = uniform(new THREE.Vector3());
  private readonly east: Vec3Uniform = uniform(new THREE.Vector3());
  private readonly north: Vec3Uniform = uniform(new THREE.Vector3());
  private readonly sinRadius: FloatUniform = uniform(0);
  private revisionValue = 0;
  // 投影面は円板の直径を size texel で割るので、中心での 1 texel は 2 sin(半径) / size [rad]。
  // 外周へ向かって texel は角度としては粗くなるが、それは球の傾きぶんで、画面上では一定に見える。
  public readonly texelAngle: FloatNode;

  // size は写しの 1 辺の texel 数。中心と半径の意味は aim() と同じ。
  public constructor(size: number, latitude: number, longitude: number, radius: number) {
    this.width = size;
    this.height = size;
    this.texelAngle = this.sinRadius.mul(2 / size);
    this.aim(latitude, longitude, radius);
  }

  // 中心の緯度・経度 [rad] と円板の半径 [rad](0 < radius ≤ π/2)を置き直す。枠は経度から直に
  // 組むので、中心が極にあっても退化しない。
  public aim(latitude: number, longitude: number, radius: number): void {
    const cosLatitude = Math.cos(latitude);
    const sinLatitude = Math.sin(latitude);
    const cosLongitude = Math.cos(longitude);
    const sinLongitude = Math.sin(longitude);
    this.center.value.set(cosLatitude * sinLongitude, sinLatitude, cosLatitude * cosLongitude);
    this.east.value.set(cosLongitude, 0, -sinLongitude);
    this.north.value.set(-sinLatitude * sinLongitude, cosLatitude, -sinLatitude * cosLongitude);
    this.sinRadius.value = Math.sin(radius);
    this.revisionValue += 1;
  }

  // 中心での 1 texel の角 [rad]。aim() で半径を置き直すと変わる。
  public get texelAngleValue(): number {
    return (this.sinRadius.value * 2) / this.width;
  }

  // 置き方の版。aim() のたびに進む。
  public get revision(): number { return this.revisionValue; }

  // 投影面上の uv から球面へ戻した単位方向。
  public directionAt(uv: Vec2Node): Vec3Node {
    // v は北から南へ増えるので、北成分は符号を返す。円板の外では中心からの距離を 1 で止める。
    const plane = vec2(uv.x.mul(2).sub(1), float(1).sub(uv.y.mul(2))).mul(this.sinRadius);
    const alongCenter = sqrt(max(float(1).sub(dot(plane, plane)), 0));
    return this.east.mul(plane.x).add(this.north.mul(plane.y)).add(this.center.mul(alongCenter));
  }

  // 単位方向を中心の接平面へ正射影した uv。裏側の半球も表側と同じ uv へ写る。
  public uvAt(direction: Vec3Node): Vec2Node {
    const plane = vec2(dot(direction, this.east), dot(direction, this.north)).div(this.sinRadius);
    return vec2(plane.x, plane.y.negate()).mul(0.5).add(0.5);
  }

  // uv が円板の内側なら 1、四隅なら 0。
  public insideAt(uv: Vec2Node): FloatNode {
    const offset = uv.mul(2).sub(1);
    return step(dot(offset, offset), 1);
  }
}
