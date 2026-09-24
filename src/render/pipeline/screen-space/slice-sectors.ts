// 受け手の視線と画面上の向きが張る平面(スライス)を組み、その中の受け手の半球を余弦重みの測度で扇形に刻む。
// 向き・切片・球冠を扇形の座標とビットへ写し、ビットが覆う測度と、スライスが天体の方位を代表する重みを答える。
import {
  abs, acos, atan, clamp, cos, countOneBits, cross, dot, float, floor, length, max, min, normalize, round, select,
  sign, sin, uint, vec2, vec3,
} from 'three/tsl';
import type { PlanetCap } from '../lighting/planet-light-source';
import type { FloatNode, IntNode, UintNode, Vec2Node, Vec3Node } from '../../tsl-types';

// スライス 1 枚を刻む扇形の数。マスクの幅(uint のビット数)と一致させる。
export const SECTOR_COUNT = 32;
const HALF_PI = Math.PI / 2;

// スライス 1 枚 — 受け手の視線 V と画面上の向きが張る平面。平面の中の点は、受け手を原点に V の成分と
// orthoDirection の成分を並べた 2 次元の座標(スライスの座標)で表す。角度はすべて V から測り、orthoDirection の
// 側を正とする。半球はこの平面の中で [n − π/2, n + π/2] を占め、測度 cos(h − n)·|sin h| dh で量る。
export interface Slice {
  // 画面上の向き(uv の単位ベクトル。y は下向き)。
  readonly screenDirection: Vec2Node;
  // 受け手の視線 V と、平面の中で V に直交する単位ベクトル(view 空間)。
  readonly view: Vec3Node;
  readonly orthoDirection: Vec3Node;
  // 平面の単位法線(view 空間)。
  readonly axis: Vec3Node;
  // 法線を平面へ射影した向きの角 n と、その余弦・正弦。
  readonly normalAngle: FloatNode;
  readonly cosNormal: FloatNode;
  readonly sinNormal: FloatNode;
  // 0 から半球の下端 n − π/2 までの測度(負)と、半球全体の測度。
  readonly lowerMeasure: FloatNode;
  readonly totalMeasure: FloatNode;
  // スライスの結果を平均するときの重み(射影した法線の長さ × 半球全体の測度)。
  readonly weight: FloatNode;
}

// スライスの中の向きの区間を、扇形の座標(sectorPosition)で表したもの。lower ≤ upper。
export interface SectorRange {
  readonly lower: FloatNode;
  readonly upper: FloatNode;
}

// 画面上の角 angle [rad] の向きのスライスを、受け手の視線 view と法線 normal から組む。**Fn の中から呼ぶこと。**
export function sliceAt(angle: FloatNode, view: Vec3Node, normal: Vec3Node): Slice {
  // view 空間の x・y は画面の右・上に揃っている。uv の y は下向き。
  const direction = vec3(cos(angle), sin(angle), 0).toVar();
  const orthoDirection = normalize(direction.sub(view.mul(dot(direction, view)))).toVar();
  const axis = normalize(cross(direction, view)).toVar();
  const projectedNormal = normal.sub(axis.mul(dot(normal, axis))).toVar();
  const projectedLength = length(projectedNormal).toVar();
  const cosNormal = clamp(dot(projectedNormal, view).div(max(projectedLength, 1e-6)), 0, 1).toVar();
  const normalAngle = sign(dot(orthoDirection, projectedNormal)).mul(acos(cosNormal)).toVar();
  const sinNormal = sin(normalAngle).toVar();
  const totalMeasure = cosNormal.add(normalAngle.mul(sinNormal)).toVar();
  return {
    screenDirection: vec2(direction.x, direction.y.negate()).toVar(),
    view,
    orthoDirection,
    axis,
    normalAngle,
    cosNormal,
    sinNormal,
    // 0 から n − π/2 までの測度 −¼(2 cos n + (2n − π) sin n)。
    lowerMeasure: cosNormal.mul(2).add(normalAngle.mul(2).sub(Math.PI).mul(sinNormal)).mul(-0.25).toVar(),
    totalMeasure,
    weight: projectedLength.mul(totalMeasure).toVar(),
  };
}

// view 空間の変位 offset をスライス平面へ射影した、スライスの座標。
export function toSliceCoordinates(slice: Slice, offset: Vec3Node): Vec2Node {
  return vec2(dot(offset, slice.view), dot(offset, slice.orthoDirection));
}

// 受け手から、スライスの座標の点 point の向きの、視線から測った角 [rad]。半球の外は半球の縁へ寄せる。
export function angleOf(slice: Slice, point: Vec2Node): FloatNode {
  return clamp(atan(point.y, point.x), slice.normalAngle.sub(HALF_PI), slice.normalAngle.add(HALF_PI));
}

