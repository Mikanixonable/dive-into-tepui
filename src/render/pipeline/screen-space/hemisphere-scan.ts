// 受け手 1 画素のまわりの半球を、画面に写った近くの構造に対して一度だけ走査し、遠方の拡散光(一様な環境光と
// 天体照)のうち近くの構造に塞がれた照度と、塞いでいる面が返す照度(照り返し)の差を答える。
//
// 画面上の向き(スライス)を数本取り、それぞれ両側へ深度を引く。深度の標本 1 つは、画面上でその標本が受け持つ
// 区間に写る接平面の切片とみなし、スライスの中の遮りは扇形のビットマスクで持つ(Therrien, Levesque, Gilet 2023
// 「Screen Space Indirect Lighting with Visibility Bitmask」)。
import type * as THREE from 'three/webgpu';
import {
  If, Loop, abs, acos, atan, clamp, cos, countOneBits, cross, dot, float, floor, getViewPosition, ivec2, length, max,
  min, normalize, round, screenSize, screenUV, select, sign, sin, sqrt, textureLoad, uint, vec2, vec3, vec4,
} from 'three/tsl';
import { octDecodeNormal } from '../gbuffer';
import { viewRayAt } from '../view-ray';
import { signedDiffuseCorrection } from './diffuse-correction';
import type { PlanetCap } from '../lighting/planet-light-source';
import type { FloatNode, IntNode, Mat4Uniform, UintNode, Vec2Node, Vec3Node } from '../../tsl-types';

// 遮りを探す距離 [m]。受け手からこれより遠い面は遮らない。
const WORLD_RADIUS = 4;
// 受け手の画素の半幅 [走査の画素]。切片の端は受け手からこれ以上離して取る — その内側には受け手自身が写っている。
const HALF_PIXEL = 0.5;
// スライス 1 枚を刻む扇形の数。マスクの幅(uint のビット数)と一致させる。
const SECTOR_COUNT = 32;
const HALF_PI = Math.PI / 2;

