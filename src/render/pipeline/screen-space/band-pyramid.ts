// 画面距離の帯ごとに分けた近傍拡散補正の詰め方と、段ごとの縮小、粗い段からの拡大と合流。帯の rgb は半精度の通しのチャンネルか、
// 1 語ずつの符号付き μ-law で持つ。実効画素数は半精度では最後のテクスチャの w、語詰めでは最後の語として持つ。段 m の画素は
// 走査の 2^m 画素四方を受け持って帯 m 以降を持ち、段の画素どうしは代表の面の重みで比べる。
import * as THREE from 'three/webgpu';
import {
  If, clamp, exp, exp2, float, floatBitsToUint, floor, ivec2, log, max, min, round, screenSize, screenUV, select, sign,
  textureLoad, uint, uintBitsToFloat, uvec4, vec2, vec3, vec4,
} from 'three/tsl';
import type { ScreenSpaceInputPyramid } from './screen-space-input-pyramid';
import type { SurfaceWeight } from './surface-weight';
import type { Texel } from './texel-surface';
import type { BoolNode, FloatNode, UintNode, UVec4Node, Vec2Node, Vec3Node, Vec4Node } from '../../tsl-types';

// 1 帯が持つ照り返しの rgb チャンネル数。描画先の枚数とバイト数はここから数える。
export const BAND_CHANNELS = 3;
// 帯の描画先の詰め方。
export type BandFormat =
  | 'packed-half' // 帯の rgb(段 1 以降は実効画素数も)を RGBA 半精度へ通しで詰める。
  | 'packed-word'; // 帯ごとに rgb を 1 語(11・11・10 bit の符号付き μ-law)へ詰め、rgba32uint へ通しで書く。

// 帯の数の段ごとの詰め方(layout[m] が段 m の形式。帯の数は layout.length)。
export type BandLayout = readonly BandFormat[];

// WebGPU の maxColorAttachments 既定。これを超える描画先はどの端末でも使えない。
const MAX_COLOR_ATTACHMENTS = 8;

export type TextureFormat = { readonly type: THREE.TextureDataType; readonly format: THREE.PixelFormat };

// 帯の数 count の段 level を format で詰める描画先の MRT 順の型・形式。
export function levelTextureFormats(count: number, level: number, format: BandFormat): readonly TextureFormat[] {
  const bandCount = count - level;
  if (format === 'packed-word') {
    const words = bandCount + (level === 0 ? 0 : 1);
    return Array.from({ length: Math.ceil(words / CHANNELS_PER_TEXTURE) }, () => ({
      type: THREE.UnsignedIntType, format: THREE.RGBAIntegerFormat,
    }));
  }
  const channels = bandCount * BAND_CHANNELS + (level === 0 ? 0 : 1);
  return Array.from({ length: textureCountOf(channels) }, () => ({ type: THREE.HalfFloatType, format: THREE.RGBAFormat }));
}

function attachmentFormatCost(format: TextureFormat): number {
  if (format.format === THREE.RGBAFormat && format.type === THREE.HalfFloatType) return 8;
  if (format.format === THREE.RGBAIntegerFormat && format.type === THREE.UnsignedIntType) return 16;
  throw new Error(`unsupported attachment format: ${format.format}/${format.type}`);
}

// WebGPU 規格の texture format caps にある render target pixel byte cost から MRT のバイト数を求める。
export function attachmentBytesOf(formats: readonly TextureFormat[]): number {
  let bytes = 0;
  for (const format of formats) bytes += attachmentFormatCost(format);
  return bytes;
}

