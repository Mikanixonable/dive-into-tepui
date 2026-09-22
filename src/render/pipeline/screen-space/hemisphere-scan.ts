// 受け手 1 画素のまわりの半球を、画面に写った近くの構造に対して走査する。答えるのは、余弦重みで測った
// 遮られない割合(可視率)と、遮られない向きの平均(曲げた法線)。
//
// 画面上の向き(スライス)を数本取り、それぞれ両側へ深度を引く。スライスの中の遮りは扇形のビットマスクで
// 持ち、深度の標本を一定の厚みの板とみなして、板が覆う扇形を立てる(Therrien, Levesque, Gilet 2023
// 「Screen Space Indirect Lighting with Visibility Bitmask」)。
import type * as THREE from 'three/webgpu';
import {
  If, Loop, acos, clamp, cos, countOneBits, cross, dot, float, floor, getViewPosition, length, max, min, mix,
  normalize, round, screenSize, screenUV, select, sign, sin, smoothstep, texture, uint, vec2, vec3, vec4,
} from 'three/tsl';
import { octDecodeNormal } from '../gbuffer';
import { viewRayAt } from '../view-ray';
import type { FloatNode, IntNode, Mat4Uniform, UintNode, Vec2Node, Vec3Node } from '../../tsl-types';

// 遮りを探す距離 [m]。受け手からこれより遠い面は遮らない。
const WORLD_RADIUS = 4;
// 深度の標本 1 つが奥へ占める厚み [m]。
const SLAB_THICKNESS = 0.5;
// 画面上で探す半径の上限。走査の解像度の高さに対する比。
const MAX_SCREEN_RADIUS = 0.25;
// 受け手の接平面からの仰角の正弦がこれ以下の標本は、接平面の上に出ていないとみなす。法線の量子化の誤差を
// 吸う幅で、これより低い遮りが塞ぐ余弦重みの測度は無視できる。
const MIN_ELEVATION = 0.01;
// スライス 1 枚を刻む扇形の数。マスクの幅(uint のビット数)と一致させる。
const SECTOR_COUNT = 32;
// 扇形の番号の 2 進の桁 k が立っているビットの集合。k 桁目の重さは 2^k。
const SECTOR_INDEX_DIGITS = [0xaaaaaaaa, 0xcccccccc, 0xf0f0f0f0, 0xff00ff00, 0xffff0000];
// 扇形の座標を角度へ戻す二分法の回数。
const ANGLE_BISECTION_STEPS = 8;
const HALF_PI = Math.PI / 2;

// 1 画素の半球を走査した結果。
export interface HemisphereScan {
  // 余弦重みの可視率 V 0..1。
  readonly visibility: FloatNode;
  // 遮られない向きの余弦重みの平均(view 空間、正規化済み)。
  readonly bentNormal: Vec3Node;
}

// スライス 1 枚 — 受け手の視線 V と画面上の向きが張る平面。角度はすべて V から測り、orthoDirection の側を
// 正とする。半球はこの平面の中で [n − π/2, n + π/2] を占め、測度 cos(h − n)·|sin h| dh で量る。
interface Slice {
  // 画面上の向き(uv の単位ベクトル。y は下向き)。
  readonly screenDirection: Vec2Node;
  // 平面の中で V に直交する単位ベクトル(view 空間)。
  readonly orthoDirection: Vec3Node;
  // 法線を平面へ射影した向きの角 n と、その余弦・正弦。
  readonly normalAngle: FloatNode;
  readonly cosNormal: FloatNode;
  readonly sinNormal: FloatNode;
  // 0 から半球の下端 n − π/2 までの測度(負)と、半球全体の測度。
  readonly lowerMeasure: FloatNode;
  readonly totalMeasure: FloatNode;
  // 可視率を平均するときの重み(射影した法線の長さ × 半球全体の測度)。
  readonly weight: FloatNode;
}

