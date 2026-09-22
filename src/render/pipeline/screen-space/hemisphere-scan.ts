// 受け手 1 画素のまわりの半球を、画面に写った近くの構造に対して走査する。答えるのは、環境光ごとに
// その光が占める向きのうち塞がれた測度と、その光が占める向きの測度と、遮る面が受け手へ返す光(照り返し)。
//
// 画面上の向き(スライス)を数本取り、それぞれ両側へ深度を引く。スライスの中の遮りは扇形のビットマスクで
// 持ち、深度の標本を一定の厚みの板とみなして、板が覆う扇形を立てる(Therrien, Levesque, Gilet 2023
// 「Screen Space Indirect Lighting with Visibility Bitmask」)。
import type * as THREE from 'three/webgpu';
import {
  If, Loop, acos, atan, clamp, cos, countOneBits, cross, dot, float, floor, getViewPosition, ivec2, length, max, min,
  normalize, pow, round, screenSize, screenUV, select, sign, sin, smoothstep, sqrt, textureLoad, uint, vec2, vec3, vec4,
} from 'three/tsl';
import { octDecodeNormal } from '../gbuffer';
import { viewRayAt } from '../view-ray';
import type { FloatNode, IntNode, Mat4Uniform, UintNode, Vec2Node, Vec3Node, Vec4Node } from '../../tsl-types';

// 遮りを探す距離 [m]。受け手からこれより遠い面は遮らない。
const WORLD_RADIUS = 4;
// 標本の寄与が 1 から 0 へ落ち始める距離 [m]。WORLD_RADIUS で遮りが急に途切れる段差を消す。
const FADE_START_DISTANCE = 3;
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
// 球冠を数える半角の下限 [rad]。塞がれ方の推定の角の分解能で、光の大きさではない — これより細い光の
// 塞がれ方は、その向きのまわりこの幅の塞がれ方として測る。0 なら広げない。
const MIN_CAP_ANGLE = 10 * Math.PI / 180;
// スライス 1 枚を刻む扇形の数。マスクの幅(uint のビット数)と一致させる。
const SECTOR_COUNT = 32;
const HALF_PI = Math.PI / 2;

// 受け手から見た球冠。direction は中心の向き(view 空間の単位ベクトル)、cosAngle は半角の余弦。
export interface Cap {
  readonly direction: Vec3Node;
  readonly cosAngle: FloatNode;
}

