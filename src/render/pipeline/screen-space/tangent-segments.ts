// スライスの中で、深度の標本 1 つが受け持つ接平面の切片の幾何。画面上で隣り合う標本の切片の境目、スライスの
// 片側の視線、視線と接平面の交点、受け手から見た角の大小を答える。
import { abs, dot, float, getViewPosition, length, select, vec2 } from 'three/tsl';
import { toSliceCoordinates, type Slice } from './slice-sectors';
import type { BoolNode, FloatNode, Mat4Uniform, Vec2Node, Vec3Node } from '../../tsl-types';

// スライスの中の面の点 — スライス平面へ射影した位置(スライスの座標)と、接平面がスライス平面を切る直線
// normal·x = offset(normal の長さは問わない)。offset は受け手から見た接平面の符号つきの高さで、負なら受け手へ
// 面を向ける。
export interface SlicePoint {
  readonly position: Vec2Node;
  readonly normal: Vec2Node;
  readonly offset: FloatNode;
}

// 視線 — 起点 origin(近平面の点)から向き direction(正規化しない)へ延びる半直線(スライスの座標)。
export interface Ray {
  readonly origin: Vec2Node;
  readonly direction: Vec2Node;
}

// スライスの片側で、受け手から画面上で距離 ρ [走査の画素] の点を通る視線を ρ の一次式で表したもの(スライスの
// 座標)。ρ の視線は origin + ρ·originStep を起点に、direction + ρ·directionStep へ向かう。
export interface SideRays {
  readonly origin: Vec2Node;
  readonly originStep: Vec2Node;
  readonly direction: Vec2Node;
  readonly directionStep: Vec2Node;
}

// 画面上で隣り合う 2 標本の切片の境目 — 手前の標本の切片の上端 nearUpper と、奥の標本の切片の下端 farLower
// (スライスの座標)。
export interface SegmentSplit {
  readonly nearUpper: Vec2Node;
  readonly farLower: Vec2Node;
}

// 画面上で隣り合う 2 標本 near(画面距離 nearRho)と far(farRho)の切片の境目。bothSurfaces は両方が面を持つか
// で、偽なら境目は中点の視線で決める。near が受け手自身なら nearRho = 0。rays はこの側の視線。
export function splitSegments(
  rays: SideRays, near: SlicePoint, nearRho: FloatNode, far: SlicePoint, farRho: FloatNode, bothSurfaces: BoolNode,
): SegmentSplit {
  // 互いに相手が自分の接平面の表側にあれば、2 平面はカメラから見える凹んだ継ぎ目で交わる。継ぎ目は 2 平面が
  // スライス平面を切る 2 直線の交点で、画面上で 2 標本のあいだに写るときに使う。
  const concave = bothSurfaces
    .and(dot(near.normal, far.position).greaterThanEqual(near.offset))
    .and(dot(far.normal, near.position).greaterThanEqual(far.offset));
  const determinant = cross2(near.normal, far.normal).toVar();
  const solvable = abs(determinant).greaterThanEqual(1e-6);
  const seam = perpendicular(far.normal).mul(near.offset).sub(perpendicular(near.normal).mul(far.offset))
    .div(select(solvable, determinant, float(1))).toVar();
  const atSeam = concave.and(solvable).and(seenBetween(rays, seam, nearRho, farRho));
  // それ以外(輪郭・凸の稜・面のない標本)は継ぎ目の位置が分からないので、画面上の中点の視線で分ける。
  const middle = rayAt(rays, nearRho.add(farRho).mul(0.5));
  return {
    nearUpper: select(atSeam, seam, tangentHit(middle, near)),
    farLower: select(atSeam, seam, tangentHit(middle, far)),
  };
}

