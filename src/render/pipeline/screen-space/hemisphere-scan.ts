// 受け手 1 画素のまわりの半球を、画面に写った近くの構造に対して一度だけ走査し、遠方の拡散光(一様な環境光と
// 天体照)のうち近くの構造に塞がれた照度と、塞いでいる面が返す照度(照り返し)の差を帯ごとに答える。
// 補正の増分は、切片の画面距離と向きに応じた帯へ分けて積む。
//
// 画面上の向き(スライス)を数本取り、それぞれ両側へ深度を引く。深度の標本 1 つは、画面上で隣り合う標本との
// あいだを受け持つ接平面の切片とみなし、スライスの中の遮りは扇形のビットマスクで持つ(Therrien, Levesque, Gilet
// 2023「Screen Space Indirect Lighting with Visibility Bitmask」)。
import type * as THREE from 'three/webgpu';
import {
  If, Loop, acos, atan, bool, clamp, cos, dot, float, floor, fract, getViewPosition, ivec2, length, max, min, pow,
  screenSize, screenUV, select, sin, smoothstep, sqrt, step, textureLoad, uint, vec2, vec3, vec4,
} from 'three/tsl';
import { octDecodeNormal } from '../gbuffer';
import { viewRayAt } from '../view-ray';
import { facingCosine, sampleBandWeights, type BandSplit } from './band-split';
import { signedDiffuseCorrection } from './diffuse-correction';
import {
  SECTOR_COUNT, angleOf, bitCount, capArc, capMeasure, maskedMeasure, rangeSectors, sectorPosition, sectorRange,
  segmentSectors, sliceAt, toSliceCoordinates, type RangeSectors, type Slice, type SliceArc,
} from './slice-sectors';
import {
  angularlyHigher, angularlyLower, rayAt, samplePoint, sideRays, splitSegments, tangentHit, type SideRays,
  type SlicePoint,
} from './tangent-segments';
import type { PlanetCap } from '../lighting/planet-light-source';
import type { ScanSurfaces } from './texel-surface';
import type {
  BoolNode, FloatNode, IntNode, Mat4Uniform, Vec2Node, Vec3Node,
} from '../../tsl-types';

// 遮りを探す距離 [m]。受け手からこれより遠い面は遮らない。
const WORLD_RADIUS = 4;

// 天体照の円盤の視半径の下限 [rad]。小さい天体はスライスにめったに当たらず、当たると大きく引く裾の重い外れ値に
// なるので、視半径をここまで広げる。広げた円盤の測度で割るので、遮られないときの照度は変わらない。
const MIN_CAP_ANGLE = Math.PI / 8;

// 視半径を MIN_CAP_ANGLE まで広げた球冠(向きはそのまま)。
export function widenedCap(cap: PlanetCap): PlanetCap {
  return { direction: cap.direction, cosAngle: min(cap.cosAngle, Math.cos(MIN_CAP_ANGLE)) };
}

// 広げた円盤の中の向き direction を、円盤の中心 center(単位ベクトル)からの角を scale 倍した向きへ写す。
// 中心から見た方位は変えない。direction が中心とほぼ一致するときは center。
export function scaledAboutCenter(direction: Vec3Node, center: Vec3Node, scale: FloatNode): Vec3Node {
  const cosTheta = clamp(dot(direction, center), -1, 1);
  const perpendicular = direction.sub(center.mul(cosTheta));
  const sinTheta = length(perpendicular);
  const theta = atan(sinTheta, cosTheta).mul(scale);
  const tangent = perpendicular.div(max(sinTheta, 1e-6));
  return select(sinTheta.lessThan(1e-6), center, center.mul(cos(theta)).add(tangent.mul(sin(theta))));
}

// 受け手を照らす天体照 1 つ。cap は受け手から見た球冠(view 空間)、irradiance は近くの構造に遮られないときに
// 届く拡散照度(SUN_IRRADIANCE_1AU の目盛り)。relativeRadiance は、実際の円盤の上の向き direction(view 空間)を
// 角幅 filterAngle [rad] で読んだ放射輝度を、irradiance の元の放射輝度で割った相対値(成分ごと)。imageLit は
// 放射輝度が円盤の上で変わるかで、偽なら一様(相対値は 1)で relativeRadiance を呼ばない。
export interface PlanetIllumination {
  readonly cap: PlanetCap;
  readonly irradiance: Vec3Node;
  readonly imageLit: BoolNode;
  readonly relativeRadiance: (direction: Vec3Node, filterAngle: FloatNode) => Vec3Node;
}

