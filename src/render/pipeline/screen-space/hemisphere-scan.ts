// 受け手 1 画素のまわりの半球を、画面に写った近くの構造に対して一度だけ走査し、遠方の拡散光(一様な環境光と
// 天体照)のうち近くの構造に塞がれた照度と、塞いでいる面が返す照度(照り返し)の差を答える。
//
// 画面上の向き(スライス)を数本取り、それぞれ両側へ深度を引く。深度の標本 1 つは、画面上で隣り合う標本との
// あいだを受け持つ接平面の切片とみなし、スライスの中の遮りは扇形のビットマスクで持つ(Therrien, Levesque, Gilet
// 2023「Screen Space Indirect Lighting with Visibility Bitmask」)。
import type * as THREE from 'three/webgpu';
import {
  If, Loop, abs, acos, atan, bool, clamp, cos, countOneBits, cross, dot, float, floor, getViewPosition, ivec2, length,
  max, min, normalize, round, screenSize, screenUV, select, sign, sin, sqrt, textureLoad, uint, vec2, vec3, vec4,
} from 'three/tsl';
import { octDecodeNormal } from '../gbuffer';
import { viewRayAt } from '../view-ray';
import { signedDiffuseCorrection } from './diffuse-correction';
import type { PlanetCap } from '../lighting/planet-light-source';
import type {
  BoolNode, FloatNode, IntNode, Mat4Uniform, UintNode, Vec2Node, Vec3Node,
} from '../../tsl-types';

// 遮りを探す距離 [m]。受け手からこれより遠い面は遮らない。
const WORLD_RADIUS = 4;
// スライス 1 枚を刻む扇形の数。マスクの幅(uint のビット数)と一致させる。
const SECTOR_COUNT = 32;
const HALF_PI = Math.PI / 2;

// 受け手を照らす天体照 1 つ。cap は受け手から見た球冠(view 空間)、irradiance は近くの構造に遮られないときに
// 届く拡散照度(SUN_IRRADIANCE_1AU の目盛り)。
export interface PlanetIllumination {
  readonly cap: PlanetCap;
  readonly irradiance: Vec3Node;
}

// スライス 1 枚 — 受け手の視線 V と画面上の向きが張る平面。平面の中の点は、受け手を原点に V の成分と
// orthoDirection の成分を並べた 2 次元の座標(スライスの座標)で表す。角度はすべて V から測り、orthoDirection の
// 側を正とする。半球はこの平面の中で [n − π/2, n + π/2] を占め、測度 cos(h − n)·|sin h| dh で量る。
interface Slice {
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
interface SectorRange {
  readonly lower: FloatNode;
  readonly upper: FloatNode;
}

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
// (スライスの座標。受け手の円で切る前)。
export interface SegmentSplit {
  readonly nearUpper: Vec2Node;
  readonly farLower: Vec2Node;
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
// (SUN_IRRADIANCE_1AU の目盛り)で、null なら照り返しは 0。虚空と、半径が画面上で 1 画素以下の受け手は 0。
// **Fn の中から呼ぶこと。**
export function scanHemisphere(
  depth: THREE.Texture, normal: THREE.Texture, gbufferSize: Vec2Node, projection: Mat4Uniform,
  projectionInverse: Mat4Uniform, sliceCount: IntNode, stepCount: IntNode, noise: Vec3Node,
  ambientIrradiance: Vec3Node, planets: readonly PlanetIllumination[], radiance: THREE.Texture | null,
): Vec3Node {
  // 受け手。ループの中と外の両方から読むので、先に変数へ置く。視線は投影方式によらない形から取る。
  const receiver = surfaceAt(depth, normal, gbufferSize, projectionInverse, floor(screenUV.mul(screenSize)));
  const view = viewRayAt(projectionInverse, receiver.uv).direction.negate().toVar();
  const radius = screenRadius(receiver.position, projection).toVar();
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
  If(receiver.depth.greaterThan(0).and(radius.greaterThan(1)), () => {
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
    correction.assign(signedDiffuseCorrection(bounceSum.mul(Math.PI).div(average), blockedIrradiance));
  });
  return correction;
}

// 走査の解像度の画素 pixel(整数座標)が表す G バッファの画素の面。面が写っていない画素の法線は (0, 0, 1)。
function surfaceAt(
  depth: THREE.Texture, normal: THREE.Texture, gbufferSize: Vec2Node, projectionInverse: Mat4Uniform,
  pixel: Vec2Node,
): GBufferSurface {
  const uv = gbufferUVOf(pixel, gbufferSize).toVar();
  const texel = ivec2(floor(uv.mul(gbufferSize))).toVar();
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
  // 天体ごとの、球冠の範囲と、その中で新しく塞いだ測度に距離重みを掛けた和。sum は受け手の画素での和。
  public readonly planets: readonly {
    readonly sum: PlanetSum;
    readonly range: SectorRange;
    readonly blocked: FloatNode;
  }[];

  // dither は扇形の端の丸めのずれ、radiance は照り返しの源の放射輝度(null なら照り返しを積まない)。
  public constructor(
    private readonly slice: Slice, planetSums: readonly PlanetSum[], private readonly dither: FloatNode,
    private readonly radiance: THREE.Texture | null,
  ) {
    this.planets = planetSums.map((sum) => ({
      sum, range: capRange(slice, sum.planet.cap, dither), blocked: float(0).toVar(),
    }));
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
      for (const planet of this.planets) planet.blocked.addAssign(maskedMeasure(newly, planet.range).mul(falloff));
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
function tangentHit(ray: Ray, point: SlicePoint): Vec2Node {
  const facing = dot(point.normal, ray.direction).toVar();
  const parallel = abs(facing).lessThan(1e-6);
  const along = point.offset.sub(dot(point.normal, ray.origin)).div(select(parallel, float(1), facing)).toVar();
  return select(parallel.or(along.lessThanEqual(0)), point.position, ray.origin.add(ray.direction.mul(along)));
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

// view 空間の変位 offset をスライス平面へ射影した、スライスの座標。
export function toSliceCoordinates(slice: Slice, offset: Vec3Node): Vec2Node {
  return vec2(dot(offset, slice.view), dot(offset, slice.orthoDirection));
}

// スライスの座標の点 a と b のうち、受け手から見た角の小さい方。どちらもスライスの同じ側にあること — 角の差が
// π 未満なので、角を求めずに外積の符号で比べられる。
function angularlyLower(a: Vec2Node, b: Vec2Node): Vec2Node {
  return select(cross2(a, b).greaterThanEqual(0), a, b);
}

// スライスの座標の点 a と b のうち、受け手から見た角の大きい方。どちらもスライスの同じ側にあること。
function angularlyHigher(a: Vec2Node, b: Vec2Node): Vec2Node {
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
function bitCount(bits: UintNode): FloatNode {
  // countOneBits の @types/three 上の戻り値型は値の型を持たないため、UintNode へ読み替える。
  return float(countOneBits(bits) as unknown as UintNode);
}
