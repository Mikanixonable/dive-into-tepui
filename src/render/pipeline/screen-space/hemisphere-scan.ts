// 受け手 1 画素のまわりの半球を、画面に写った近くの構造に対して走査する。答えるのは、余弦重みで測った
// 遮られない割合(可視率)と、遮られない向きの平均(曲げた法線)と、遮る面が受け手へ返す光(照り返し)。
//
// 画面上の向き(スライス)を数本取り、それぞれ両側へ深度を引く。スライスの中の遮りは扇形のビットマスクで
// 持ち、深度の標本を一定の厚みの板とみなして、板が覆う扇形を立てる(Therrien, Levesque, Gilet 2023
// 「Screen Space Indirect Lighting with Visibility Bitmask」)。
import type * as THREE from 'three/webgpu';
import {
  If, Loop, acos, clamp, cos, countOneBits, cross, dot, float, floor, getViewPosition, ivec2, length, max, min, mix,
  normalize, pow, round, screenSize, screenUV, select, sign, sin, smoothstep, textureLoad, uint, vec2, vec3, vec4,
} from 'three/tsl';
import { octDecodeNormal } from '../gbuffer';
import { viewRayAt } from '../view-ray';
import type { FloatNode, IntNode, Mat4Uniform, UintNode, Vec2Node, Vec3Node } from '../../tsl-types';

