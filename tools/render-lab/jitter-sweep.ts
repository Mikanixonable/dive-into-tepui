// 静止したカメラで、近傍拡散補正を位相の列で描き直して撮る道具。位相ごとの 1 パスと列の平均からの偏差、列の平均・
// 画素ごとの標準偏差・最大偏差の地図、位相を順に履歴の上限ごとの指数移動平均で積んだ列とその隣り合うフレームの差を、
// PNG と要約で返す。
import { differenceSummaryOf, type DifferenceSummary } from './reference-reprojection';
import { amplified } from './motion-sequence';
import { PRODUCTION_PHASE, type CorrectionPhase } from './phase-sequence';
import type { FloatImage, LabView } from './lab';

// 画素ごとの最大偏差 / 標準偏差を読む上側の分位。
const HOT_SPOT_PERCENTILE = 0.999;
// 標準偏差がこの比(列の標準偏差の RMS に対する)より小さい画素は、最大偏差 / 標準偏差に数えない。
const HOT_SPOT_STD_FLOOR = 1e-3;

// 履歴の上限 1 つの指数移動平均に位相 1 つを積んだ記録。image は積んだ補正(残さないときは null)、difference は 1 つ前からの差
// (×4)、summary はその差の要約(どちらも最初の位相では null)。
export interface AccumulatedRecord {
  readonly image: string | null;
  readonly difference: string | null;
  readonly summary: DifferenceSummary | null;
}

// 位相 1 つの記録。pass は 1 パスの補正、deviation は列の平均からの偏差(×4)、deviationSummary はその要約(値は列の平均)、
// accumulated は履歴の上限(10 進の文字列)ごとの指数移動平均。PNG はデータ URL で、符号付きの表示。
export interface SweepFrameRecord {
  readonly pass: string;
  readonly deviation: string;
  readonly deviationSummary: DifferenceSummary;
  readonly accumulated: Readonly<Record<string, AccumulatedRecord>>;
}

// 列の要約。どれも面のある画素での、q = 露出係数·ΔE/π の成分の値。
export interface SweepSummary {
  readonly surfaceCount: number;
  // 列の平均の RMS、画素ごとの標準偏差の RMS、画素ごとの最大偏差の RMS。
  readonly meanRms: number;
  readonly stdRms: number;
  readonly maxDeviationRms: number;
  // 画素ごとの最大偏差 / 標準偏差の中央値と、上側 HOT_SPOT_PERCENTILE の分位。
  readonly hotSpotRatioMedian: number;
  readonly hotSpotRatioPercentile: number;
  // 格子のずらしの位相ごとの偏差のうち、列の平均をその位相のずれだけ平行移動した差で説明できる割合(最小二乗)の、ずれの
  // ある位相についての平均。格子のずらしを含まない列では null。
  readonly translationExplained: number | null;
}

// 列 1 つの記録。mean・std・maxDeviation は列の平均・画素ごとの標準偏差(×4)・最大偏差(×4)の PNG。
export interface SweepRecord {
  readonly frames: readonly SweepFrameRecord[];
  readonly mean: string;
  readonly std: string;
  readonly maxDeviation: string;
  readonly summary: SweepSummary;
}

// 指数移動平均 1 つの状態 — 積んだ補正と、1 つ前の位相の積んだ補正。
interface Accumulation {
  readonly historyCap: number;
  readonly image: FloatImage;
  previous: FloatImage | null;
}

export class JitterSweep {
  public constructor(private readonly view: LabView) {}