// 受け手へ届く遠方の拡散光と、新しく塞いだ測度をその光の塞がれた割合へ写す尺度。ambient は一様な環境光の照度、
// hemisphereScale は 1 / (スライスの数 × SECTOR_COUNT)、planets は天体照ごとに(視半径を広げた)円盤の尺度
// capScale = 1 / (スライスの数 × SECTOR_COUNT × 円盤の測度) と、広げた円盤の角を実際の円盤の角へ写す倍率
// discScale = 実際の視半径 / 広げた視半径 と、相対放射輝度の自己正規化 normalizer を添えたもの。
interface DistantLight {
  readonly ambient: Vec3Node;
  readonly hemisphereScale: FloatNode;
  readonly planets: readonly (PlanetIllumination & {
    readonly capScale: FloatNode;
    readonly discScale: FloatNode;
    readonly normalizer: RelativeNormalizer;
  })[];
}

// 受け手ごと・天体ごとの、相対放射輝度の自己正規化。mean は弧の重み付き平均、valid は成分ごとに mean で割ってよいか
// (0 か 1)。割れない成分の相対放射輝度は 1 にする。
interface RelativeNormalizer {
  readonly mean: Vec3Node;
  readonly valid: Vec3Node;
}

// 平均が割れる下限(成分ごと)。これ未満は読んだ所がすべて暗いか、どのスライスも円盤に当たらない。
const MIN_NORMALIZER = 1e-6;

// G バッファの画素 1 つの面(view 空間)。depth は素の深度で、0 なら面が写っていない。
interface GBufferSurface {
  readonly uv: Vec2Node;
  readonly depth: FloatNode;
  readonly position: Vec3Node;
  readonly normal: Vec3Node;
}