// 帯の数 count の半精度の通しが上限 byteLimit [バイト/画素] に収まる段はそれ、超える段は語詰め。
export function bandLayoutOf(count: number, byteLimit: number): BandLayout {
  const layout = Array.from({ length: count }, (_, level): BandFormat => {
    const fits = (format: BandFormat): boolean => {
      const formats = levelTextureFormats(count, level, format);
      return formats.length <= MAX_COLOR_ATTACHMENTS && attachmentBytesOf(formats) <= byteLimit;
    };
    if (fits('packed-half')) return 'packed-half';
    if (fits('packed-word')) return 'packed-word';
    throw new Error(`screen-space: band level ${level} exceeds attachment limits`);
  });
  return layout;
}

// 符号付き μ-law の表示尺度の上限 V と μ。V は遠い帯の疎で明るい標本を切らない大きさにとる — 切ると、その欠けを
// 粗い段が広い斑として配る。μ は 0 付近の刻み V·ln(1 + μ)/((2^(b−1) − 1)μ)(b はチャンネルのビット数)を暗部の sRGB 1 LSB より十分小さくする。
const MU_LAW_DISPLAY_LIMIT = 256;
const MU_LAW_MU = 131072;
const MU_LAW_LOG_MU = Math.log(1 + MU_LAW_MU);

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

// チャンネルの並び channels を、RGBA のテクスチャの並びへ順に詰める。最後のテクスチャの余りのチャンネルは 0。
function packedChannels(channels: readonly FloatNode[]): Vec4Node[] {
  const channelAt = (index: number): FloatNode => channels[index] ?? float(0);
  return Array.from({ length: textureCountOf(channels.length) }, (_, texture) => {
    const first = texture * CHANNELS_PER_TEXTURE;
    return vec4(channelAt(first), channelAt(first + 1), channelAt(first + 2), channelAt(first + 3));
  });
}

// 段 0 の帯ごとの補正 bands を format の形式で詰める。packed-half の余りのチャンネルは 0。
export function packedBands(bands: readonly Vec3Node[], format: 'packed-word', exposureFactor: FloatNode): UVec4Node[];
export function packedBands(
  bands: readonly Vec3Node[], format: 'packed-half', exposureFactor: FloatNode,
): Vec4Node[];
export function packedBands(
  bands: readonly Vec3Node[], format: BandFormat, exposureFactor: FloatNode,
): (Vec4Node | UVec4Node)[];
export function packedBands(
  bands: readonly Vec3Node[], format: BandFormat, exposureFactor: FloatNode,
): (Vec4Node | UVec4Node)[] {
  if (format === 'packed-half') return packedChannels(bands.flatMap((band) => [band.x, band.y, band.z]));
  return packedWords(bands.map((band) => encodedWord(band, exposureFactor)));
}

// 露出で表示の尺度へ直した値 value を、−1..1 の符号付き μ-law の値へ変換する。
function signedMuLaw(value: Vec3Node): Vec3Node {
  return log(value.abs().div(MU_LAW_DISPLAY_LIMIT).clamp(0, 1).mul(MU_LAW_MU).add(1))
    .div(MU_LAW_LOG_MU).mul(sign(value)) as Vec3Node;
}

// −1..1 の値 value を b bit の符号値へ符号化する。0 は中央の符号値になる。
function encodedMagnitude(value: FloatNode, bits: number): FloatNode {
  const maximum = 2 ** (bits - 1) - 1;
  return round(value.mul(maximum).add(maximum));
}

// 帯 band を 1 語へ詰める。r は下位 11 bit、g は次の 11 bit、b は上位 10 bit を使う。
function encodedWord(band: Vec3Node, exposureFactor: FloatNode): UintNode {
  const displayed = band.mul(exposureFactor).div(Math.PI);
  const magnitude = signedMuLaw(displayed);
  const quantize = (value: FloatNode, bits: number): UintNode => uint(encodedMagnitude(value, bits));
  return quantize(magnitude.x, 11).bitOr(quantize(magnitude.y, 11).shiftLeft(uint(11)))
    .bitOr(quantize(magnitude.z, 10).shiftLeft(uint(22)));
}