  // いまの絵を位相の列 phases で描き直して撮る。historyCaps は模擬の蓄積の履歴の上限 [フレーム] の並び、imagedHistoryCaps は
  // そのうち積んだ補正の PNG も残すもの、cellSize は走査の画素の幅 [描画バッファの画素]。終わると位相は本番の静止画のものへ戻る。
  public async sweep(
    phases: readonly CorrectionPhase[], historyCaps: readonly number[], imagedHistoryCaps: readonly number[],
    cellSize: number,
  ): Promise<SweepRecord> {
    if (phases.length === 0) throw new RangeError('render-lab: a sweep needs at least one phase');
    // 面のある画素は、本番の静止画の深度で決める。
    this.view.renderCorrection(PRODUCTION_PHASE);
    const depth = await this.view.readFloat('depth');
    const { width, height } = depth;
    const mask = Uint8Array.from({ length: width * height }, (_, p) => (depth.rgba[4 * p]! > 0 ? 1 : 0));
    const surfaceCount = mask.reduce((sum, v) => sum + v, 0);
    const scale = this.view.exposureFactor / Math.PI;

    // 1 巡目 — 列の和・二乗和・最小・最大から、平均・標準偏差・最大偏差の地図。
    const statistics = new SweepStatistics(width, height);
    for (const phase of phases) statistics.add(await this.correctionOf(phase));
    const mean = maskedImage(statistics.mean(), width, height, mask);
    const std = maskedImage(statistics.std(), width, height, mask);
    const maxDeviation = maskedImage(statistics.maxDeviation(), width, height, mask);

    // 2 巡目 — 位相ごとの偏差と、履歴の上限ごとの指数移動平均。同じ入力からは同じ画像になるので、描き直した値は 1 巡目と一致する。
    const accumulations: Accumulation[] = historyCaps.map((historyCap) => ({
      historyCap, image: { width, height, rgba: new Float32Array(width * height * 4) }, previous: null,
    }));
    const frames: SweepFrameRecord[] = [];
    const explained: number[] = [];
    for (const [k, phase] of phases.entries()) {
      const correction = await this.correctionOf(phase);
      const deviation = maskedImage(subtracted(correction.rgba, mean.rgba), width, height, mask);
      if (phase.scanJitter?.kind === 'grid') {
        const fraction = translationExplainedOf(deviation, mean, mask, phase.scanJitter.fraction, cellSize);
        if (fraction !== null) explained.push(fraction);
      }
      const accumulated: Record<string, AccumulatedRecord> = {};
      for (const accumulation of accumulations) {
        accumulated[String(accumulation.historyCap)] = await this.accumulate(
          accumulation, correction, k, mask, mean, surfaceCount, scale, imagedHistoryCaps.includes(accumulation.historyCap));
      }
      frames.push({
        pass: await this.view.signedCorrectionPng(correction),
        deviation: await this.view.signedCorrectionPng(amplified(deviation)),
        deviationSummary: differenceSummaryOf(deviation, mean, surfaceCount, scale),
        accumulated,
      });
    }
    this.view.renderCorrection(PRODUCTION_PHASE);
    return {
      frames,
      mean: await this.view.signedCorrectionPng(mean),
      std: await this.view.signedCorrectionPng(amplified(std)),
      maxDeviation: await this.view.signedCorrectionPng(amplified(maxDeviation)),
      summary: {
        surfaceCount,
        meanRms: maskedRms(mean, mask, scale),
        stdRms: maskedRms(std, mask, scale),
        maxDeviationRms: maskedRms(maxDeviation, mask, scale),
        ...hotSpotRatiosOf(maxDeviation, std, mask),
        translationExplained: explained.length === 0 ? null : explained.reduce((sum, v) => sum + v, 0) / explained.length,
      },
    };
  }

  // 位相 phase で描き直した最後の拡大の出力。
  private async correctionOf(phase: CorrectionPhase): Promise<FloatImage> {
    this.view.renderCorrection(phase);
    return this.view.readFloat('upsampled-correction');
  }

  // 指数移動平均 accumulation へ k 番目の位相の補正 correction を積み、1 つ前からの差を要約する。新しい位相の重みは
  // 1 / min(k + 1, 履歴の上限)。
  private async accumulate(
    accumulation: Accumulation, correction: FloatImage, k: number, mask: Uint8Array, mean: FloatImage,
    surfaceCount: number, scale: number, imaged: boolean,
  ): Promise<AccumulatedRecord> {
    // 積んでから、1 つ前の積んだ補正との差を取る。
    const { image } = accumulation;
    const weight = 1 / Math.min(k + 1, accumulation.historyCap);
    for (let i = 0; i < image.rgba.length; i++) image.rgba[i] = image.rgba[i]! + weight * (correction.rgba[i]! - image.rgba[i]!);
    const previous = accumulation.previous;
    accumulation.previous = { ...image, rgba: image.rgba.slice() };
    const difference = previous === null
      ? null : maskedImage(subtracted(image.rgba, previous.rgba), image.width, image.height, mask);
    // 差の要約の「値」は列の平均。
    return {
      image: imaged ? await this.view.signedCorrectionPng(maskedImage(image.rgba, image.width, image.height, mask)) : null,
      difference: difference === null || !imaged ? null : await this.view.signedCorrectionPng(amplified(difference)),
      summary: difference === null ? null : differenceSummaryOf(difference, mean, surfaceCount, scale),
    };
  }
}

// 列の和・二乗和・最小・最大を画素と成分ごとに積む器。
class SweepStatistics {
  private readonly sum: Float64Array;
  private readonly squares: Float64Array;
  private readonly minimum: Float32Array;
  private readonly maximum: Float32Array;
  private count = 0;

  // width × height の RGBA の画像を積む器。
  public constructor(width: number, height: number) {
    const length = width * height * 4;
    this.sum = new Float64Array(length);
    this.squares = new Float64Array(length);
    this.minimum = new Float32Array(length).fill(Number.POSITIVE_INFINITY);
    this.maximum = new Float32Array(length).fill(Number.NEGATIVE_INFINITY);
  }

