// 画面距離の帯ごとに分けた近傍拡散補正の、描画先への詰め方と、段ごとの縮小、粗い段からの拡大と合流。帯 b の rgb は、
// RGBA のテクスチャを並べた通しのチャンネル 3b..3b + 2 へ順に詰め、段 1 以降は実効画素数(値の分散が走査の 1 画素の何分の
// 1 か)を最後のテクスチャの w に持つ。段 m の画素は走査の 2^m 画素四方を受け持って帯 m 以降を持ち、段の画素どうしは代表の
// 面の重みで比べる。
import type * as THREE from 'three/webgpu';
import {
  If, clamp, exp2, float, floor, ivec2, max, min, screenSize, screenUV, select, textureLoad, vec2, vec3, vec4,
} from 'three/tsl';
import type { ScreenSpaceInputPyramid } from './screen-space-input-pyramid';
import type { SurfaceWeight } from './surface-weight';
import type { Texel } from './texel-surface';
import type { BoolNode, FloatNode, Vec2Node, Vec3Node, Vec4Node } from '../../tsl-types';

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

// チャンネルの数 channels を詰める RGBA のテクスチャの枚数。
function textureCountOf(channels: number): number {
  return Math.ceil(channels / CHANNELS_PER_TEXTURE);
}

// 帯の数 count の段 level の帯を詰める RGBA のテクスチャの枚数。段 1 以降は実効画素数のチャンネルを 1 つ足して数える。
export function packedTextureCount(count: number, level: number): number {
  return textureCountOf(3 * (count - level) + (level === 0 ? 0 : 1));
}

// チャンネルの並び channels を、RGBA のテクスチャの並びへ順に詰める。最後のテクスチャの余りのチャンネルは 0。
function packedChannels(channels: readonly FloatNode[]): Vec4Node[] {
  const channelAt = (index: number): FloatNode => channels[index] ?? float(0);
  return Array.from({ length: textureCountOf(channels.length) }, (_, texture) => {
    const first = texture * CHANNELS_PER_TEXTURE;
    return vec4(channelAt(first), channelAt(first + 1), channelAt(first + 2), channelAt(first + 3));
  });
}

// 段 0 の帯ごとの補正 bands を、packedTextureCount 枚の RGBA へ詰める。余りのチャンネルは 0。
export function packedBands(bands: readonly Vec3Node[]): Vec4Node[] {
  return packedChannels(bands.flatMap((band) => [band.x, band.y, band.z]));
}

// 段 1 以降の帯ごとの補正 bands と実効画素数 effectivePixels を、packedTextureCount 枚の RGBA へ詰める。帯は packedBands と
// 同じ並びで、実効画素数は最後のテクスチャの w。余りのチャンネルは 0。
export function packedReducedBands(bands: readonly Vec3Node[], effectivePixels: FloatNode): Vec4Node[] {
  const channels = bands.flatMap((band) => [band.x, band.y, band.z]);
  const padding = textureCountOf(channels.length + 1) * CHANNELS_PER_TEXTURE - channels.length - 1;
  return packedChannels([...channels, ...Array.from({ length: padding }, () => float(0)), effectivePixels]);
}

// packedBands か packedReducedBands で詰めた値 packed から、count 個の帯ごとの補正を取り出す。
export function unpackedBands(packed: readonly Vec4Node[], count: number): Vec3Node[] {
  const channels: FloatNode[] = packed.flatMap((value) => [value.x, value.y, value.z, value.w]);
  return Array.from({ length: count }, (_, band) => {
    const [r, g, b] = channels.slice(3 * band, 3 * band + 3);
    return vec3(r!, g!, b!);
  });
}

// 帯の数 count の段 level の帯を詰めて描いたテクスチャ textures の画素 texel の、帯 level..count − 1 の補正 bands と
// 実効画素数 effectivePixels(段 0 は 1)。
export function levelAt(
  textures: readonly THREE.Texture[], count: number, level: number, texel: Texel,
): { readonly bands: Vec3Node[]; readonly effectivePixels: FloatNode } {
  const packed = textures.map((texture) => textureLoad(texture, texel));
  return {
    bands: unpackedBands(packed, count - level),
    effectivePixels: level === 0 ? float(1) : packed.at(-1)!.w,
  };
}