// 走査の解像度で写した面 — 素の深度 depth と法線 normal(view 空間、oct 符号化)— の上で、いま描いている
// 画素を受け手として走査する。projection / projectionInverse は実カメラの射影行列とその逆、sliceCount は
// スライスの数、stepCount は片側の歩数、noise は画素ごとの 0..1 の組(x がスライスの回転、y が歩みのずれ)。
// 面と同じ解像度の描画先へ描くこと。**Fn の中から呼ぶこと。**
export function scanHemisphere(
  depth: THREE.Texture, normal: THREE.Texture, projection: Mat4Uniform, projectionInverse: Mat4Uniform,
  sliceCount: IntNode, stepCount: IntNode, noise: Vec2Node,
): HemisphereScan {
  // 受け手。ループの中と外の両方から読むので、先に変数へ置く。視線は投影方式によらない形から取る。
  const uv = screenUV;
  const receiverDepth = texture(depth, uv).r.toVar();
  const position = getViewPosition(uv, receiverDepth, projectionInverse).toVar();
  const receiverNormal = octDecodeNormal(texture(normal, uv).rg).toVar();
  const view = viewRayAt(projectionInverse, uv).direction.negate().toVar();
  const radius = screenRadius(position, projection).toVar();
  const rotation = noise.x.toVar();
  const jitter = noise.y.toVar();

  const visibility = float(1).toVar();
  const bentNormal = receiverNormal.toVar();
  // 虚空(深度 0)と、半径が画面上で 1 画素に満たない受け手(天体の表面)は走査せず、1〜2 画素で効きを
  // 0 から 1 へ渡す。
  If(receiverDepth.greaterThan(0).and(radius.greaterThanEqual(1)), () => {
    const weightedVisibility = float(0).toVar();
    const totalWeight = float(0).toVar();
    const bentSum = vec3(0).toVar();
    Loop({ start: 0, end: sliceCount, type: 'int', condition: '<' }, ({ i }) => {
      const slice = sliceAt(float(i).add(rotation).mul(Math.PI).div(float(sliceCount)), view, receiverNormal);
      const occluded = uint(0).toVar();
      // 両側へ、手前から奥の順に歩む。刻みは 2 乗で受け手へ寄せ、同じ画素は読まない。
      Loop({ start: 0, end: 2, type: 'int', condition: '<' }, ({ i: sideIndex }) => {
        const side = float(1).sub(float(sideIndex).mul(2)).toVar();
        Loop({ start: 0, end: stepCount, type: 'int', condition: '<' }, ({ i: step }) => {
          const progress = float(step).add(jitter).div(float(stepCount));
          const offset = max(progress.mul(progress).mul(radius), 1);
          const target = uv.add(slice.screenDirection.mul(side.mul(offset)).div(screenSize));
          const sampleUV = floor(target.mul(screenSize)).add(0.5).div(screenSize).toVar();
          const rawDepth = texture(depth, sampleUV).r;
          // 画面の外の標本と虚空(深度 0)の標本は遮らない。
          const onScreen = target.x.greaterThanEqual(0).and(target.y.greaterThanEqual(0))
            .and(target.x.lessThan(1)).and(target.y.lessThan(1));
          If(onScreen.and(rawDepth.greaterThan(0)), () => {
            const toFront = getViewPosition(sampleUV, rawDepth, projectionInverse).sub(position).toVar();
            const distance = length(toFront);
            // 接平面の上に出ていない標本は遮らない — 板はそこから奥へ、さらに低く伸びる。画素の中心へ寄せた
            // 標本はスライスの平面から外れるので、受け手と同じ平面の上でも視線からの角が縁の内側へ入る。
            const aboveTangent = dot(toFront, receiverNormal).greaterThan(distance.mul(MIN_ELEVATION));
            If(distance.lessThanEqual(WORLD_RADIUS).and(aboveTangent), () => {
              occluded.assign(occluded.bitOr(slabSectors(slice, view, toFront, side)));
            });
          });
        });
      });
      // スライスの可視率と、遮られない向きを重みつきで積む。
      const unoccluded = occluded.bitNot().toVar();
      const openCount = bitCount(unoccluded).toVar();
      const sliceVisibility = openCount.div(SECTOR_COUNT);
      weightedVisibility.addAssign(slice.weight.mul(sliceVisibility));
      totalWeight.addAssign(slice.weight);
      If(openCount.greaterThan(0), () => {
        const openAngle = angleOfCoordinate(slice, meanSectorCoordinate(unoccluded, openCount));
        const openDirection = view.mul(cos(openAngle)).add(slice.orthoDirection.mul(sin(openAngle)));
        bentSum.addAssign(openDirection.mul(slice.weight.mul(sliceVisibility)));
      });
    });
    const reach = smoothstep(1, 2, radius);
    const scanned = select(totalWeight.greaterThan(1e-6), weightedVisibility.div(max(totalWeight, 1e-6)), float(1));
    const bentLength = length(bentSum);
    const scannedBent = select(bentLength.greaterThan(1e-6), bentSum.div(max(bentLength, 1e-6)), receiverNormal);
    visibility.assign(mix(float(1), scanned, reach));
    bentNormal.assign(normalize(mix(receiverNormal, scannedBent, reach)));
  });
  return { visibility, bentNormal };
}

