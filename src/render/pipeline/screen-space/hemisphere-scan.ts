// 受け手 1 画素のまわりの半球を、画面に写った近くの構造に対して一度だけ走査し、遠方の拡散光(一様な環境光と
// 天体照)のうち近くの構造に塞がれた照度と、塞いでいる面が返す照度(照り返し)の差を答える。
//
// 画面上の向き(スライス)を数本取り、それぞれ両側へ深度を引く。深度の標本 1 つは、画面上で隣り合う標本との
// あいだを受け持つ接平面の切片とみなし、スライスの中の遮りは扇形のビットマスクで持つ(Therrien, Levesque, Gilet
// 2023「Screen Space Indirect Lighting with Visibility Bitmask」)。
import type * as THREE from 'three/webgpu';
import {
  If, Loop, bool, dot, float, floor, getViewPosition, ivec2, length, max, min, screenSize, screenUV, select,
  smoothstep, sqrt, textureLoad, uint, vec2, vec3, vec4,
} from 'three/tsl';
import { octDecodeNormal } from '../gbuffer';
import { viewRayAt } from '../view-ray';
import { signedDiffuseCorrection } from './diffuse-correction';
import {
  SECTOR_COUNT, angleOf, bitCount, capRange, maskedMeasure, rangeSectors, sectorPosition, segmentSectors, sliceAt,
  toSliceCoordinates, wedgeWeight, type RangeSectors, type SectorRange, type Slice,
} from './slice-sectors';
import {
  angularlyHigher, angularlyLower, rayAt, sideRays, splitSegments, tangentHit, type SideRays, type SlicePoint,
} from './tangent-segments';
import type { PlanetCap } from '../lighting/planet-light-source';
import type {
  BoolNode, FloatNode, IntNode, Mat4Uniform, Vec2Node, Vec3Node,
} from '../../tsl-types';

// 遮りを探す距離 [m]。受け手からこれより遠い面は遮らない。
const WORLD_RADIUS = 4;

// 受け手を照らす天体照 1 つ。cap は受け手から見た球冠(view 空間)、irradiance は近くの構造に遮られないときに
// 届く拡散照度(SUN_IRRADIANCE_1AU の目盛り)。
export interface PlanetIllumination {
  readonly cap: PlanetCap;
  readonly irradiance: Vec3Node;
}

// 天体 1 つの、受け手の画素での塞がれ方の和 — スライスごとの塞がれた割合を楔の重みで積んだ和 blocked と、
// その重みの和 wedge。
interface PlanetSum {
  readonly planet: PlanetIllumination;
  readonly blocked: FloatNode;
  readonly wedge: FloatNode;
}

// G バッファの画素 1 つの面(view 空間)。depth は素の深度で、0 なら面が写っていない。
interface GBufferSurface {
  readonly uv: Vec2Node;
  readonly depth: FloatNode;
  readonly position: Vec3Node;
  readonly normal: Vec3Node;
}