// スライスの片側の視線 — 受け手の uv から uvStep [uv/走査の画素] ずつ画面距離 ρ だけ進んだ点を通る視線を、ρ の
// 一次式として組む。receiver は受け手の位置。固定した NDC 深度で逆射影した点は、透視でも平行投影でも画面座標の
// 一次式になる(逆射影の w 行が画面座標に依らない)ので、近平面と遠平面の点を ρ = 0 と 1 で引けば足りる。向きは
// ρ = 0 で長さ 1 にそろえる。
export function sideRays(
  slice: Slice, receiver: Vec3Node, uv: Vec2Node, uvStep: Vec2Node, projectionInverse: Mat4Uniform,
): SideRays {
  // ρ = 0 と 1 の視線の、近平面の点と遠平面の点までの変位(view 空間)。
  const near = getViewPosition(uv, float(1), projectionInverse).toVar();
  const span = getViewPosition(uv, float(0), projectionInverse).sub(near).toVar();
  const nextUv = uv.add(uvStep).toVar();
  const nextNear = getViewPosition(nextUv, float(1), projectionInverse).toVar();
  const nextSpan = getViewPosition(nextUv, float(0), projectionInverse).sub(nextNear);
  // スライスの座標へ写す。
  const scale = float(1).div(length(span)).toVar();
  return {
    origin: toSliceCoordinates(slice, near.sub(receiver)).toVar(),
    originStep: toSliceCoordinates(slice, nextNear.sub(near)).toVar(),
    direction: toSliceCoordinates(slice, span).mul(scale).toVar(),
    directionStep: toSliceCoordinates(slice, nextSpan.sub(span)).mul(scale).toVar(),
  };
}

// 画面距離 rho の視線。
export function rayAt(rays: SideRays, rho: FloatNode): Ray {
  return {
    origin: rays.origin.add(rays.originStep.mul(rho)),
    direction: rays.direction.add(rays.directionStep.mul(rho)),
  };
}

// スライスの中の点 point が、画面距離 nearRho..farRho の視線に写るか。point が ρ の視線に乗る条件
// (point − origin(ρ)) × direction(ρ) = 0 は ρ の一次式 c + ρ·k = 0 になる — ρ² の項は、透視では起点と向きの歩みが
// 平行、平行投影では向きが一定なので消える。解 −c/k の範囲は、k を掛けて割らずに比べる。
function seenBetween(rays: SideRays, point: Vec2Node, nearRho: FloatNode, farRho: FloatNode): BoolNode {
  const offset = point.sub(rays.origin).toVar();
  const constant = cross2(offset, rays.direction).toVar();
  const slope = cross2(offset, rays.directionStep).sub(cross2(rays.originStep, rays.direction)).toVar();
  return abs(slope).greaterThan(1e-12)
    .and(constant.add(nearRho.mul(slope)).mul(slope).lessThanEqual(0))
    .and(constant.add(farRho.mul(slope)).mul(slope).greaterThanEqual(0));
}

// 視線 ray と、面の点 point の接平面がスライスを切る直線の交点。視線がその直線と平行か、交点が視線の起点
// (近平面)より手前にあれば point の位置。
export function tangentHit(ray: Ray, point: SlicePoint): Vec2Node {
  const facing = dot(point.normal, ray.direction).toVar();
  const parallel = abs(facing).lessThan(1e-6);
  const along = point.offset.sub(dot(point.normal, ray.origin)).div(select(parallel, float(1), facing)).toVar();
  return select(parallel.or(along.lessThanEqual(0)), point.position, ray.origin.add(ray.direction.mul(along)));
}

// スライスの座標の点 a と b のうち、受け手から見た角の小さい方。どちらもスライスの同じ側にあること — 角の差が
// π 未満なので、角を求めずに外積の符号で比べられる。
export function angularlyLower(a: Vec2Node, b: Vec2Node): Vec2Node {
  return select(cross2(a, b).greaterThanEqual(0), a, b);
}

// スライスの座標の点 a と b のうち、受け手から見た角の大きい方。どちらもスライスの同じ側にあること。
export function angularlyHigher(a: Vec2Node, b: Vec2Node): Vec2Node {
  return select(cross2(a, b).greaterThanEqual(0), b, a);
}

// 2 次元の外積 a.x·b.y − a.y·b.x。
function cross2(a: Vec2Node, b: Vec2Node): FloatNode {
  return a.x.mul(b.y).sub(a.y.mul(b.x));
}

// v を 90° 回した (v.y, −v.x)。
function perpendicular(v: Vec2Node): Vec2Node {
  return vec2(v.y, v.x.negate());
}