// view 空間の点 position から WORLD_RADIUS 離れた点が、描いている画面の上で何画素離れて写るか。上限で頭打ち
// にする。透視でも平行投影でも同じ式で測る。
function screenRadius(position: Vec3Node, projection: Mat4Uniform): FloatNode {
  const center = projection.mul(vec4(position, 1));
  const edge = projection.mul(vec4(position.add(vec3(WORLD_RADIUS, 0, 0)), 1));
  const ndcOffset = edge.xy.div(edge.w).sub(center.xy.div(center.w));
  return min(length(ndcOffset.mul(screenSize).mul(0.5)), screenSize.y.mul(MAX_SCREEN_RADIUS));
}

// 画面上の角 angle [rad] の向きのスライスを、受け手の視線 view と法線 normal から組む。**Fn の中から呼ぶこと。**
function sliceAt(angle: FloatNode, view: Vec3Node, normal: Vec3Node): Slice {
  // view 空間の x・y は画面の右・上に揃っている。uv の y は下向き。
  const direction = vec3(cos(angle), sin(angle), 0).toVar();
  const orthoDirection = normalize(direction.sub(view.mul(dot(direction, view)))).toVar();
  const axis = normalize(cross(direction, view));
  const projectedNormal = normal.sub(axis.mul(dot(normal, axis))).toVar();
  const projectedLength = length(projectedNormal).toVar();
  const cosNormal = clamp(dot(projectedNormal, view).div(max(projectedLength, 1e-6)), 0, 1).toVar();
  const normalAngle = sign(dot(orthoDirection, projectedNormal)).mul(acos(cosNormal)).toVar();
  const sinNormal = sin(normalAngle).toVar();
  const totalMeasure = cosNormal.add(normalAngle.mul(sinNormal)).toVar();
  return {
    screenDirection: vec2(direction.x, direction.y.negate()).toVar(),
    orthoDirection,
    normalAngle,
    cosNormal,
    sinNormal,
    // 0 から n − π/2 までの測度 −¼(2 cos n + (2n − π) sin n)。
    lowerMeasure: cosNormal.mul(2).add(normalAngle.mul(2).sub(Math.PI).mul(sinNormal)).mul(-0.25).toVar(),
    totalMeasure,
    weight: projectedLength.mul(totalMeasure).toVar(),
  };
}