// three の型定義は bitcast の結果を型の無いノードとして返すので、変換先の型を付ける。
function floatBitsToWord(value: FloatNode): UintNode {
  return floatBitsToUint(value) as unknown as UintNode;
}

// 語 value の bit 列を float として読み直す。
function wordBitsToFloat(value: UintNode): FloatNode {
  return uintBitsToFloat(value) as unknown as FloatNode;
}

// 語の並び words を rgba32uint の並びへ通しで詰める。最後に余った成分は 0 にする。
function packedWords(words: readonly UintNode[]): UVec4Node[] {
  // 語の並び words から index 番目を取り出し、範囲外なら 0 を返す。
  const wordAt = (index: number): UintNode => words[index] ?? uint(0);
  return Array.from({ length: Math.ceil(words.length / CHANNELS_PER_TEXTURE) }, (_, textureIndex) => {
    const first = textureIndex * CHANNELS_PER_TEXTURE;
    return uvec4(wordAt(first), wordAt(first + 1), wordAt(first + 2), wordAt(first + 3));
  });
}

// 符号付き μ-law の値を表示尺度へ戻す。
function decodedMuLaw(signed: Vec3Node): Vec3Node {
  return sign(signed).mul(exp(signed.abs().mul(MU_LAW_LOG_MU)).sub(1).div(MU_LAW_MU)) as Vec3Node;
}

// b bit の符号値 value を −1..1 の値へ戻す。
function signedWordMagnitude(value: UintNode, bits: number): FloatNode {
  const maximum = 2 ** (bits - 1) - 1;
  return value.toFloat().sub(maximum).div(maximum);
}

// 読込値 packed から index 番目の語を取り出す。
function wordAt(packed: readonly (Vec4Node | UVec4Node)[], index: number): UintNode {
  // three の型定義は整数テクスチャの textureLoad を vec4 とするが、packed-word の描画先は uvec4 を返す。
  const value = packed[Math.floor(index / CHANNELS_PER_TEXTURE)] as unknown as UVec4Node;
  return [value.x, value.y, value.z, value.w][index % CHANNELS_PER_TEXTURE]!;
}

// packed から count 個の帯を復号し、露出を戻す。
function unpackedWordBands(packed: readonly (Vec4Node | UVec4Node)[], count: number, exposureFactor: FloatNode): Vec3Node[] {
  return Array.from({ length: count }, (_, band) => {
    const word = wordAt(packed, band);
    const red = word.bitAnd(uint(2047));
    const green = word.shiftRight(uint(11)).bitAnd(uint(2047));
    const blue = word.shiftRight(uint(22)).bitAnd(uint(1023));
    const signed = vec3(signedWordMagnitude(red, 11), signedWordMagnitude(green, 11), signedWordMagnitude(blue, 10));
    return decodedMuLaw(signed)
      .mul(MU_LAW_DISPLAY_LIMIT).mul(Math.PI).div(exposureFactor);
  });
}

// 帯の数 count の段 level を format で詰めた読込値 packed から、帯 level..count − 1 を戻す。
function unpackedLevelBands(
  packed: readonly (Vec4Node | UVec4Node)[], count: number, level: number, format: BandFormat,
  exposureFactor: FloatNode,
): Vec3Node[] {
  return format === 'packed-word'
    ? unpackedWordBands(packed, count - level, exposureFactor)
    : unpackedBands(packed as readonly Vec4Node[], count - level);
}