// 走査の解像度で描いている画素を受け手として、走査の解像度の面 surfaces(素の深度と view 空間の oct 符号化の法線)を
// 走査し、受け手の拡散照度の補正(照り返し − 塞がれた照度)を帯 bands ごとに返す(長さは帯の数で、和が帯に分けない
// 補正)。受け手と標本は、走査の画素が表す G バッファの画素(gbufferUVOf)の値を読む。
// gbufferSize はその G バッファの寸法 [px]。
// projection / projectionInverse は実カメラの射影行列とその逆、sliceCount はスライスの数、stepCount は片側の歩数、
// noise は画素ごとの互いに独立な 0..1 の組(x がスライスの回転、y が歩みのずれ、z が扇形の端の丸めのずれ)。
// ambientIrradiance と planets は、近くの構造に遮られないときに受け手へ届く一様な環境光の照度と天体照。radiance は
// 走査と同じ解像度の、面が放つ放射輝度(SUN_IRRADIANCE_1AU の目盛り)で、null なら照り返しは 0。resolvesNearby が
// 偽の受け手は 0。**Fn の中から呼ぶこと。** noise・ambientIrradiance・planets は一様でない分岐の中で読むので、
// テクスチャを段を明示して読む式で渡すこと。
export function scanHemisphere(
  surfaces: ScanSurfaces, gbufferSize: Vec2Node, projection: Mat4Uniform,
  projectionInverse: Mat4Uniform, sliceCount: IntNode, stepCount: IntNode, noise: Vec3Node,
  ambientIrradiance: Vec3Node, planets: readonly PlanetIllumination[], radiance: THREE.Texture | null,
  bands: BandSplit,
): Vec3Node[] {
  // 受け手。ループの中と外の両方から読むので、先に変数へ置く。
  const receiver = surfaceAt(surfaces, gbufferSize, projectionInverse, floor(screenUV.mul(screenSize)));
  const radius = projectedRadius(receiver.position, projection, screenSize).toVar();
  const corrections = Array.from({ length: bands.count }, () => vec3(0).toVar());
  If(resolvesNearby(receiver.depth, radius), () => {
    // 視線は投影方式によらない形から取る。
    const view = viewRayAt(projectionInverse, receiver.uv).direction.negate().toVar();
    const receiverView = facingCosine(receiver.normal, view).toVar();
    const rotation = noise.x.toVar();
    const jitter = noise.y.toVar();
    // 丸めのずれは両端を除いた区間へ写す — 0 と 1 では扇形の座標のずれが ±½ ちょうどになり、半球の端に接する
    // 幅 0 の切片が端の扇形を立てる。
    const dither = noise.z.mul(255 / 256).add(0.5 / 256).toVar();
    // 遠方の光は面の値を読む式から組まれている。**ループへ入る前に変数へ置く** — ループの中で初めて組むと、
    // スライスごとに面を読み直し、ループの後の照度もループの中で読んだ値に頼る。
    const ambient = ambientIrradiance.toVar();
    const hemisphereScale = float(1).div(float(sliceCount).mul(SECTOR_COUNT)).toVar();
    // 天体照の円盤は視半径を広げ、受け手ごとに 1 回その測度を求める。円盤が地平の下で測度が 0 のときは、下限で
    // 0 除算を避ける — 弧は半球の外で幅 0 になるので掛かる測度も 0。
    const planetLights = planets.map(({ cap, irradiance, imageLit, relativeRadiance }) => {
      const widened = widenedCap(cap);
      const wideCap = { direction: widened.direction.toVar(), cosAngle: widened.cosAngle.toVar() };
      const measure = capMeasure(wideCap, receiver.normal);
      return {
        cap: wideCap,
        irradiance: irradiance.toVar(),
        imageLit,
        relativeRadiance,
        capScale: hemisphereScale.div(max(measure, 1e-6)).toVar(),
        discScale: acos(clamp(cap.cosAngle, -1, 1)).div(acos(wideCap.cosAngle)).toVar(),
      };
    });
    // 視線に垂直な面の中で等間隔に取ったスライスのうち index 本目。
    const sliceOf = (index: IntNode): Slice =>
      sliceAt(float(index).add(rotation).mul(Math.PI).div(float(sliceCount)), view, receiver.normal);
    // 相対放射輝度は天体ごとに自己正規化する — 遮りの無いときの天体照を一様な円盤の値に合わせ、写しは円盤のどこを
    // 塞ぐと多く引くかの分布だけに効かせる(拡散の放射輝度と写しの読みの近似の偏りを総量へ持ち込まない)。
    const normalizedLights = planetLights.map((planet) => ({
      ...planet, normalizer: relativeNormalizer(planet, sliceOf, sliceCount, dither),
    }));
    const light: DistantLight = { ambient, hemisphereScale, planets: normalizedLights };
    // 歩みの割合 progress(0..stepCount)の画面上の距離 [走査の画素]。受け手自身の画素を読まない 1 走査画素先から半径までを、
    // 指数で近くへ寄せて配る（半径が大きくても受け手のそばを粗くしない）。
    const stepDistance = (progress: FloatNode): FloatNode => {
      const u = progress.div(float(stepCount));
      return radius.mul(pow(radius, u.sub(1)));
    };
    Loop({ start: 0, end: sliceCount, type: 'int', condition: '<' }, ({ i }) => {
      const slice = sliceOf(i);
      const occlusion = new SliceOcclusion(slice, dither, light, bands, receiverView, corrections, radiance);
      // 受け手自身は、スライスの座標の原点にある、受け手の接平面の点。標本と同じ式で法線を写す — 同じ平面の標本と
      // 法線が一致しないと、平行なはずの 2 直線の交点を拾う。
      const receiverInSlice: SlicePoint = {
        position: vec2(0), normal: toSliceCoordinates(slice, receiver.normal).toVar(), offset: float(0),
      };
      const forwardRays = sideRays(slice, receiver.position, receiver.uv, slice.screenDirection.div(screenSize),
        projectionInverse);
      // 歩みのずれはスライスごとに 1/S ずらす(共有すると半径方向のずれが平均されない)。i は内側の Loop で同名の添字に化けるのでここで読む。
      const sliceJitter = fract(jitter.add(float(i).div(float(sliceCount)))).toVar();
      // 両側へ、手前から奥の順に歩む。歩 k の標本は画面上の区間 [stepDistance(k), stepDistance(k + 1)] の中の 1 点。
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
          const rho = stepDistance(float(step).add(sliceJitter)).toVar();
          const samplePixel = pixelAlong(screenStep, rho).toVar();
          const sample = surfaceAt(surfaces, gbufferSize, projectionInverse, samplePixel);
          const toSample = sample.position.sub(receiver.position).toVar();
          // 遮るのは、画面の中で面が写っている、受け手から半径の内側の標本。
          const onScreen = samplePixel.x.greaterThanEqual(0).and(samplePixel.y.greaterThanEqual(0))
            .and(samplePixel.x.lessThan(screenSize.x)).and(samplePixel.y.lessThan(screenSize.y));
          const surface = onScreen.and(sample.depth.greaterThan(0))
            .and(dot(toSample, toSample).lessThanEqual(WORLD_RADIUS * WORLD_RADIUS));
          // 送り手の位置での視線(透視でも平行投影でも標本の uv から引く)。
          const senderToCamera = viewRayAt(projectionInverse, sample.uv).direction.negate();
          walk.visit(rho, surface, toSample, sample.normal, facingCosine(sample.normal, senderToCamera));
        });
        walk.finish(radius);
      });
    });
    // 半径が 1〜2 画素に写る受け手では、効きを 0 から 1 へ渡す — 走査を打ち切る 1 画素で補正が段を作らない。
    const fade = smoothstep(1, 2, radius).toVar();
    for (const correction of corrections) correction.mulAssign(fade);
  });
  return corrections;
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
  surfaces: ScanSurfaces, gbufferSize: Vec2Node, projectionInverse: Mat4Uniform, pixel: Vec2Node,
): GBufferSurface {
  const surface = surfaces.scanSurfaceAt(ivec2(pixel));
  const texel = surface.texel.toVar();
  const uv = texelCenterUV(texel, gbufferSize).toVar();
  const rawDepth = surface.depth.toVar();
  const surfaceNormal = vec3(0, 0, 1).toVar();
  If(rawDepth.greaterThan(0), () => {
    surfaceNormal.assign(octDecodeNormal(surface.encodedNormal));
  });
  const position = getViewPosition(uv, rawDepth, projectionInverse).toVar();
  return { uv, depth: rawDepth, position, normal: surfaceNormal };
}