// 視線から測った角 h を、スライスの半球の測度で 0..1 へ写した座標。扇形はこの座標で等分する。
function sectorCoordinate(slice: Slice, h: FloatNode): FloatNode {
  // 0 から h までの測度 sign(h)·¼(cos n − cos(2h − n) + 2h sin n)。
  const fromView = sign(h).mul(
    slice.cosNormal.sub(cos(h.mul(2).sub(slice.normalAngle))).add(h.mul(2).mul(slice.sinNormal)).mul(0.25),
  );
  return fromView.sub(slice.lowerMeasure).div(slice.totalMeasure);
}

// sectorCoordinate の逆。座標 coordinate 0..1 に当たる角 [rad]。**Fn の中から呼ぶこと。**
function angleOfCoordinate(slice: Slice, coordinate: FloatNode): FloatNode {
  const lower = slice.normalAngle.sub(HALF_PI).toVar();
  const upper = slice.normalAngle.add(HALF_PI).toVar();
  Loop(ANGLE_BISECTION_STEPS, () => {
    const middle = lower.add(upper).mul(0.5).toVar();
    If(sectorCoordinate(slice, middle).lessThan(coordinate), () => { lower.assign(middle); })
      .Else(() => { upper.assign(middle); });
  });
  return lower.add(upper).mul(0.5);
}

// 立っているビットが表す扇形の、中心の座標の平均。setCount は立っているビットの数(1 以上)。
function meanSectorCoordinate(bits: UintNode, setCount: FloatNode): FloatNode {
  // 番号の総和を、桁ごとに「その桁が立つ番号のビット」の数から組む。
  const indexSum = float(0).toVar();
  for (const [digit, digitBits] of SECTOR_INDEX_DIGITS.entries()) {
    indexSum.addAssign(bitCount(bits.bitAnd(uint(digitBits))).mul(2 ** digit));
  }
  return indexSum.div(setCount).add(0.5).div(SECTOR_COUNT);
}

// 受け手から toFront にある深度の標本を、奥へ SLAB_THICKNESS の板とみなしたとき、板が覆う扇形のビット。
// side は標本が画面上でスライスの向きのどちら側にあるか(+1 / −1)。
function slabSectors(slice: Slice, view: Vec3Node, toFront: Vec3Node, side: FloatNode): UintNode {
  const front = sectorCoordinate(slice, horizonAngle(slice, view, toFront, side));
  const back = sectorCoordinate(slice, horizonAngle(slice, view, toFront.sub(view.mul(SLAB_THICKNESS)), side));
  // 覆う区間が半分以上に掛かる扇形を立てる。
  const lower = round(min(front, back).mul(SECTOR_COUNT));
  const upper = round(max(front, back).mul(SECTOR_COUNT));
  return sectorsBelow(upper).bitAnd(sectorsBelow(lower).bitNot());
}

// 受け手から toPoint の向きの、視線から測った角 [rad]。半球の外は半球の縁へ寄せる。
function horizonAngle(slice: Slice, view: Vec3Node, toPoint: Vec3Node, side: FloatNode): FloatNode {
  const angle = side.mul(acos(clamp(dot(normalize(toPoint), view), -1, 1)));
  return clamp(angle, slice.normalAngle.sub(HALF_PI), slice.normalAngle.add(HALF_PI));
}

// 番号が count(0..SECTOR_COUNT の整数)より小さい扇形のビット。幅いっぱいのシフトは WGSL で使えないので、
// count = SECTOR_COUNT は別に返す。
function sectorsBelow(count: FloatNode): UintNode {
  const partial = uint(1).shiftLeft(uint(min(count, SECTOR_COUNT - 1))).sub(uint(1));
  return select(count.greaterThanEqual(SECTOR_COUNT), uint(0xffffffff), partial);
}

// bits の立っているビットの数。
function bitCount(bits: UintNode): FloatNode {
  // countOneBits の @types/three 上の戻り値型は値の型を持たないため、UintNode へ読み替える。
  return float(countOneBits(bits) as unknown as UintNode);
}