// 扇形の座標 — 視線から測った角 h を、スライスの半球の余弦重みの測度で 0..SECTOR_COUNT へ写し、画素ごとの
// ずれ dither(0..1)− ½ だけずらしたもの。扇形 j はこの座標の [j, j + 1) を受け持ち、両端の扇形は半球の端までを
// 受け持つ。
export function sectorPosition(slice: Slice, h: FloatNode, dither: FloatNode): FloatNode {
  // 0 から h までの測度 sign(h)·¼(cos n − cos(2h − n) + 2h sin n)。
  const fromView = sign(h).mul(
    slice.cosNormal.sub(cos(h.mul(2).sub(slice.normalAngle))).add(h.mul(2).mul(slice.sinNormal)).mul(0.25),
  );
  return fromView.sub(slice.lowerMeasure).div(slice.totalMeasure).mul(SECTOR_COUNT).add(dither).sub(0.5);
}

// 扇形の座標で lower..upper を覆う切片が立てるビット — 中心 j + ½ が区間に入る扇形 j。ずれ dither が一様なら
// 立つビットの数の期待値は区間の測度に一致し、同じ端を持つ隣の切片とは継ぎ目なく並ぶ。
export function segmentSectors(lower: FloatNode, upper: FloatNode): UintNode {
  return sectorsBelow(floor(upper.add(0.5))).bitAnd(sectorsBelow(floor(lower.add(0.5))).bitNot());
}

// 球冠 cap をスライスへ写した区間 — 中心の向きを平面へ射影した角を中心とし、視半径を半幅とする — を半球で切り、
// 扇形の座標(sectorPosition)で返す。半球の外にあれば幅 0。
export function capRange(slice: Slice, cap: PlanetCap, dither: FloatNode): SectorRange {
  const projected = toSliceCoordinates(slice, cap.direction).toVar();
  const center = atan(projected.y, projected.x).toVar();
  // 中心を半球の側へ寄せる。半球は π、区間は高々 π を占めるので、重なる区間は 1 つしかない。
  const shifted = center.add(round(slice.normalAngle.sub(center).div(2 * Math.PI)).mul(2 * Math.PI)).toVar();
  const halfWidth = acos(clamp(cap.cosAngle, -1, 1)).toVar();
  const lowerEdge = slice.normalAngle.sub(HALF_PI);
  const upperEdge = slice.normalAngle.add(HALF_PI);
  return {
    lower: sectorPosition(slice, clamp(shifted.sub(halfWidth), lowerEdge, upperEdge), dither).toVar(),
    upper: sectorPosition(slice, clamp(shifted.add(halfWidth), lowerEdge, upperEdge), dither).toVar(),
  };
}

// スライスが、向き direction(view 空間)の天体の方位のまわりの楔を代表する重み。視線の成分を除いた向きと
// スライスの向きの角距離(mod π)が 0 で 1、スライスの間隔 π / sliceCount で 0 になる三角形で、隣り合う
// スライスを補間する。
export function wedgeWeight(slice: Slice, direction: Vec3Node, sliceCount: IntNode): FloatNode {
  const across = direction.sub(slice.view.mul(dot(direction, slice.view))).toVar();
  const cosDistance = abs(dot(across, slice.orthoDirection)).div(max(length(across), 1e-6));
  return max(float(1).sub(acos(min(cosDistance, 1)).mul(float(sliceCount)).div(Math.PI)), 0);
}

// ビット bits の扇形が、扇形の座標で range を覆う測度(扇形 1 つが 1)。部分的に掛かる扇形は掛かった長さだけ
// 数える。全ビットが立っていれば range の幅 upper − lower そのもの。
export function maskedMeasure(bits: UintNode, range: SectorRange): FloatNode {
  const first = clamp(floor(range.lower), 0, SECTOR_COUNT - 1).toVar();
  const last = clamp(floor(range.upper), 0, SECTOR_COUNT - 1).toVar();
  const firstBit = bitCount(bits.bitAnd(uint(1).shiftLeft(uint(first))));
  const lastBit = bitCount(bits.bitAnd(uint(1).shiftLeft(uint(last))));
  const between = bitCount(bits.bitAnd(sectorsBelow(last).bitAnd(sectorsBelow(first.add(1)).bitNot())));
  return select(first.equal(last), firstBit.mul(range.upper.sub(range.lower)),
    firstBit.mul(first.add(1).sub(range.lower)).add(between).add(lastBit.mul(range.upper.sub(last))));
}

// 番号が count(整数。0..SECTOR_COUNT の外は端へ寄せる)より小さい扇形のビット。幅いっぱいのシフトは WGSL で
// 使えないので、count = SECTOR_COUNT は別に返す。
function sectorsBelow(count: FloatNode): UintNode {
  const bounded = clamp(count, 0, SECTOR_COUNT);
  const partial = uint(1).shiftLeft(uint(min(bounded, SECTOR_COUNT - 1))).sub(uint(1));
  return select(bounded.greaterThanEqual(SECTOR_COUNT), uint(0xffffffff), partial);
}

// bits の立っているビットの数。
export function bitCount(bits: UintNode): FloatNode {
  // countOneBits の @types/three 上の戻り値型は値の型を持たないため、UintNode へ読み替える。
  return float(countOneBits(bits) as unknown as UintNode);
}