// 受け手の画素から、画面上の歩み screenStep [uv/走査の画素] の向きへ画面距離 rho だけ進んだ点を含む、走査の画素
// (整数座標)。
function pixelAlong(screenStep: Vec2Node, rho: FloatNode): Vec2Node {
  return floor(screenUV.add(screenStep.mul(rho)).mul(screenSize));
}

// スライス 1 枚の遮り。手前から奥の順に渡される切片を扇形のビットへ立て、新しく塞いだ扇形の測度を受け手の補正の
// 増分へ写し、切片の画面距離で帯へ分けて積む。**スライスのループの本体で作ること** — 塞がれた扇形の変数をそこへ置く。
class SliceOcclusion {
  // 塞がれた扇形。
  private readonly blocked = uint(0).toVar();
  // 新しく塞いだ扇形の数を、受け手の半球の余弦重みの測度に対する割合へ写す重み。
  private readonly hemisphereWeight: FloatNode;
  // 天体ごとの、円盤の上の相対放射輝度を掛けた照度 irradiance、球冠をビットごとに測る形 sectors と、塞いだ球冠の
  // 測度をその天体照の塞がれた割合へ写す重み capWeight。
  private readonly planets: readonly {
    readonly irradiance: Vec3Node;
    readonly sectors: RangeSectors;
    readonly capWeight: FloatNode;
  }[];