// 1 画素の半球を走査した結果。測度は余弦重みで、半球全体を 1 とする。
export interface HemisphereScan {
  // 塞がれた測度。x = 空全体、y・z = 球冠 0・1、w = ローブ。
  readonly occluded: Vec4Node;
  // 数える範囲の測度。x・y = 球冠 0・1、z = ローブ(空全体は 1)。
  readonly extent: Vec3Node;
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

// 走査の解像度で写した面 — 素の深度 depth と法線 normal(view 空間、oct 符号化)— の上で、いま描いている
// 画素を受け手として走査する。面の各画素は、寸法 gbufferSize [px] の G バッファのうちその画素が表す画素
// (gbufferUVOf)の値を持つ。projection / projectionInverse は実カメラの射影行列とその逆、sliceCount はスライスの
// 数、stepCount は片側の歩数、noise は画素ごとの 0..1 の組(x がスライスの回転、y が歩みのずれ)。caps は
// 塞がれ方を数える天体照の球冠、lobe は同じく鏡面のローブ(どれも受け手 1 画素から見た view 空間の向き)。
// radiance は同じ解像度の、面が放つ放射輝度(SUN_IRRADIANCE_1AU の目盛り)で、null なら照り返しを集めない。
// 面と同じ解像度の描画先へ描くこと。**Fn の中から呼ぶこと。**
export function scanHemisphere(
  depth: THREE.Texture, normal: THREE.Texture, gbufferSize: Vec2Node, projection: Mat4Uniform,
  projectionInverse: Mat4Uniform, sliceCount: IntNode, stepCount: IntNode, noise: Vec2Node,
  caps: readonly [Cap, Cap], lobe: Cap, radiance: THREE.Texture | null,
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
  // 球冠は面の値を読む式から組まれている。**走査へ入る前に変数へ置く** — 暗黙の LOD を持つ読みが
  // 分岐とループの中へ落ちると、シェーダを組めない。
  const planetCap: readonly [Cap, Cap] = [capVar(caps[0]), capVar(caps[1])];
  const specularCap = capVar(lobe);

  const occluded = vec4(0).toVar();
  const extent = vec3(0).toVar();
  const indirect = vec3(0).toVar();
  // 虚空(深度 0)と、半径が画面上で 1 画素に満たない受け手(天体の表面)は走査せず、1〜2 画素で効きを
  // 0 から 1 へ渡す。
  If(receiverDepth.greaterThan(0).and(radius.greaterThanEqual(1)), () => {
    const weightedOccluded = vec4(0).toVar();
    const weightedExtent = vec3(0).toVar();
    const weightedIndirect = vec3(0).toVar();
    const totalWeight = float(0).toVar();
    Loop({ start: 0, end: sliceCount, type: 'int', condition: '<' }, ({ i }) => {
      const slice = sliceAt(float(i).add(rotation).mul(Math.PI).div(float(sliceCount)), view, receiverNormal);
      // 光ごとの、このスライスの平面に掛かる向きの範囲。
      const planetRange: readonly [UintNode, UintNode] = [
        capSectors(slice, view, planetCap[0]).toVar(), capSectors(slice, view, planetCap[1]).toVar()];
      const specularRange = capSectors(slice, view, specularCap).toVar();
      const blocked = uint(0).toVar();
      // 新たに塞いだ扇形の数。空全体・球冠 0・1・ローブの順。
      const sliceOccluded = vec4(0).toVar();
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
              // 手前の標本に塞がれていなかった扇形。**OR する前に引く** — 遮りの後ろの遮りを二重に数えない。
              const newly = sectors.bitAnd(blocked.bitNot()).toVar();
              // 遠い標本の寄与を落とす重み。**ビットには掛けない** — 手前から奥へ歩むので、ビットを立てそこねると
              // 奥の標本が手前の遮りの後ろを塞ぎ直し、二重に数える。
              const fade = clamp(
                float(WORLD_RADIUS).sub(distance).div(WORLD_RADIUS - FADE_START_DISTANCE), 0, 1).toVar();
              sliceOccluded.addAssign(vec4(bitCount(newly), bitCount(newly.bitAnd(planetRange[0])),
                bitCount(newly.bitAnd(planetRange[1])), bitCount(newly.bitAnd(specularRange))).mul(fade));
              // 受け手へ面を向けた標本だけが光を返す。
              if (radiance !== null) {
                If(dot(octDecodeNormal(textureLoad(normal, ivec2(samplePixel)).rg), toFront).lessThan(0), () => {
                  const emitted = textureLoad(radiance, ivec2(samplePixel)).rgb;
                  sliceIndirect.addAssign(emitted.mul(bitCount(newly).mul(fade).div(SECTOR_COUNT)));
                });
              }
              blocked.assign(blocked.bitOr(sectors));
            });
          });
        });
      });
      // スライスの塞がれ方と範囲と照り返しを重みつきで積む。
      weightedOccluded.addAssign(sliceOccluded.mul(slice.weight));
      weightedExtent.addAssign(
        vec3(bitCount(planetRange[0]), bitCount(planetRange[1]), bitCount(specularRange)).mul(slice.weight));
      weightedIndirect.addAssign(sliceIndirect.mul(slice.weight));
      totalWeight.addAssign(slice.weight);
    });
    const reach = smoothstep(1, 2, radius);
    const weight = max(totalWeight, 1e-6).toVar();
    // 扇形の数を重みで均して SECTOR_COUNT で割ると、半球の余弦重みの測度に対する割合になる。
    occluded.assign(weightedOccluded.div(weight.mul(SECTOR_COUNT)).mul(reach));
    extent.assign(weightedExtent.div(weight.mul(SECTOR_COUNT)));
    // 扇形の測度の平均が余弦重みの割合なので、π を掛けると放射照度になる — 放射輝度 L の面が半球を塞げば π L。
    indirect.assign(weightedIndirect.mul(Math.PI).div(weight).mul(reach));
  });
  return { occluded, extent, indirect };
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
  const axis = normalize(cross(direction, view)).toVar();
  const projectedNormal = normal.sub(axis.mul(dot(normal, axis))).toVar();
  const projectedLength = length(projectedNormal).toVar();
  const cosNormal = clamp(dot(projectedNormal, view).div(max(projectedLength, 1e-6)), 0, 1).toVar();
  const normalAngle = sign(dot(orthoDirection, projectedNormal)).mul(acos(cosNormal)).toVar();
  const sinNormal = sin(normalAngle).toVar();
  const totalMeasure = cosNormal.add(normalAngle.mul(sinNormal)).toVar();
  return {
    screenDirection: vec2(direction.x, direction.y.negate()).toVar(),
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

// 視線から測った角 h を、スライスの半球の測度で 0..1 へ写した座標。扇形はこの座標で等分する。
function sectorCoordinate(slice: Slice, h: FloatNode): FloatNode {
  // 0 から h までの測度 sign(h)·¼(cos n − cos(2h − n) + 2h sin n)。
  const fromView = sign(h).mul(
    slice.cosNormal.sub(cos(h.mul(2).sub(slice.normalAngle))).add(h.mul(2).mul(slice.sinNormal)).mul(0.25),
  );
  return fromView.sub(slice.lowerMeasure).div(slice.totalMeasure);
}

// 球冠を変数へ置いたもの。
function capVar(cap: Cap): Cap {
  return { direction: cap.direction.toVar(), cosAngle: cap.cosAngle.toVar() };
}

// スライスの平面が球冠 cap を切る弧が覆う扇形のビット。半角は MIN_CAP_ANGLE まで広げる。平面が球冠を
// 外れていれば空。**Fn の中から呼ぶこと。**
function capSectors(slice: Slice, view: Vec3Node, cap: Cap): UintNode {
  const cosAngle = min(cap.cosAngle, Math.cos(MIN_CAP_ANGLE)).toVar();
  // 平面の法線の成分を落とすと弧の中心の向きになり、残った長さが弧の半幅を決める。
  const axisComponent = dot(cap.direction, slice.axis).toVar();
  const inPlane = sqrt(max(float(1).sub(axisComponent.mul(axisComponent)), 0)).toVar();
  const inPlaneDirection = cap.direction.sub(slice.axis.mul(axisComponent)).toVar();
  const center = atan(dot(inPlaneDirection, slice.orthoDirection), dot(inPlaneDirection, view)).toVar();
  // 弧の中心を半球の側へ寄せる。半球は π、弧は高々 π を占めるので、重なる区間は 1 つしかない。
  const shifted = center.add(round(slice.normalAngle.sub(center).div(2 * Math.PI)).mul(2 * Math.PI)).toVar();
  const halfWidth = acos(clamp(cosAngle.div(max(inPlane, 1e-6)), -1, 1)).toVar();
  const lowerEdge = slice.normalAngle.sub(HALF_PI).toVar();
  const upperEdge = slice.normalAngle.add(HALF_PI).toVar();
  const lower = round(sectorCoordinate(slice, clamp(shifted.sub(halfWidth), lowerEdge, upperEdge)).mul(SECTOR_COUNT));
  const upper = round(sectorCoordinate(slice, clamp(shifted.add(halfWidth), lowerEdge, upperEdge)).mul(SECTOR_COUNT));
  return select(inPlane.greaterThan(cosAngle), sectorsBelow(upper).bitAnd(sectorsBelow(lower).bitNot()), uint(0));
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
