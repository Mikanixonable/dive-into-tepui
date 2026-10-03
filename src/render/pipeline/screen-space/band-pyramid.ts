// 画面距離の帯ごとに分けた近傍拡散補正の、描画先への詰め方と、段ごとの縮小、粗い段からの拡大と合流。帯 b の rgb は、
// RGBA のテクスチャを並べた通しのチャンネル 3b..3b + 2 へ順に詰める。段 m の画素は走査の 2^m 画素四方を受け持って帯 m
// 以降を持ち、段の画素どうしは代表の面の重みで比べる。
import type * as THREE from 'three/webgpu';
import { If, exp2, float, floor, ivec2, screenSize, screenUV, select, textureLoad, vec2, vec3, vec4 } from 'three/tsl';
import type { ScreenSpaceInputPyramid } from './screen-space-input-pyramid';
import type { SurfaceWeight, Texel } from './surface-weight';
import type { FloatNode, Vec2Node, Vec3Node, Vec4Node } from '../../tsl-types';

// RGBA のテクスチャ 1 枚のチャンネルの数。
const CHANNELS_PER_TEXTURE = 4;
// 2×2 の画素の、左上からのずれ。並びは左上・右上・左下・右下。
export const QUAD_OFFSETS = [[0, 0], [1, 0], [0, 1], [1, 1]] as const;
// 重みの和がこれ以下なら、重みを持つ標本がないとみなす。0 で割らないための値。
export const WEIGHT_EPSILON = 1e-6;
// 段の画素どうしを比べる面の重みの調整値 — 接平面からの距離の許容の係数 c_z [段の画素の幅]、段 1 の法線の重みが
// 半分になる角 θ_1 [rad](20°)と、その段ごとの公比 r。
const DISTANCE_TOLERANCE_SCALE = 1;
const FIRST_HALF_WEIGHT_ANGLE = Math.PI / 9;
const HALF_WEIGHT_ANGLE_RATIO = 1;

// 帯の数 count の補正を詰める RGBA のテクスチャの枚数。
export function packedTextureCount(count: number): number {
  return Math.ceil((3 * count) / CHANNELS_PER_TEXTURE);
}

// 帯ごとの補正 bands を、packedTextureCount 枚の RGBA へ詰める。余りのチャンネルは 0。
export function packedBands(bands: readonly Vec3Node[]): Vec4Node[] {
  const channels: FloatNode[] = bands.flatMap((band) => [band.x, band.y, band.z]);
  const channelAt = (index: number): FloatNode => channels[index] ?? float(0);
  return Array.from({ length: packedTextureCount(bands.length) }, (_, texture) => {
    const first = texture * CHANNELS_PER_TEXTURE;
    return vec4(channelAt(first), channelAt(first + 1), channelAt(first + 2), channelAt(first + 3));
  });
}

// packedBands で詰めた値 packed から、count 個の帯ごとの補正を取り出す。
export function unpackedBands(packed: readonly Vec4Node[], count: number): Vec3Node[] {
  const channels: FloatNode[] = packed.flatMap((value) => [value.x, value.y, value.z, value.w]);
  return Array.from({ length: count }, (_, band) => {
    const [r, g, b] = channels.slice(3 * band, 3 * band + 3);
    return vec3(r!, g!, b!);
  });
}

// packedBands で詰めて描いたテクスチャ textures の画素 texel から、count 個の帯ごとの補正を読む。
export function bandsAt(textures: readonly THREE.Texture[], count: number, texel: Texel): Vec3Node[] {
  return unpackedBands(textures.map((texture) => textureLoad(texture, texel)), count);
}

// 左上の角からのずれ fraction [画素] の点に対する、角から (dx, dy) の画素の双線形の重み。
export function bilinearWeightOf(fraction: Vec2Node, dx: 0 | 1, dy: 0 | 1): FloatNode {
  return (dx === 0 ? fraction.x.oneMinus() : fraction.x).mul(dy === 0 ? fraction.y.oneMinus() : fraction.y);
}

// 段 k の画素 pixel(整数座標)の中心を囲む段 k + 1 の 4 画素 texel(整数座標。段の画面の外もありうる)と、その双線形の
// 重み weight。重みの和は 1 で、pixel を含む段 k + 1 の画素が 9/16、斜向かいが 1/16。
export function coarseNeighbors(pixel: Vec2Node): { readonly texel: Vec2Node; readonly weight: FloatNode }[] {
  // 段 k + 1 の画素を単位とし、画素の中心を整数に乗せた座標。
  const position = pixel.add(0.5).mul(0.5).sub(0.5);
  const corner = floor(position);
  const fraction = position.sub(corner);
  return QUAD_OFFSETS.map(([dx, dy]) => ({
    texel: corner.add(vec2(dx, dy)), weight: bilinearWeightOf(fraction, dx, dy),
  }));
}

// 子ごとの重み weight と帯ごとの値 bands(帯の並びは子によらない)から、帯ごとに重みで正規化した平均。重みの和が
// WEIGHT_EPSILON 以下なら 0。
export function weightedBands(
  children: readonly { readonly weight: FloatNode; readonly bands: readonly Vec3Node[] }[],
): Vec3Node[] {
  const total = children.map(({ weight }) => weight).reduce((sum, weight) => sum.add(weight));
  return children[0]!.bands.map((_, band) => {
    const sum = children.map(({ weight, bands }) => bands[band]!.mul(weight)).reduce((a, b) => a.add(b));
    return select(total.greaterThan(WEIGHT_EPSILON), sum.div(total), vec3(0));
  });
}