  // dither は扇形の端の丸めのずれ、light は受け手へ届く遠方の拡散光、bands と corrections は帯の分け方と帯ごとの
  // 補正の積み先、receiverView は受け手の法線と受け手→カメラの内積、radiance は照り返しの源の放射輝度(null なら
  // 照り返しを積まない)。
  public constructor(
    private readonly slice: Slice, private readonly dither: FloatNode, private readonly light: DistantLight,
    private readonly bands: BandSplit, private readonly receiverView: FloatNode,
    private readonly corrections: readonly Vec3Node[], private readonly radiance: THREE.Texture | null,
  ) {
    this.hemisphereWeight = slice.weight.mul(light.hemisphereScale).toVar();
    this.planets = light.planets.map((planet) => {
      const { cap, irradiance, imageLit, capScale, normalizer } = planet;
      const arc = capArc(slice, cap);
      const relative = vec3(1).toVar();
      If(imageLit, () => {
        const { mean, valid } = normalizer;
        relative.assign(vec3(1).sub(valid).add(arcRadiance(slice, arc, planet).div(max(mean, MIN_NORMALIZER)).mul(valid)));
      });
      return {
        irradiance: irradiance.mul(relative).toVar(),
        sectors: rangeSectors(sectorRange(slice, arc, dither)),
        capWeight: slice.weight.mul(capScale).toVar(),
      };
    });
  }

  // 受け手から見て角 lower..upper を占める切片を、手前の切片の後ろへ積む。falloff はその標本の距離重み、
  // facesReceiver は標本が受け手へ面を向けているか、senderView は標本の法線と標本→カメラの内積。
  // rho と pixel は標本の画面距離 [走査の画素] と走査の画素。
  public add(
    lower: FloatNode, upper: FloatNode, falloff: FloatNode, facesReceiver: BoolNode,
    senderView: FloatNode, rho: FloatNode, pixel: Vec2Node,
  ): void {
    const sectors = segmentSectors(
      sectorPosition(this.slice, lower, this.dither), sectorPosition(this.slice, upper, this.dither)).toVar();
    // 手前の切片に塞がれていなかった扇形。**OR する前に引く** — 遮りの後ろの遮りを二重に数えない。
    const newly = sectors.bitAnd(this.blocked.bitNot()).toVar();
    this.blocked.assign(this.blocked.bitOr(sectors));
    If(newly.notEqual(uint(0)), () => {
      // 距離重みは**ビットには掛けない** — 手前から奥へ歩むので、ビットを立てそこねると奥の標本が手前の遮りの
      // 後ろを塞ぎ直し、二重に数える。
      const newlyMeasure = bitCount(newly).mul(falloff).toVar();
      // 新しく塞いだ半球の割合だけ環境光が、天体ごとに新しく塞いだ割合だけその天体照が塞がれる。
      const hemisphere = newlyMeasure.mul(this.hemisphereWeight).toVar();
      const blockedIrradiance = this.light.ambient.mul(hemisphere).toVar();
      for (const { irradiance, sectors: planetSectors, capWeight } of this.planets) {
        blockedIrradiance.addAssign(irradiance.mul(maskedMeasure(newly, planetSectors).mul(falloff).mul(capWeight)));
      }
      // 光を返すのは受け手へ面を向けた切片。その向きの境で、切片の張る角は 0 へ縮む。放射輝度 L の面が半球を塞げば
      // 照り返しは π L。
      const received = vec3(0).toVar();
      const radiance = this.radiance;
      if (radiance !== null) {
        If(facesReceiver, () => {
          received.assign(textureLoad(radiance, ivec2(pixel)).rgb.mul(Math.PI).mul(hemisphere));
        });
      }
      const increment = signedDiffuseCorrection(received, blockedIrradiance).toVar();
      const weights = sampleBandWeights(this.bands, rho, this.receiverView, senderView);
      for (const [band, correction] of this.corrections.entries()) correction.addAssign(increment.mul(weights[band]!));
    });
  }
}

// 弧 arc を円盤に写して読んだ天体の相対放射輝度。弧の中点の向きを実際の円盤へ写して読み、フィルタの幅は弧を写した
// 長さにする — 1 点で読むと、満ち欠けの境が弧に沿うときに弧の平均から外れる。
function arcRadiance(
  slice: Slice, arc: SliceArc,
  { cap, discScale, relativeRadiance }: Pick<PlanetIllumination, 'cap' | 'relativeRadiance'> & { discScale: FloatNode },
): Vec3Node {
  const middle = arc.lower.add(arc.upper).mul(0.5);
  const direction = slice.view.mul(cos(middle)).add(slice.orthoDirection.mul(sin(middle)));
  const filterAngle = max(arc.upper.sub(arc.lower), 1e-4).mul(discScale);
  return relativeRadiance(scaledAboutCenter(direction, cap.direction, discScale), filterAngle);
}