// 遮りを探す距離 [m]。受け手からこれより遠い面は遮らない。
const WORLD_RADIUS = 4;
// 深度の標本 1 つが奥へ占める厚み [m]。標本は疎らなので、同じ面の上で隣り合う標本の間の扇形は板が奥へ覆って
// 埋める — 薄くすると壁の足元や内隅の遮りが抜け、厚くすると細い梁が奥の空まで塞ぐ。
const SLAB_THICKNESS = 1.5;
// 歩みの刻みの分布の指数。1 より大きいほど標本を受け手の近くへ寄せる。
const STEP_DISTRIBUTION_EXPONENT = 1.25;
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
  // 遮る面が受け手へ返す光の放射照度(SUN_IRRADIANCE_1AU の目盛り)。照り返しを集めない走査では 0。
  readonly indirect: Vec3Node;
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
// 画素を受け手として走査する。面の各画素は、寸法 gbufferSize [px] の G バッファのうちその画素が表す画素
// (gbufferUVOf)の値を持つ。projection / projectionInverse は実カメラの射影行列とその逆、sliceCount はスライスの
// 数、stepCount は片側の歩数、noise は画素ごとの 0..1 の組(x がスライスの回転、y が歩みのずれ)。radiance は
// 同じ解像度の、面が放つ放射輝度(SUN_IRRADIANCE_1AU の目盛り)で、null なら照り返しを集めない。面と同じ
// 解像度の描画先へ描くこと。**Fn の中から呼ぶこと。**
export function scanHemisphere(
  depth: THREE.Texture, normal: THREE.Texture, gbufferSize: Vec2Node, projection: Mat4Uniform,
  projectionInverse: Mat4Uniform, sliceCount: IntNode, stepCount: IntNode, noise: Vec2Node,
  radiance: THREE.Texture | null,
): HemisphereScan {
  // 受け手。ループの中と外の両方から読むので、先に変数へ置く。視線は投影方式によらない形から取る。
  const pixel = floor(screenUV.mul(screenSize)).toVar();
  const uv = gbufferUVOf(pixel, gbufferSize).toVar();
  const receiverDepth = textureLoad(depth, ivec2(pixel)).r.toVar();
  const position = getViewPosition(uv, receiverDepth, projectionInverse).toVar();
  const receiverNormal = octDecodeNormal(textureLoad(normal, ivec2(pixel)).rg).toVar();
  const view = viewRayAt(projectionInverse, uv).direction.negate().toVar();
  const radius = screenRadius(position, projection).toVar();
  const rotation = noise.x.toVar();
  const jitter = noise.y.toVar();

  const visibility = float(1).toVar();
  const bentNormal = receiverNormal.toVar();
  const indirect = vec3(0).toVar();
  // 虚空(深度 0)と、半径が画面上で 1 画素に満たない受け手(天体の表面)は走査せず、1〜2 画素で効きを
  // 0 から 1 へ渡す。
  If(receiverDepth.greaterThan(0).and(radius.greaterThanEqual(1)), () => {
    const weightedVisibility = float(0).toVar();
    const totalWeight = float(0).toVar();
    const bentSum = vec3(0).toVar();
    const weightedIndirect = vec3(0).toVar();
    Loop({ start: 0, end: sliceCount, type: 'int', condition: '<' }, ({ i }) => {
      const slice = sliceAt(float(i).add(rotation).mul(Math.PI).div(float(sliceCount)), view, receiverNormal);
      const occluded = uint(0).toVar();
      // スライスの扇形ごとに、その扇形を最初に塞いだ面が返す放射輝度 × 扇形の余弦重みの測度の和。
      const sliceIndirect = vec3(0).toVar();
      // 両側へ、手前から奥の順に歩む。同じ画素は読まない。
      Loop({ start: 0, end: 2, type: 'int', condition: '<' }, ({ i: sideIndex }) => {
        const side = float(1).sub(float(sideIndex).mul(2)).toVar();
        Loop({ start: 0, end: stepCount, type: 'int', condition: '<' }, ({ i: step }) => {
          const progress = float(step).add(jitter).div(float(stepCount));
          const offset = max(pow(progress, STEP_DISTRIBUTION_EXPONENT).mul(radius), 1);
          const target = screenUV.add(slice.screenDirection.mul(side.mul(offset)).div(screenSize));
          const samplePixel = floor(target.mul(screenSize)).toVar();
          const rawDepth = textureLoad(depth, ivec2(samplePixel)).r;
          // 画面の外の標本と虚空(深度 0)の標本は遮らない。
          const onScreen = target.x.greaterThanEqual(0).and(target.y.greaterThanEqual(0))
            .and(target.x.lessThan(1)).and(target.y.lessThan(1));
          If(onScreen.and(rawDepth.greaterThan(0)), () => {
            const toFront = getViewPosition(gbufferUVOf(samplePixel, gbufferSize), rawDepth, projectionInverse)
              .sub(position).toVar();
            const distance = length(toFront);
            // 接平面の上に出ていない標本は遮らない — 板はそこから奥へ、さらに低く伸びる。画素の中心へ寄せた
            // 標本はスライスの平面から外れるので、受け手と同じ平面の上でも視線からの角が縁の内側へ入る。
            const aboveTangent = dot(toFront, receiverNormal).greaterThan(distance.mul(MIN_ELEVATION));
            If(distance.lessThanEqual(WORLD_RADIUS).and(aboveTangent), () => {
              const sectors = slabSectors(slice, view, toFront, side).toVar();
              // 受け手へ面を向けた標本が、手前の標本に塞がれていなかった扇形から光を返す。**OR する前に引く**
              // — 遮りの後ろの遮りを二重に数えない。
              if (radiance !== null) {
                If(dot(octDecodeNormal(textureLoad(normal, ivec2(samplePixel)).rg), toFront).lessThan(0), () => {
                  const newlyOccluded = sectors.bitAnd(occluded.bitNot());
                  const emitted = textureLoad(radiance, ivec2(samplePixel)).rgb;
                  sliceIndirect.addAssign(emitted.mul(bitCount(newlyOccluded).div(SECTOR_COUNT)));
                });
              }
              occluded.assign(occluded.bitOr(sectors));
            });
          });
        });
      });
      // スライスの可視率と、遮られない向きと、照り返しを重みつきで積む。
      const unoccluded = occluded.bitNot().toVar();
      const openCount = bitCount(unoccluded).toVar();
      const sliceVisibility = openCount.div(SECTOR_COUNT);
      weightedVisibility.addAssign(slice.weight.mul(sliceVisibility));
      weightedIndirect.addAssign(sliceIndirect.mul(slice.weight));
      totalWeight.addAssign(slice.weight);
      If(openCount.greaterThan(0), () => {
        const openAngle = angleOfCoordinate(slice, meanSectorCoordinate(unoccluded, openCount));
        const openDirection = view.mul(cos(openAngle)).add(slice.orthoDirection.mul(sin(openAngle)));
        bentSum.addAssign(openDirection.mul(slice.weight.mul(sliceVisibility)));
      });
    });
    const reach = smoothstep(1, 2, radius);
    const hasWeight = totalWeight.greaterThan(1e-6);
    const scanned = select(hasWeight, weightedVisibility.div(max(totalWeight, 1e-6)), float(1));
    const bentLength = length(bentSum);
    const scannedBent = select(bentLength.greaterThan(1e-6), bentSum.div(max(bentLength, 1e-6)), receiverNormal);
    // 扇形の測度の平均が余弦重みの割合なので、π を掛けると放射照度になる — 放射輝度 L の面が半球を塞げば π L。
    const scannedIndirect = select(hasWeight, weightedIndirect.mul(Math.PI).div(max(totalWeight, 1e-6)), vec3(0));
    visibility.assign(mix(float(1), scanned, reach));
    bentNormal.assign(normalize(mix(receiverNormal, scannedBent, reach)));
    indirect.assign(scannedIndirect.mul(reach));
  });
  return { visibility, bentNormal, indirect };
}

// いま描いている解像度の画素 pixel(整数座標)が表す、寸法 gbufferSize [px] の G バッファの画素の中心の uv。
// **G バッファはこの uv で読み、深度から位置を戻すのもこの uv で行う** — 画素の角で読むと輪郭で虚空の値が
// 混ざり、読んだ画素と違う uv で位置を戻すと平らな面が自分自身を遮る。
export function gbufferUVOf(pixel: Vec2Node, gbufferSize: Vec2Node): Vec2Node {
  return floor(pixel.add(0.5).mul(gbufferSize).div(screenSize)).add(0.5).div(gbufferSize);
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