  // 画像 image を積む。
  public add(image: FloatImage): void {
    for (let i = 0; i < image.rgba.length; i++) {
      const value = image.rgba[i]!;
      this.sum[i] = this.sum[i]! + value;
      this.squares[i] = this.squares[i]! + value * value;
      this.minimum[i] = Math.min(this.minimum[i]!, value);
      this.maximum[i] = Math.max(this.maximum[i]!, value);
    }
    this.count++;
  }

  // 平均。
  public mean(): Float32Array {
    return Float32Array.from(this.sum, (v) => v / this.count);
  }

  // 画素と成分ごとの標準偏差(平均からの偏差の二乗の平均の平方根)。
  public std(): Float32Array {
    return Float32Array.from(this.sum, (sum, i) => Math.sqrt(Math.max(this.squares[i]! / this.count - (sum / this.count) ** 2, 0)));
  }

  // 画素と成分ごとの、平均からの偏差の絶対値の最大。
  public maxDeviation(): Float32Array {
    return Float32Array.from(this.sum, (sum, i) => {
      const mean = sum / this.count;
      return Math.max(this.maximum[i]! - mean, mean - this.minimum[i]!);
    });
  }
}

// 画素ごとの値 rgba(α は捨てる)を、面のある画素で α = 1、ほかで 0 と rgb = 0 にした画像。
export function maskedImage(rgba: Float32Array, width: number, height: number, mask: Uint8Array): FloatImage {
  const out = new Float32Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    if (mask[p] === 0) continue;
    for (let c = 0; c < 3; c++) out[4 * p + c] = rgba[4 * p + c]!;
    out[4 * p + 3] = 1;
  }
  return { width, height, rgba: out };
}

// a − b。
function subtracted(a: Float32Array, b: Float32Array): Float32Array {
  return Float32Array.from(a, (v, i) => v - b[i]!);
}

// 面のある画素の rgb の、尺度 scale を掛けた RMS。
export function maskedRms(image: FloatImage, mask: Uint8Array, scale: number): number {
  let squares = 0;
  let count = 0;
  for (let p = 0; p < mask.length; p++) {
    if (mask[p] === 0) continue;
    for (let c = 0; c < 3; c++) squares += (scale * image.rgba[4 * p + c]!) ** 2;
    count += 3;
  }
  return count === 0 ? 0 : Math.sqrt(squares / count);
}

// 面のある画素の成分ごとの最大偏差 / 標準偏差(標準偏差が列の RMS × HOT_SPOT_STD_FLOOR 以上のもの)の中央値と上側の分位。
function hotSpotRatiosOf(
  maxDeviation: FloatImage, std: FloatImage, mask: Uint8Array,
): Pick<SweepSummary, 'hotSpotRatioMedian' | 'hotSpotRatioPercentile'> {
  // 画素と成分ごとの比を集めて並べ替える。
  const floor = maskedRms(std, mask, 1) * HOT_SPOT_STD_FLOOR;
  const ratios: number[] = [];
  for (let p = 0; p < mask.length; p++) {
    if (mask[p] === 0) continue;
    for (let c = 0; c < 3; c++) {
      const deviation = std.rgba[4 * p + c]!;
      if (deviation >= floor) ratios.push(maxDeviation.rgba[4 * p + c]! / deviation);
    }
  }
  const sorted = Float64Array.from(ratios).sort();
  const at = (fraction: number): number => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!);
  return { hotSpotRatioMedian: at(0.5), hotSpotRatioPercentile: at(HOT_SPOT_PERCENTILE) };
}

// 偏差 deviation のうち、平均 mean を格子のずらし fraction(ブロックの中の位置)のずれ(ブロックの中心からの画素数)だけ
// 平行移動した差で説明できる割合(最小二乗で当てた成分の二乗の割合)。ずれが 0 なら null。
function translationExplainedOf(
  deviation: FloatImage, mean: FloatImage, mask: Uint8Array, fraction: readonly [number, number], cellSize: number,
): number | null {
  const [dx, dy] = fraction.map((f) => Math.round((f - 0.5) * cellSize));
  if (dx === 0 && dy === 0) return null;
  // 偏差と「ずらした平均 − 平均」の内積と、それぞれの二乗和を、両方に面のある画素で積む。
  const { width, height } = mean;
  let cross = 0;
  let deviationSquares = 0;
  let shiftSquares = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = x + dx!;
      const sy = y + dy!;
      if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
      const p = y * width + x;
      const q = sy * width + sx;
      if (mask[p] === 0 || mask[q] === 0) continue;
      for (let c = 0; c < 3; c++) {
        const shift = mean.rgba[4 * q + c]! - mean.rgba[4 * p + c]!;
        const value = deviation.rgba[4 * p + c]!;
        cross += value * shift;
        deviationSquares += value * value;
        shiftSquares += shift * shift;
      }
    }
  }
  return deviationSquares === 0 || shiftSquares === 0 ? 0 : cross * cross / (deviationSquares * shiftSquares);
}