// 天体の相対放射輝度の、全スライスの弧の重み付き平均 Σ w·幅·r / Σ w·幅 を求める。幅は弧の扇形の座標での幅。
// 放射輝度が円盤の上で変わらない(imageLit が偽)ときは写しを読まず、平均 1・valid 1。**Fn の中から呼ぶこと。**
function relativeNormalizer(
  planet: Pick<PlanetIllumination, 'cap' | 'imageLit' | 'relativeRadiance'> & { discScale: FloatNode },
  sliceOf: (index: IntNode) => Slice, sliceCount: IntNode, dither: FloatNode,
): RelativeNormalizer {
  const mean = vec3(1).toVar();
  const valid = vec3(1).toVar();
  If(planet.imageLit, () => {
    const weighted = vec3(0).toVar();
    const total = float(0).toVar();
    Loop({ start: 0, end: sliceCount, type: 'int', condition: '<' }, ({ i }) => {
      const slice = sliceOf(i);
      const arc = capArc(slice, planet.cap);
      const range = sectorRange(slice, arc, dither);
      const weight = slice.weight.mul(range.upper.sub(range.lower));
      weighted.addAssign(arcRadiance(slice, arc, planet).mul(weight));
      total.addAssign(weight);
    });
    mean.assign(weighted.div(max(total, MIN_NORMALIZER)));
    valid.assign(step(vec3(MIN_NORMALIZER), mean).mul(step(MIN_NORMALIZER, total)));
  });
  return { mean, valid };
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
  private readonly previousSenderView = float(0).toVar();

  // screenStep はこの側の画面上の歩み [uv/走査の画素]、rays はこの側の視線、occlusion は切片を積むスライスの遮り、
  // receiver は最初の「直前の標本」とする受け手自身。
  public constructor(
    private readonly slice: Slice, private readonly screenStep: Vec2Node, private readonly rays: SideRays,
    private readonly occlusion: SliceOcclusion, private readonly receiver: SlicePoint,
  ) {
    this.previous = {
      position: receiver.position.toVar(), normal: receiver.normal.toVar(), offset: receiver.offset.toVar(),
    };
  }

  // 画面距離 rho の標本を次に加える。toSample は受け手から標本への変位、normal は標本の法線(view 空間)。hasSurface
  // が偽なら面のない標本(虚空・画面外・半径の外)で、切片を持たない。senderView は標本の法線と標本→カメラの内積。
  public visit(
    rho: FloatNode, hasSurface: BoolNode, toSample: Vec3Node, normal: Vec3Node, senderView: FloatNode,
  ): void {
    const sample = samplePoint(this.slice, this.rays, rho, toSample, normal, this.receiver);
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
    this.previousSenderView.assign(senderView);
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
      offset.lessThan(0), this.previousSenderView, this.previousRho, pixelAlong(this.screenStep, this.previousRho));
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
  return texelCenterUV(gbufferTexelOf(pixel, gbufferSize, screenSize), gbufferSize);
}

// 寸法 pixelSize [px] の画面の画素 pixel(整数座標)について、gbufferUVOf が中心の uv を答える G バッファの画素の
// 整数座標。
export function gbufferTexelOf(pixel: Vec2Node, gbufferSize: Vec2Node, pixelSize: Vec2Node): THREE.Node<'ivec2'> {
  // 整数で割る — 解像度が半分なら画素の中心は G バッファの画素の境に乗り、浮動小数の floor では採る画素が
  // 画素ごとに揺れる。
  return ivec2(pixel).mul(2).add(1).mul(ivec2(gbufferSize)).div(ivec2(pixelSize).mul(2));
}

// 寸法 size [px] のテクスチャの画素 texel(整数座標)の中心の uv。
export function texelCenterUV(texel: THREE.Node<'ivec2'>, size: Vec2Node): Vec2Node {
  return vec2(texel).add(0.5).div(size);
}