// 縮小描画命令の帯と実効画素数(ない場合は null)を、format の形式へ詰める。半精度の通しでは最後のテクスチャの w、語詰めでは最後の語に持つ。
export function packedReducedBands(
  bands: readonly Vec3Node[], effectivePixels: FloatNode | null, format: 'packed-word', exposureFactor: FloatNode,
): UVec4Node[];
export function packedReducedBands(
  bands: readonly Vec3Node[], effectivePixels: FloatNode | null, format: 'packed-half', exposureFactor: FloatNode,
): Vec4Node[];
export function packedReducedBands(
  bands: readonly Vec3Node[], effectivePixels: FloatNode | null, format: BandFormat, exposureFactor: FloatNode,
): (Vec4Node | UVec4Node)[];
export function packedReducedBands(
  bands: readonly Vec3Node[], effectivePixels: FloatNode | null, format: BandFormat, exposureFactor: FloatNode,
): (Vec4Node | UVec4Node)[] {
  if (format === 'packed-word') {
    return packedWords([
      ...bands.map((band) => encodedWord(band, exposureFactor)),
      ...(effectivePixels === null ? [] : [floatBitsToWord(effectivePixels)]),
    ]);
  }
  if (effectivePixels === null) return packedChannels(bands.flatMap((band) => [band.x, band.y, band.z]));
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

// 帯の数 layout.length の段 level の画素 texel の、帯 level..count − 1 の補正と実効画素数(段 0 は 1)。
export function levelAt(
  textures: readonly THREE.Texture[], layout: BandLayout, level: number, texel: Texel, exposureFactor: FloatNode,
): { readonly bands: Vec3Node[]; readonly effectivePixels: FloatNode } {
  const format = layout[level]!;
  const packed = textures.map((texture) => textureLoad(texture, texel));
  const bands = unpackedLevelBands(packed, layout.length, level, format, exposureFactor);
  let effectivePixels: FloatNode = float(1);
  if (level > 0) {
    effectivePixels = format === 'packed-word'
      ? wordBitsToFloat(wordAt(packed, layout.length - level))
      : packed.at(-1)!.w;
  }
  return { bands, effectivePixels };
}

// 段 0 の読込値 packed を count 個の帯へ戻す。
export function scanBandsOf(
  packed: readonly (Vec4Node | UVec4Node)[], count: number, format: BandFormat, exposureFactor: FloatNode,
): Vec3Node[] {
  return unpackedLevelBands(packed, count, 0, format, exposureFactor);
}

// 2 倍の拡大で、子が親の画素の単位で端数 fraction にあるときの、端数を見るテントの 1 軸の重み（和は 1、偏りなし）。
export function phaseTentWeight(offset: -1 | 0 | 1, fraction: FloatNode): FloatNode {
  if (offset === -1) return float(0.5).sub(fraction).mul(0.5);
  if (offset === 0) return float(0.5);
  return float(0.5).add(fraction).mul(0.5);
}

// 段 k の画素を含む段 k + 1 の画素を中心とした 3×3 の親を、端数を見るテントで合流する。
export function mergeNeighbors(pixel: Vec2Node): { readonly texel: Vec2Node; readonly weight: FloatNode }[] {
  const center = floor(pixel.mul(0.5));
  const parity = pixel.sub(center.mul(2));
  const fraction = vec2(
    select(parity.x.equal(0), float(-0.25), float(0.25)),
    select(parity.y.equal(0), float(-0.25), float(0.25)),
  );
  const offsets = [-1, 0, 1] as const;
  return offsets.flatMap((dy) => offsets.map((dx) => ({
    texel: center.add(vec2(dx, dy)),
    weight: phaseTentWeight(dx, fraction.x).mul(phaseTentWeight(dy, fraction.y)),
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
    // surfaces は段ごとの代表の面、weight は面の重み、fullSize と scanSize は描画バッファと走査の解像度 [px]。帯の値を段ごとに縮小・合流する。
  public constructor(
    private readonly surfaces: ScreenSpaceInputPyramid, private readonly weight: SurfaceWeight,
    private readonly fullSize: Vec2Node, private readonly scanSize: Vec2Node,
    private readonly exposureFactor: FloatNode,
  ) {}

  // 段 level(1 以上)の描いている画素の、帯 level..count − 1 と実効画素数を詰めた値(packedReducedBands の並び)。段
  // level − 1 の帯を詰めたテクスチャ finer(帯 level − 1..count − 1)の 4 つの子の帯を、子の代表を段 level の代表と比べた
  // 面の重みで平均する。段 level の代表に面がなければ 0。**Fn の中から呼ぶこと。**
  public reduced(finer: readonly THREE.Texture[], layout: BandLayout, level: number): (Vec4Node | UVec4Node)[] {
    const pixel = ivec2(floor(screenUV.mul(screenSize))).toVar();
    const representative = this.surfaces.surfaceAt(level, pixel);
    const reduced = () => {
      const receiver = this.weight.receiverAt(representative);
      const { distance, angle } = this.toleranceAt(level);
      // 子の代表自身は重み 1 なので、重みの和は 1 以上。
      const children = this.surfaces.childrenOf(pixel).map((child) => {
        const exponent = this.weight.exponentOf(receiver, this.surfaces.surfaceAt(level - 1, child), distance, angle);
        const weight = select(this.surfaces.contains(level - 1, child), exp2(exponent.negate()), float(0)).toVar();
        // 子の先頭の帯は段 level − 1 の帯で、段 level へは持ち上げない。
        const { bands, effectivePixels } = levelAt(finer, layout, level - 1, child, this.exposureFactor);
        return { weight, bands: bands.slice(1), effectivePixels };
      });
      return { bands: weightedBands(children), effectivePixels: effectivePixelsOf(children) };
    };
    if (layout[level] === 'packed-word') {
      const outputs = Array.from({ length: levelTextureFormats(layout.length, level, layout[level]!).length }, () => uvec4(uint(0)).toVar());
      If(representative.depth.greaterThan(0), () => {
        const { bands, effectivePixels } = reduced();
        const packed = packedReducedBands(bands, effectivePixels, 'packed-word', this.exposureFactor);
        for (const [index, value] of packed.entries()) outputs[index]!.assign(value);
      });
      return outputs;
    }
    const outputs = Array.from({ length: levelTextureFormats(layout.length, level, layout[level]!).length }, () => vec4(0).toVar());
    If(representative.depth.greaterThan(0), () => {
      const { bands, effectivePixels } = reduced();
      const packed = packedReducedBands(bands, effectivePixels, 'packed-half', this.exposureFactor);
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
    coarse: THREE.Texture, coarseBands: readonly THREE.Texture[], own: readonly THREE.Texture[], layout: BandLayout,
    level: number,
  ): Vec4Node {
    const count = layout.length;
    const pixel = ivec2(floor(screenUV.mul(screenSize))).toVar();
    const representative = this.surfaces.surfaceAt(level, pixel);
    const result = vec4(0).toVar();
    If(representative.depth.greaterThan(0), () => {
      const receiver = this.weight.receiverAt(representative);
      // 親の面の重みは、その代表を段 level の代表と比べたもの(画面の外は 0)。
      const { distance, angle } = this.toleranceAt(level + 1);
      const containing = pixel.div(2);
      const parents = mergeNeighbors(vec2(pixel)).map(({ texel, weight }): ParentPixel => {
        const parent = ivec2(texel).toVar();
        const exponent = this.weight.exponentOf(receiver, this.surfaces.surfaceAt(level + 1, parent), distance, angle);
        const coarseValue = textureLoad(coarse, parent);
        return {
          interpolationWeight: weight,
          surface: select(this.surfaces.contains(level + 1, parent), exp2(exponent.negate()), float(0)).toVar(),
          value: coarseValue.rgb,
          effectivePixels: levelAt(coarseBands, layout, level + 1, parent, this.exposureFactor).effectivePixels,
          smoothedShare: level + 1 === count - 1 ? float(1) : coarseValue.w,
          containsPixel: parent.x.equal(containing.x).and(parent.y.equal(containing.y)),
        };
      });
      // 段 level の帯 level と、帯 level + 1 以降の和。
      const { bands: [direct, ...farther], effectivePixels } = levelAt(own, layout, level, pixel, this.exposureFactor);
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