// 段 k の画素を含む段 k + 1 の画素を中心とした 3×3 の親と、[1, 2, 1]⊗[1, 2, 1]/16 の重み。
export function tentNeighbors(pixel: Vec2Node): { readonly texel: Vec2Node; readonly weight: FloatNode }[] {
  const center = floor(pixel.mul(0.5));
  const taps = [1, 2, 1] as const;
  return [-1, 0, 1].flatMap((dy, y) => [-1, 0, 1].map((dx, x) => ({
    texel: center.add(vec2(dx, dy)), weight: float(taps[x]! * taps[y]! / 16),
  })));
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

// 子ごとの重み weight と実効画素数 effectivePixels(1 未満は 1 とみなす)から、子の重み付き平均の実効画素数
// (Σw)² / Σ(w² / n)。重みの和が WEIGHT_EPSILON 以下なら 0。
export function effectivePixelsOf(
  children: readonly { readonly weight: FloatNode; readonly effectivePixels: FloatNode }[],
): FloatNode {
  const total = children.map(({ weight }) => weight).reduce((sum, weight) => sum.add(weight));
  // 重み付きの和 Σw·x の分散 [走査の 1 画素の分散]。
  const sumVariance = children.map(({ weight, effectivePixels }) => weight.mul(weight).div(max(effectivePixels, 1)))
    .reduce((sum, variance) => sum.add(variance));
  return select(total.greaterThan(WEIGHT_EPSILON), total.mul(total).div(sumVariance), float(0));
}

// 段 k の画素を囲む段 k + 1 の親 1 つ — 空間補間の重み、その代表を段 k の代表と比べた面の重み surface
// (w。画面の外は 0)、C_{k+1} の値 value とその実効画素数 effectivePixels(1 未満は 1 とみなす)、C_{k+1} のうち最も粗い
// 段まで均された割合 smoothedShare(A_{k+1}。最も粗い段は 1)、段 k の画素を含むか containsPixel。
export interface ParentPixel {
  readonly interpolationWeight: FloatNode;
  readonly surface: FloatNode;
  readonly value: Vec3Node;
  readonly effectivePixels: FloatNode;
  readonly smoothedShare: FloatNode;
  readonly containsPixel: BoolNode;
}

// 段 k の拡大と合流の出力 C_k = D_k + α·Ū + (1 − α)·T_k と、そのうち最も粗い段まで均された割合 A_k = α·Ā_{k+1}
// (遠い帯の値のうち、どの段の合流でも均す前の値に置き換わらなかった割合)。direct は D_k(段 k の帯 k)、remainder は
// T_k(段 k の帯 k + 1 以降の和)、remainderPixels はその実効画素数、parents は親候補とその空間補間重み・面の重み・値・
// 実効画素数・均された割合を持つ。Ū と Ā_{k+1} はテント×面の重みで正規化した平均、α は面の重みで見た面の確からしさと
// T_k・Ū の分散から決まる縮小推定の比。
export function mergedCorrection(
  direct: Vec3Node, remainder: Vec3Node, remainderPixels: FloatNode, parents: readonly ParentPixel[],
): { readonly correction: Vec3Node; readonly smoothedShare: FloatNode } {
  // テントと面の重みの積を和が 1 になるよう正規化する。
  const weights: FloatNode[] = parents.map(({ interpolationWeight, surface }) => interpolationWeight.mul(surface).toVar());
  const total = weights.reduce((sum, weight) => sum.add(weight));
  const terms = parents.map((parent, index) => ({
    parent, share: weights[index]!.div(max(total, WEIGHT_EPSILON)).toVar(), pixels: max(parent.effectivePixels, 1),
  }));
  // 面が合う確からしさ π と、親の平均 Ū とその分散 V_U [走査の 1 画素の分散]。
  const confidence = terms.map(({ parent, share }) => share.mul(parent.surface)).reduce((a, b) => a.add(b));
  const mean = terms.map(({ parent, share }) => parent.value.mul(share)).reduce((a, b) => a.add(b));
  const meanVariance = terms.map(({ share, pixels }) => share.mul(share).div(pixels)).reduce((a, b) => a.add(b));
  // T_k の分散 V_T と、Ū との共分散。T_k が Ū に占める重みは、自分を含む親の中で T_k が占める割合を実効画素数の比で
  // 見積もったもの。T_k の標本は Ū にも入っている — 共分散を省くと、平らな所でも均していない T_k が混ざる。
  const remainderVariance = float(1).div(remainderPixels);
  const overlap = terms.map(({ parent, share, pixels }) =>
    select(parent.containsPixel, share.mul(remainderPixels).div(pixels), float(0))).reduce((a, b) => a.add(b));
  // 共分散の見積もりは V_U と V_T の小さいほうで抑える — 超えると比の分母が負へ回り、比が 1 から 0 へ跳ぶ。この範囲なら比は
  // 0〜1 に収まる。
  const covariance = min(overlap.mul(remainderVariance), min(meanVariance, remainderVariance));
  // T_k と Ū の凸結合の二乗誤差を最小にする比(経験ベイズの縮小推定)。
  const differenceVariance = meanVariance.add(remainderVariance).sub(covariance.mul(2));
  const shrinkage = clamp(remainderVariance.sub(covariance).div(max(differenceVariance, WEIGHT_EPSILON)), 0, 1);
  const ratio = confidence.mul(shrinkage).toVar();
  const parentShare = terms.map(({ parent, share }) => parent.smoothedShare.mul(share)).reduce((a, b) => a.add(b));
  return {
    correction: direct.add(mean.mul(ratio)).add(remainder.mul(ratio.oneMinus())),
    smoothedShare: ratio.mul(parentShare),
  };
}

// 帯の縮小と、粗い段からの拡大と合流を組む。段の画素どうしは、代表の面の重みで比べる。
export class BandPyramid {
  // surfaces は段ごとの代表の面、weight は面の重み、fullSize と scanSize は描画バッファと走査の解像度 [px]。
  public constructor(
    private readonly surfaces: ScreenSpaceInputPyramid, private readonly weight: SurfaceWeight,
    private readonly fullSize: Vec2Node, private readonly scanSize: Vec2Node,
  ) {}

  // 段 level(1 以上)の描いている画素の、帯 level..count − 1 と実効画素数を詰めた値(packedReducedBands の並び)。段
  // level − 1 の帯を詰めたテクスチャ finer(帯 level − 1..count − 1)の 4 つの子の帯を、子の代表を段 level の代表と比べた
  // 面の重みで平均する。段 level の代表に面がなければ 0。**Fn の中から呼ぶこと。**
  public reduced(finer: readonly THREE.Texture[], count: number, level: number): Vec4Node[] {
    const pixel = ivec2(floor(screenUV.mul(screenSize))).toVar();
    const representative = this.surfaces.surfaceAt(level, pixel);
    const outputs = Array.from({ length: packedTextureCount(count, level) }, () => vec4(0).toVar());
    If(representative.depth.greaterThan(0), () => {
      const receiver = this.weight.receiverAt(representative);
      const { distance, angle } = this.toleranceAt(level);
      // 子の代表自身は重み 1 なので、重みの和は 1 以上。
      const children = this.surfaces.childrenOf(pixel).map((child) => {
        const exponent = this.weight.exponentOf(receiver, this.surfaces.surfaceAt(level - 1, child), distance, angle);
        const weight = select(this.surfaces.contains(level - 1, child), exp2(exponent.negate()), float(0)).toVar();
        // 子の先頭の帯は段 level − 1 の帯で、段 level へは持ち上げない。
        const { bands: [, ...bands], effectivePixels } = levelAt(finer, count, level - 1, child);
        return { weight, bands, effectivePixels };
      });
      const packed = packedReducedBands(weightedBands(children), effectivePixelsOf(children));
      for (const [index, value] of packed.entries()) outputs[index]!.assign(value);
    });
    return outputs;
  }

  // 段 level の描いている画素の、拡大と合流の出力 — rgb は C_level、α は最も粗い段まで均された割合 A_level。段 level の帯を
  // 詰めたテクスチャ own(帯 level..count − 1)、段 level + 1 の C と A を持つテクスチャ coarse(最も粗い段ならその段の帯)、
  // 段 level + 1 の帯を詰めたテクスチャ coarseBands から、3×3 テントの9親を使って mergedCorrection で求める。
  // 段 level の代表に面がなければ 0。
  // **Fn の中から呼ぶこと。**
  public merged(
    coarse: THREE.Texture, coarseBands: readonly THREE.Texture[], own: readonly THREE.Texture[], count: number,
    level: number,
  ): Vec4Node {
    const pixel = ivec2(floor(screenUV.mul(screenSize))).toVar();
    const representative = this.surfaces.surfaceAt(level, pixel);
    const result = vec4(0).toVar();
    If(representative.depth.greaterThan(0), () => {
      const receiver = this.weight.receiverAt(representative);
      // 親の面の重みは、その代表を段 level の代表と比べたもの(画面の外は 0)。
      const { distance, angle } = this.toleranceAt(level + 1);
      const containing = pixel.div(2);
      const parents = tentNeighbors(vec2(pixel)).map(({ texel, weight }): ParentPixel => {
        const parent = ivec2(texel).toVar();
        const exponent = this.weight.exponentOf(receiver, this.surfaces.surfaceAt(level + 1, parent), distance, angle);
        const coarseValue = textureLoad(coarse, parent);
        return {
          interpolationWeight: weight,
          surface: select(this.surfaces.contains(level + 1, parent), exp2(exponent.negate()), float(0)).toVar(),
          value: coarseValue.rgb,
          effectivePixels: textureLoad(coarseBands.at(-1)!, parent).w,
          smoothedShare: level + 1 === count - 1 ? float(1) : coarseValue.w,
          containsPixel: parent.x.equal(containing.x).and(parent.y.equal(containing.y)),
        };
      });
      // 段 level の帯 level と、帯 level + 1 以降の和。
      const { bands: [direct, ...farther], effectivePixels } = levelAt(own, count, level, pixel);
      const remainder = farther.reduce((sum, band) => sum.add(band));
      const { correction, smoothedShare } = mergedCorrection(direct!, remainder, effectivePixels, parents);
      result.assign(vec4(correction, smoothedShare));
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