// 受け手を照らす天体照 1 つ。cap は受け手から見た球冠(view 空間)、irradiance は近くの構造に遮られないときに
// 届く拡散照度(SUN_IRRADIANCE_1AU の目盛り)。
export interface PlanetIllumination {
  readonly cap: PlanetCap;
  readonly irradiance: Vec3Node;
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

// スライスの中の向きの区間を、扇形の座標(sectorPosition)で表したもの。lower ≤ upper。
interface SectorRange {
  readonly lower: FloatNode;
  readonly upper: FloatNode;
}

// 走査の解像度で描いている画素を受け手として、寸法 gbufferSize [px] の G バッファの素の深度 depth と法線 normal
// (view 空間、oct 符号化)を走査し、受け手の拡散照度の補正(照り返し − 塞がれた照度)を返す。受け手と標本は、
// 走査の画素が表す G バッファの画素(gbufferUVOf)の値を読む。projection / projectionInverse は実カメラの射影行列と
// その逆、sliceCount はスライスの数、stepCount は片側の歩数、noise は画素ごとの互いに独立な 0..1 の組(x が
// スライスの回転、y が歩みのずれ、z が扇形の端の丸めのずれ)。ambientIrradiance と planets は、近くの構造に
// 遮られないときに受け手へ届く一様な環境光の照度と天体照。radiance は走査と同じ解像度の、面が放つ放射輝度
// (SUN_IRRADIANCE_1AU の目盛り)で、null なら照り返しは 0。虚空と、半径が画面上で 1 画素以下の受け手は 0。
// **Fn の中から呼ぶこと。**
export function scanHemisphere(
  depth: THREE.Texture, normal: THREE.Texture, gbufferSize: Vec2Node, projection: Mat4Uniform,
  projectionInverse: Mat4Uniform, sliceCount: IntNode, stepCount: IntNode, noise: Vec3Node,
  ambientIrradiance: Vec3Node, planets: readonly PlanetIllumination[], radiance: THREE.Texture | null,
): Vec3Node {
  // 受け手。ループの中と外の両方から読むので、先に変数へ置く。視線は投影方式によらない形から取る。
  const pixel = floor(screenUV.mul(screenSize)).toVar();
  const uv = gbufferUVOf(pixel, gbufferSize).toVar();
  const receiverTexel = ivec2(floor(uv.mul(gbufferSize)));
  const receiverDepth = textureLoad(depth, receiverTexel).r.toVar();
  const position = getViewPosition(uv, receiverDepth, projectionInverse).toVar();
  const receiverNormal = octDecodeNormal(textureLoad(normal, receiverTexel).rg).toVar();
  const view = viewRayAt(projectionInverse, uv).direction.negate().toVar();
  const radius = screenRadius(position, projection).toVar();
  const rotation = noise.x.toVar();
  const jitter = noise.y.toVar();
  const dither = noise.z.toVar();
  // 遠方の光は面の値を読む式から組まれている。**走査へ入る前に変数へ置く** — 暗黙の LOD を持つ読みが
  // 分岐とループの中へ落ちると、シェーダを組めない。
  const ambient = ambientIrradiance.toVar();
  const planetVars: readonly PlanetIllumination[] = planets.map(({ cap, irradiance }) => ({
    cap: { direction: cap.direction.toVar(), cosAngle: cap.cosAngle.toVar() }, irradiance: irradiance.toVar(),
  }));
  const correction = vec3(0).toVar();
  If(receiverDepth.greaterThan(0).and(radius.greaterThan(1)), () => {
    // 塞がれた扇形の数と照り返しの、スライスの重みつきの和。天体照は、スライスごとの塞がれた割合を楔の重みで
    // 積んだ和と、その重みの和。
    const ambientSum = float(0).toVar();
    const bounceSum = vec3(0).toVar();
    const weightSum = float(0).toVar();
    const planetSums = planetVars.map((planet) => ({ planet, blocked: float(0).toVar(), wedge: float(0).toVar() }));
    // 歩みの割合 progress(0..stepCount)の画面上の距離 [走査の画素]。近くへ寄せる二乗の配分。
    const stepDistance = (progress: FloatNode): FloatNode => {
      const u = progress.div(float(stepCount));
      return u.mul(u).mul(radius);
    };
    Loop({ start: 0, end: sliceCount, type: 'int', condition: '<' }, ({ i }) => {
      const slice = sliceAt(float(i).add(rotation).mul(Math.PI).div(float(sliceCount)), view, receiverNormal);
      const slicePlanets = planetSums.map((sum) => ({
        sum, range: capRange(slice, view, sum.planet.cap, dither), blocked: float(0).toVar(),
      }));
      const blocked = uint(0).toVar();
      const sliceAmbient = float(0).toVar();
      const sliceBounce = vec3(0).toVar();
      // 両側へ、手前から奥の順に歩む。歩 k は画面上の区間 [(k/N)²·R, ((k+1)/N)²·R] を受け持ち、その中の 1 点を読む。
      Loop({ start: 0, end: 2, type: 'int', condition: '<' }, ({ i: sideIndex }) => {
        const screenStep = slice.screenDirection.mul(float(1).sub(float(sideIndex).mul(2))).div(screenSize).toVar();
        Loop({ start: 0, end: stepCount, type: 'int', condition: '<' }, ({ i: step }) => {
          // 標本は隣の画素から先を読む。
          const target = screenUV.add(screenStep.mul(max(stepDistance(float(step).add(jitter)), 1)));
          const samplePixel = floor(target.mul(screenSize)).toVar();
          const sampleUV = gbufferUVOf(samplePixel, gbufferSize).toVar();
          const sampleTexel = ivec2(floor(sampleUV.mul(gbufferSize)));
          const rawDepth = textureLoad(depth, sampleTexel).r;
          // 遮るのは、画面の中で面が写っている標本。
          const onScreen = target.x.greaterThanEqual(0).and(target.y.greaterThanEqual(0))
            .and(target.x.lessThan(1)).and(target.y.lessThan(1));
          If(onScreen.and(rawDepth.greaterThan(0)), () => {
            const sample = getViewPosition(sampleUV, rawDepth, projectionInverse).toVar();
            const toSample = sample.sub(position).toVar();
            const distance = length(toSample).toVar();
            If(distance.lessThanEqual(WORLD_RADIUS), () => {
              const sampleNormal = octDecodeNormal(textureLoad(normal, sampleTexel).rg).toVar();
              // 区間の両端を通る視線と標本の接平面の交点を結んだ切片が、受け手から張る角度の範囲。受け手の接平面より
              // 下は半球の縁へ寄る。
              const edgeAt = (progress: FloatNode): FloatNode => angleOf(slice, view, segmentEnd(
                uv.add(screenStep.mul(max(stepDistance(progress), HALF_PIXEL))), projectionInverse, sample,
                sampleNormal, position).sub(position));
              const near = edgeAt(float(step));
              const far = edgeAt(float(step).add(1));
              const own = angleOf(slice, view, toSample);
              const sectors = segmentSectors(
                sectorPosition(slice, min(min(near, far), own), dither),
                sectorPosition(slice, max(max(near, far), own), dither)).toVar();
              // 手前の標本に塞がれていなかった扇形。**OR する前に引く** — 遮りの後ろの遮りを二重に数えない。
              const newly = sectors.bitAnd(blocked.bitNot()).toVar();
              // 遠い標本の寄与を落とす重み。**ビットには掛けない** — 手前から奥へ歩むので、ビットを立てそこねると
              // 奥の標本が手前の遮りの後ろを塞ぎ直し、二重に数える。
              const reach = distance.div(WORLD_RADIUS);
              const falloff = max(float(1).sub(reach.mul(reach)), 0).toVar();
              const newlyMeasure = bitCount(newly).mul(falloff).toVar();
              sliceAmbient.addAssign(newlyMeasure);
              for (const planet of slicePlanets) {
                planet.blocked.addAssign(maskedMeasure(newly, planet.range).mul(falloff));
              }
              // 光を返すのは受け手へ面を向けた切片。その向きの境で、切片の張る角は 0 へ縮む。
              if (radiance !== null) {
                If(dot(sampleNormal, toSample).lessThan(0), () => {
                  sliceBounce.addAssign(textureLoad(radiance, ivec2(samplePixel)).rgb.mul(newlyMeasure));
                });
              }
              blocked.assign(blocked.bitOr(sectors));
            });
          });
        });
      });
      // スライスの塞がれ方と照り返しを重みつきで積む。天体照はスライスごとに球冠の幅で割った割合を、天体の
      // 方位の楔を代表する重みで積む。球冠の幅が 0 のスライスは重みも 0。
      ambientSum.addAssign(sliceAmbient.mul(slice.weight));
      bounceSum.addAssign(sliceBounce.mul(slice.weight));
      weightSum.addAssign(slice.weight);
      for (const { sum, range, blocked: sliceBlocked } of slicePlanets) {
        const width = range.upper.sub(range.lower).toVar();
        const wedge = select(width.greaterThan(0), wedgeWeight(slice, view, sum.planet.cap.direction, sliceCount),
          float(0)).toVar();
        sum.blocked.addAssign(sliceBlocked.div(max(width, 1e-6)).mul(wedge));
        sum.wedge.addAssign(wedge);
      }
    });
    // 扇形の数を重みで均して SECTOR_COUNT で割ると、半球の余弦重みの測度に対する割合になる。放射輝度 L の面が
    // 半球を塞げば照り返しは π L。
    const average = max(weightSum, 1e-6).mul(SECTOR_COUNT).toVar();
    const blockedIrradiance = ambient.mul(ambientSum.div(average)).toVar();
    for (const { planet, blocked, wedge } of planetSums) {
      blockedIrradiance.addAssign(planet.irradiance.mul(blocked.div(max(wedge, 1e-6))));
    }
    correction.assign(signedDiffuseCorrection(bounceSum.mul(Math.PI).div(average), blockedIrradiance));
  });
  return correction;
}

// いま描いている解像度の画素 pixel(整数座標)の中心を含む、寸法 gbufferSize [px] の G バッファの画素の中心の uv。
// **G バッファはこの uv で読み、深度から位置を戻すのもこの uv で行う** — 画素の角で読むと輪郭で虚空の値が
// 混ざり、読んだ画素と違う uv で位置を戻すと平らな面が自分自身を遮る。
export function gbufferUVOf(pixel: Vec2Node, gbufferSize: Vec2Node): Vec2Node {
  // 整数で割る — 解像度が半分なら画素の中心は G バッファの画素の境に乗り、浮動小数の floor では採る画素が
  // 画素ごとに揺れる。
  const texel = ivec2(pixel).mul(2).add(1).mul(ivec2(gbufferSize)).div(ivec2(screenSize).mul(2));
  return vec2(texel).add(0.5).div(gbufferSize);
}

// view 空間の点 position から WORLD_RADIUS 離れた点が、描いている画面の上で何画素離れて写るか。画面の対角より
// 遠くは読めないので、対角で頭打ちにする。透視でも平行投影でも同じ式で測る。
function screenRadius(position: Vec3Node, projection: Mat4Uniform): FloatNode {
  const center = projection.mul(vec4(position, 1));
  const edge = projection.mul(vec4(position.add(vec3(WORLD_RADIUS, 0, 0)), 1));
  const ndcOffset = edge.xy.div(edge.w).sub(center.xy.div(center.w));
  return min(length(ndcOffset.mul(screenSize).mul(0.5)), length(screenSize));
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

// 受け手から toPoint(view 空間)の向きの、視線から測った角 [rad]。半球の外は半球の縁へ寄せる。
export function angleOf(slice: Slice, view: Vec3Node, toPoint: Vec3Node): FloatNode {
  return clamp(atan(dot(toPoint, slice.orthoDirection), dot(toPoint, view)),
    slice.normalAngle.sub(HALF_PI), slice.normalAngle.add(HALF_PI));
}

// 標本 sample の接平面(法線 sampleNormal)と uv を通る視線の交点を、受け手 receiver 中心・半径 WORLD_RADIUS の
// 球の内側へ、標本から交点へ向かう線分の上で切った点(view 空間)。視線が接平面と平行か、交点が視線の起点
// (近平面)より手前にあれば標本の位置。sample は球の内側にあること。
export function segmentEnd(
  uv: Vec2Node, projectionInverse: Mat4Uniform, sample: Vec3Node, sampleNormal: Vec3Node, receiver: Vec3Node,
): Vec3Node {
  const ray = viewRayAt(projectionInverse, uv);
  const facing = dot(sampleNormal, ray.direction).toVar();
  const parallel = abs(facing).lessThan(1e-6);
  const along = dot(sampleNormal, sample.sub(ray.origin)).div(select(parallel, float(1), facing)).toVar();
  const hit = select(parallel.or(along.lessThanEqual(0)), sample, ray.origin.add(ray.direction.mul(along)));
  // |offset + s·span| = WORLD_RADIUS の正の根 s。
  const offset = sample.sub(receiver).toVar();
  const span = hit.sub(sample).toVar();
  const offsetAlongSpan = dot(offset, span).toVar();
  const spanSqr = dot(span, span).toVar();
  const discriminant = offsetAlongSpan.mul(offsetAlongSpan)
    .sub(spanSqr.mul(dot(offset, offset).sub(WORLD_RADIUS * WORLD_RADIUS)));
  const exit = offsetAlongSpan.negate().add(sqrt(max(discriminant, 0))).div(max(spanSqr, 1e-12));
  return sample.add(span.mul(min(exit, 1)));
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
export function capRange(slice: Slice, view: Vec3Node, cap: PlanetCap, dither: FloatNode): SectorRange {
  const projected = cap.direction.sub(slice.axis.mul(dot(cap.direction, slice.axis))).toVar();
  const center = atan(dot(projected, slice.orthoDirection), dot(projected, view)).toVar();
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
export function wedgeWeight(slice: Slice, view: Vec3Node, direction: Vec3Node, sliceCount: IntNode): FloatNode {
  const across = direction.sub(view.mul(dot(direction, view))).toVar();
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
function bitCount(bits: UintNode): FloatNode {
  // countOneBits の @types/three 上の戻り値型は値の型を持たないため、UintNode へ読み替える。
  return float(countOneBits(bits) as unknown as UintNode);
}