// 走査の解像度で描いている画素を受け手として、寸法 gbufferSize [px] の G バッファの素の深度 depth と法線 normal
// (view 空間、oct 符号化)を走査し、受け手の拡散照度の補正(照り返し − 塞がれた照度)を返す。受け手と標本は、
// 走査の画素が表す G バッファの画素(gbufferUVOf)の値を読む。projection / projectionInverse は実カメラの射影行列と
// その逆、sliceCount はスライスの数、stepCount は片側の歩数、noise は画素ごとの互いに独立な 0..1 の組(x が
// スライスの回転、y が歩みのずれ、z が扇形の端の丸めのずれ)。ambientIrradiance と planets は、近くの構造に
// 遮られないときに受け手へ届く一様な環境光の照度と天体照。radiance は走査と同じ解像度の、面が放つ放射輝度
// (SUN_IRRADIANCE_1AU の目盛り)で、null なら照り返しは 0。resolvesNearby が偽の受け手は 0。
// **Fn の中から呼ぶこと。** noise・ambientIrradiance・planets は一様でない分岐の中で読むので、テクスチャを段を
// 明示して読む式で渡すこと。
export function scanHemisphere(
  depth: THREE.Texture, normal: THREE.Texture, gbufferSize: Vec2Node, projection: Mat4Uniform,
  projectionInverse: Mat4Uniform, sliceCount: IntNode, stepCount: IntNode, noise: Vec3Node,
  ambientIrradiance: Vec3Node, planets: readonly PlanetIllumination[], radiance: THREE.Texture | null,
): Vec3Node {
  // 受け手。ループの中と外の両方から読むので、先に変数へ置く。
  const receiver = surfaceAt(depth, normal, gbufferSize, projectionInverse, floor(screenUV.mul(screenSize)));
  const radius = projectedRadius(receiver.position, projection, screenSize).toVar();
  const correction = vec3(0).toVar();
  If(resolvesNearby(receiver.depth, radius), () => {
    // 視線は投影方式によらない形から取る。
    const view = viewRayAt(projectionInverse, receiver.uv).direction.negate().toVar();
    const rotation = noise.x.toVar();
    const jitter = noise.y.toVar();
    const dither = noise.z.toVar();
    // 遠方の光は面の値を読む式から組まれている。**ループへ入る前に変数へ置く** — ループの中で初めて組むと、
    // スライスごとに面を読み直し、ループの後の照度もループの中で読んだ値に頼る。
    const ambient = ambientIrradiance.toVar();
    const planetVars: readonly PlanetIllumination[] = planets.map(({ cap, irradiance }) => ({
      cap: { direction: cap.direction.toVar(), cosAngle: cap.cosAngle.toVar() }, irradiance: irradiance.toVar(),
    }));
    // 塞がれた扇形の数と照り返しの、スライスの重みつきの和。
    const ambientSum = float(0).toVar();
    const bounceSum = vec3(0).toVar();
    const weightSum = float(0).toVar();
    const planetSums: readonly PlanetSum[] = planetVars.map((planet) => ({
      planet, blocked: float(0).toVar(), wedge: float(0).toVar(),
    }));
    // 歩みの割合 progress(0..stepCount)の画面上の距離 [走査の画素]。近くへ寄せる二乗の配分。
    const stepDistance = (progress: FloatNode): FloatNode => {
      const u = progress.div(float(stepCount));
      return u.mul(u).mul(radius);
    };
    Loop({ start: 0, end: sliceCount, type: 'int', condition: '<' }, ({ i }) => {
      const slice = sliceAt(float(i).add(rotation).mul(Math.PI).div(float(sliceCount)), view, receiver.normal);
      const occlusion = new SliceOcclusion(slice, planetSums, dither, radiance);
      // 受け手自身は、スライスの座標の原点にある、受け手の接平面の点。標本と同じ式で法線を写す — 同じ平面の標本と
      // 法線が一致しないと、平行なはずの 2 直線の交点を拾う。
      const receiverInSlice: SlicePoint = {
        position: vec2(0), normal: toSliceCoordinates(slice, receiver.normal).toVar(), offset: float(0),
      };
      const forwardRays = sideRays(slice, receiver.position, receiver.uv, slice.screenDirection.div(screenSize),
        projectionInverse);
      // 両側へ、手前から奥の順に歩む。歩 k の標本は画面上の区間 [(k/N)²·R, ((k+1)/N)²·R] の中の 1 点。
      Loop({ start: 0, end: 2, type: 'int', condition: '<' }, ({ i: sideIndex }) => {
        const sideSign = float(1).sub(float(sideIndex).mul(2)).toVar();
        const screenStep = slice.screenDirection.mul(sideSign).div(screenSize).toVar();
        // 反対側の視線は、ρ の一次式の歩みの項の符号を変えたもの。
        const rays: SideRays = {
          origin: forwardRays.origin,
          originStep: forwardRays.originStep.mul(sideSign).toVar(),
          direction: forwardRays.direction,
          directionStep: forwardRays.directionStep.mul(sideSign).toVar(),
        };
        const walk = new SideWalk(slice, screenStep, rays, occlusion, receiverInSlice);
        Loop({ start: 0, end: stepCount, type: 'int', condition: '<' }, ({ i: step }) => {
          // 標本は隣の画素から先を読む — 受け手との中点が、受け手の画素の外に出る。
          const rho = max(stepDistance(float(step).add(jitter)), 1).toVar();
          const samplePixel = pixelAlong(screenStep, rho).toVar();
          const sample = surfaceAt(depth, normal, gbufferSize, projectionInverse, samplePixel);
          const toSample = sample.position.sub(receiver.position).toVar();
          // 遮るのは、画面の中で面が写っている、受け手から半径の内側の標本。
          const onScreen = samplePixel.x.greaterThanEqual(0).and(samplePixel.y.greaterThanEqual(0))
            .and(samplePixel.x.lessThan(screenSize.x)).and(samplePixel.y.lessThan(screenSize.y));
          const surface = onScreen.and(sample.depth.greaterThan(0))
            .and(dot(toSample, toSample).lessThanEqual(WORLD_RADIUS * WORLD_RADIUS));
          walk.visit(rho, surface, toSample, sample.normal);
        });
        walk.finish(radius);
      });
      // スライスの塞がれ方と照り返しを重みつきで積む。天体照はスライスごとに球冠の幅で割った割合を、天体の
      // 方位の楔を代表する重みで積む。球冠の幅が 0 のスライスは重みも 0。
      ambientSum.addAssign(occlusion.ambient.mul(slice.weight));
      bounceSum.addAssign(occlusion.bounce.mul(slice.weight));
      weightSum.addAssign(slice.weight);
      for (const { sum, range, blocked } of occlusion.planets) {
        const width = range.upper.sub(range.lower).toVar();
        const wedge = select(width.greaterThan(0), wedgeWeight(slice, sum.planet.cap.direction, sliceCount), float(0))
          .toVar();
        sum.blocked.addAssign(blocked.div(max(width, 1e-6)).mul(wedge));
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
    // 半径が 1〜2 画素に写る受け手では、効きを 0 から 1 へ渡す — 走査を打ち切る 1 画素で補正が段を作らない。
    correction.assign(signedDiffuseCorrection(bounceSum.mul(Math.PI).div(average), blockedIrradiance)
      .mul(smoothstep(1, 2, radius)));
  });
  return correction;
}

// 受け手の近くを走査するか — 面が写っていて(素の深度 depth > 0)、半径が走査の画面へ 1 画素より大きく写る
// (projectedRadius の radius > 1)。偽の受け手の補正は 0 で、その画素の照り返しの源も要らない。
export function resolvesNearby(depth: FloatNode, radius: FloatNode): BoolNode {
  return depth.greaterThan(0).and(radius.greaterThan(1));
}

// view 空間の点 position から WORLD_RADIUS 離れた点が、寸法 scanSize [px] の走査の画面の上で何画素離れて写るか。
// 画面の対角より遠くは読めないので、対角で頭打ちにする。透視でも平行投影でも同じ式で測る。
export function projectedRadius(position: Vec3Node, projection: Mat4Uniform, scanSize: Vec2Node): FloatNode {
  const center = projection.mul(vec4(position, 1));
  const edge = projection.mul(vec4(position.add(vec3(WORLD_RADIUS, 0, 0)), 1));
  const ndcOffset = edge.xy.div(edge.w).sub(center.xy.div(center.w));
  return min(length(ndcOffset.mul(scanSize).mul(0.5)), length(scanSize));
}

// 走査の解像度の画素 pixel(整数座標)が表す G バッファの画素の面。面が写っていない画素の法線は (0, 0, 1)。
function surfaceAt(
  depth: THREE.Texture, normal: THREE.Texture, gbufferSize: Vec2Node, projectionInverse: Mat4Uniform,
  pixel: Vec2Node,
): GBufferSurface {
  const texel = gbufferTexelOf(pixel, gbufferSize).toVar();
  const uv = texelCenterUV(texel, gbufferSize).toVar();
  const rawDepth = textureLoad(depth, texel).r.toVar();
  const surfaceNormal = vec3(0, 0, 1).toVar();
  If(rawDepth.greaterThan(0), () => {
    surfaceNormal.assign(octDecodeNormal(textureLoad(normal, texel).rg));
  });
  const position = getViewPosition(uv, rawDepth, projectionInverse).toVar();
  return { uv, depth: rawDepth, position, normal: surfaceNormal };
}

// 受け手の画素から、画面上の歩み screenStep [uv/走査の画素] の向きへ画面距離 rho だけ進んだ点を含む、走査の画素
// (整数座標)。
function pixelAlong(screenStep: Vec2Node, rho: FloatNode): Vec2Node {
  return floor(screenUV.add(screenStep.mul(rho)).mul(screenSize));
}

// スライス 1 枚の遮り。手前から奥の順に渡される切片を扇形のビットへ立て、新しく塞いだ扇形の測度を積む。
// **スライスのループの本体で作ること** — 積算の変数をそこへ置く。
class SliceOcclusion {
  // 塞がれた扇形。
  private readonly blocked = uint(0).toVar();
  // 新しく塞いだ扇形の数に距離重みを掛けた和と、それに照り返しの源の放射輝度を掛けた和。
  public readonly ambient = float(0).toVar();
  public readonly bounce = vec3(0).toVar();
  // 天体ごとの、球冠の範囲とそれをビットごとに測る形、その中で新しく塞いだ測度に距離重みを掛けた和。sum は受け手の
  // 画素での和。
  public readonly planets: readonly {
    readonly sum: PlanetSum;
    readonly range: SectorRange;
    readonly sectors: RangeSectors;
    readonly blocked: FloatNode;
  }[];

  // dither は扇形の端の丸めのずれ、radiance は照り返しの源の放射輝度(null なら照り返しを積まない)。
  public constructor(
    private readonly slice: Slice, planetSums: readonly PlanetSum[], private readonly dither: FloatNode,
    private readonly radiance: THREE.Texture | null,
  ) {
    this.planets = planetSums.map((sum) => {
      const range = capRange(slice, sum.planet.cap, dither);
      return { sum, range, sectors: rangeSectors(range), blocked: float(0).toVar() };
    });
  }

  // 受け手から見て角 lower..upper を占める切片を、手前の切片の後ろへ積む。falloff はその標本の距離重み、
  // facesReceiver は標本が受け手へ面を向けているか、pixel は標本の走査の画素。
  public add(lower: FloatNode, upper: FloatNode, falloff: FloatNode, facesReceiver: BoolNode, pixel: Vec2Node): void {
    const sectors = segmentSectors(
      sectorPosition(this.slice, lower, this.dither), sectorPosition(this.slice, upper, this.dither)).toVar();
    // 手前の切片に塞がれていなかった扇形。**OR する前に引く** — 遮りの後ろの遮りを二重に数えない。
    const newly = sectors.bitAnd(this.blocked.bitNot()).toVar();
    this.blocked.assign(this.blocked.bitOr(sectors));
    If(newly.notEqual(uint(0)), () => {
      // 距離重みは**ビットには掛けない** — 手前から奥へ歩むので、ビットを立てそこねると奥の標本が手前の遮りの
      // 後ろを塞ぎ直し、二重に数える。
      const newlyMeasure = bitCount(newly).mul(falloff).toVar();
      this.ambient.addAssign(newlyMeasure);
      for (const planet of this.planets) planet.blocked.addAssign(maskedMeasure(newly, planet.sectors).mul(falloff));
      // 光を返すのは受け手へ面を向けた切片。その向きの境で、切片の張る角は 0 へ縮む。
      const radiance = this.radiance;
      if (radiance !== null) {
        If(facesReceiver, () => {
          this.bounce.addAssign(textureLoad(radiance, ivec2(pixel)).rgb.mul(newlyMeasure));
        });
      }
    });
  }
}

// スライスの片側を受け手から奥へ歩む。隣り合う標本のあいだを両者の接平面で分け(splitSegments)、切片の上端が
// 決まった標本から occlusion へ積む。最初の「直前の標本」は受け手自身で、受け手の切片は積まない。
// **片側のループの本体で作ること** — 次の標本まで持ち越す変数をそこへ置く。
class SideWalk {
  // 直前の標本の面の点・画面距離 [走査の画素] と、面を持つか。受け手自身は画面距離 0 の、面を持つ点。
  private readonly previous: SlicePoint;
  private readonly previousRho = float(0).toVar();
  private readonly previousHasSurface = bool(true).toVar();
  // 直前の標本の切片の下端(円で切った点)と距離重み。上端は次の標本で決まる。
  private readonly previousLower = vec2(0).toVar();
  private readonly previousFalloff = float(0).toVar();

  // screenStep はこの側の画面上の歩み [uv/走査の画素]、rays はこの側の視線、occlusion は切片を積むスライスの遮り、
  // receiver は最初の「直前の標本」とする受け手自身。
  public constructor(
    private readonly slice: Slice, private readonly screenStep: Vec2Node, private readonly rays: SideRays,
    private readonly occlusion: SliceOcclusion, receiver: SlicePoint,
  ) {
    this.previous = {
      position: receiver.position.toVar(), normal: receiver.normal.toVar(), offset: receiver.offset.toVar(),
    };
  }

  // 画面距離 rho の標本を次に加える。toSample は受け手から標本への変位、normal は標本の法線(view 空間)。hasSurface
  // が偽なら面のない標本(虚空・画面外・半径の外)で、切片を持たない。
  public visit(rho: FloatNode, hasSurface: BoolNode, toSample: Vec3Node, normal: Vec3Node): void {
    // 接平面の直線は標本の 3 次元の位置から引く — 画素へ丸めた標本はスライス平面の外にあり、射影した位置を通る
    // 直線では、同じ面の隣り合う標本の切片が継ぎ目でずれる。
    const sample: SlicePoint = {
      position: toSliceCoordinates(this.slice, toSample).toVar(),
      normal: toSliceCoordinates(this.slice, normal).toVar(),
      offset: dot(normal, toSample).toVar(),
    };
    const split = splitSegments(this.rays, this.previous, this.previousRho, sample, rho,
      this.previousHasSurface.and(hasSurface));
    // 分岐の外で変数へ置く — 両端が共有する式を分岐の中で初めて組むと、外から読めない。
    const nearUpper = split.nearUpper.toVar();
    const farLower = split.farLower.toVar();
    // 直前の標本の切片は、上端が決まったので積む。
    If(this.holdsSegment(), () => this.closeSegment(nearUpper));
    // この標本を直前の標本として持ち越す。面がなければ、持ち越した値は旗で読まれない。
    this.previousLower.assign(clipToCircle(sample.position, farLower));
    this.previousFalloff.assign(max(float(1).sub(dot(toSample, toSample).div(WORLD_RADIUS * WORLD_RADIUS)), 0));
    this.previous.position.assign(sample.position);
    this.previous.normal.assign(sample.normal);
    this.previous.offset.assign(sample.offset);
    this.previousRho.assign(rho);
    this.previousHasSurface.assign(hasSurface);
  }

  // 最後の標本の切片を、画面距離 radius [走査の画素] の視線まで受け持たせて積む。
  public finish(radius: FloatNode): void {
    If(this.holdsSegment(), () => this.closeSegment(tangentHit(rayAt(this.rays, radius), this.previous)));
  }

  // 直前の標本が、上端を待つ切片を持つか — 面を持つ標本であって、受け手自身でない。
  private holdsSegment(): BoolNode {
    return this.previousHasSurface.and(this.previousRho.greaterThan(0));
  }

  // 直前の標本の切片を、上端 end(円で切る前)で閉じて積む。角の範囲は、下端・上端・標本自身の角の最小〜最大。
  private closeSegment(end: Vec2Node): void {
    const { position, offset } = this.previous;
    const upper = clipToCircle(position, end).toVar();
    const lowest = angularlyLower(angularlyLower(this.previousLower, position), upper);
    const highest = angularlyHigher(angularlyHigher(this.previousLower, position), upper);
    this.occlusion.add(angleOf(this.slice, lowest), angleOf(this.slice, highest), this.previousFalloff,
      offset.lessThan(0), pixelAlong(this.screenStep, this.previousRho));
  }
}

// 受け手を中心とする半径 WORLD_RADIUS の円の内側の点 from から、点 end へ向かう線分を円の内側で切った先の点
// (スライスの座標)。
export function clipToCircle(from: Vec2Node, end: Vec2Node): Vec2Node {
  // |from + s·span| = WORLD_RADIUS の正の根 s。
  const span = end.sub(from).toVar();
  const fromAlongSpan = dot(from, span).toVar();
  const spanSqr = dot(span, span).toVar();
  const discriminant = fromAlongSpan.mul(fromAlongSpan)
    .sub(spanSqr.mul(dot(from, from).sub(WORLD_RADIUS * WORLD_RADIUS)));
  const exit = fromAlongSpan.negate().add(sqrt(max(discriminant, 0))).div(max(spanSqr, 1e-12));
  return from.add(span.mul(min(exit, 1)));
}

// いま描いている解像度の画素 pixel(整数座標)の中心を含む、寸法 gbufferSize [px] の G バッファの画素の中心の uv。
// **G バッファはこの画素(gbufferTexelOf)で読み、深度から位置を戻すのはこの uv で行う** — 画素の角で読むと輪郭で
// 虚空の値が混ざり、読んだ画素と違う uv で位置を戻すと平らな面が自分自身を遮る。
export function gbufferUVOf(pixel: Vec2Node, gbufferSize: Vec2Node): Vec2Node {
  return texelCenterUV(gbufferTexelOf(pixel, gbufferSize), gbufferSize);
}

// gbufferUVOf が中心の uv を答える、G バッファの画素の整数座標。
function gbufferTexelOf(pixel: Vec2Node, gbufferSize: Vec2Node): THREE.Node<'ivec2'> {
  // 整数で割る — 解像度が半分なら画素の中心は G バッファの画素の境に乗り、浮動小数の floor では採る画素が
  // 画素ごとに揺れる。
  return ivec2(pixel).mul(2).add(1).mul(ivec2(gbufferSize)).div(ivec2(screenSize).mul(2));
}

// 寸法 size [px] のテクスチャの画素 texel(整数座標)の中心の uv。
function texelCenterUV(texel: THREE.Node<'ivec2'>, size: Vec2Node): Vec2Node {
  return vec2(texel).add(0.5).div(size);
}