// 段 k の拡大と合流の出力 C_k = D_k + Σ β_i·w_i·C_{k+1}(i) + (1 − Σ β_i·w_i)·T_k。direct は D_k(段 k の帯 k)、remainder は
// T_k(段 k の帯 k + 1 以降の和)、coarse は段 k + 1 の画素ごとの重み β_i·w_i と C_{k+1}(i)。
export function mergedCorrection(
  direct: Vec3Node, remainder: Vec3Node, coarse: readonly { readonly weight: FloatNode; readonly value: Vec3Node }[],
): Vec3Node {
  const confidence = coarse.map(({ weight }) => weight).reduce((sum, weight) => sum.add(weight));
  const upsampled = coarse.map(({ weight, value }) => value.mul(weight)).reduce((sum, value) => sum.add(value));
  return direct.add(upsampled).add(remainder.mul(float(1).sub(confidence)));
}

// 帯の縮小と、粗い段からの拡大と合流を組む。段の画素どうしは、代表の面の重みで比べる。
export class BandPyramid {
  // surfaces は段ごとの代表の面、weight は面の重み、fullSize と scanSize は描画バッファと走査の解像度 [px]。
  public constructor(
    private readonly surfaces: ScreenSpaceInputPyramid, private readonly weight: SurfaceWeight,
    private readonly fullSize: Vec2Node, private readonly scanSize: Vec2Node,
  ) {}

  // 段 level の描いている画素の、帯 level..count − 1 を詰めた値(packedBands の並び)。段 level − 1 の帯を詰めたテクスチャ
  // finer(帯 level − 1..count − 1)の 4 つの子の帯を、子の代表を段 level の代表と比べた面の重みで平均する。段 level の
  // 代表に面がなければ 0。**Fn の中から呼ぶこと。**
  public reduced(finer: readonly THREE.Texture[], count: number, level: number): Vec4Node[] {
    const pixel = ivec2(floor(screenUV.mul(screenSize))).toVar();
    const representative = this.surfaces.representativeAt(level, pixel).toVar();
    const outputs = Array.from({ length: packedTextureCount(count - level) }, () => vec4(0).toVar());
    If(this.surfaces.hasSurface(representative), () => {
      const receiver = this.weight.receiverAt(representative);
      const { distance, angle } = this.toleranceAt(level);
      // 子の代表自身は重み 1 なので、重みの和は 1 以上。
      const children = this.surfaces.childrenOf(pixel).map((child) => {
        const exponent = this.weight.exponentOf(
          receiver, this.surfaces.representativeAt(level - 1, child), distance, angle);
        const weight = select(this.surfaces.contains(level - 1, child), exp2(exponent.negate()), float(0)).toVar();
        // 子の先頭の帯は段 level − 1 の帯で、段 level へは持ち上げない。
        const [, ...bands] = bandsAt(finer, count - level + 1, child);
        return { weight, bands };
      });
      for (const [index, value] of packedBands(weightedBands(children)).entries()) outputs[index]!.assign(value);
    });
    return outputs;
  }

  // 段 level の描いている画素の C_level(rgb)。段 level の帯を詰めたテクスチャ own(帯 level..count − 1)の帯 level に、
  // 段 level + 1 の C(coarse の rgb)を囲む 4 画素から双線形の重み × 面の重みで拡大して足し、重みの欠けた分を own の
  // 帯 level + 1 以降の和で埋める。段 level の代表に面がなければ 0。**Fn の中から呼ぶこと。**
  public merged(coarse: THREE.Texture, own: readonly THREE.Texture[], count: number, level: number): Vec3Node {
    const pixel = ivec2(floor(screenUV.mul(screenSize))).toVar();
    const representative = this.surfaces.representativeAt(level, pixel).toVar();
    const result = vec3(0).toVar();
    If(this.surfaces.hasSurface(representative), () => {
      const receiver = this.weight.receiverAt(representative);
      // 段 level + 1 の 4 画素の重みは、双線形の重み × その代表を段 level の代表と比べた面の重み(画面の外は 0)。
      const { distance, angle } = this.toleranceAt(level + 1);
      const upsampled = coarseNeighbors(vec2(pixel)).map(({ texel, weight }) => {
        const parent = ivec2(texel).toVar();
        const exponent = this.weight.exponentOf(
          receiver, this.surfaces.representativeAt(level + 1, parent), distance, angle);
        const surfaceWeight = select(this.surfaces.contains(level + 1, parent), exp2(exponent.negate()), float(0));
        return { weight: weight.mul(surfaceWeight).toVar(), value: textureLoad(coarse, parent).rgb };
      });
      // 段 level の帯 level と、重みの欠けた分を埋める帯 level + 1 以降の和。
      const [direct, ...farther] = bandsAt(own, count - level, pixel);
      result.assign(mergedCorrection(direct!, farther.reduce((sum, band) => sum.add(band)), upsampled));
    });
    return result;
  }

  // 段 level の画素どうしを面の重みで比べる許容 — 接平面からの距離の許容 distance [受け手の足跡](c_z × 段 level の
  // 画素の幅 [全解像度の画素])と、法線の重みが半分になる角 angle [rad](θ_1·r^(level − 1))。
  private toleranceAt(level: number): { readonly distance: FloatNode; readonly angle: FloatNode } {
    const pixelWidth = this.fullSize.x.div(this.scanSize.x).mul(2 ** level);
    return {
      distance: pixelWidth.mul(DISTANCE_TOLERANCE_SCALE),
      angle: float(FIRST_HALF_WEIGHT_ANGLE * HALF_WEIGHT_ANGLE_RATIO ** (level - 1)),
    };
  }
}
