// 静止した場面で、近傍拡散補正の 1 パスと蓄積の後の時間方向の揺れを量る道具。番号を本番のジッターの列で進めながら描き、
// 画素ごとの時間平均・時間方向の標準偏差・隣り合うフレームの差と、1 パスから積んだ理想の指数移動平均との差を要約と PNG で返す。
import type { FloatImage, LabView } from './lab';
import { maskedImage, maskedRms } from './jitter-sweep';
import type { JitterSource } from '../../src/render/pipeline/screen-space/frame-jitter';

const JITTER_SOURCES: readonly JitterSource[] = ['seed', 'scanRepresentative'];
// 画素ごとの比を数える下限(1 パスの標準偏差の RMS に対する比)。揺れの無い画素の比を数えない。
const RATIO_STD_FLOOR = 1e-3;
// 標準偏差の地図の表示値を、1 パスの標準偏差の RMS の何倍で 1 にするかの逆数。
const PNG_STD_GAIN = 4;

// 要約。値はどれも面のある画素の、q = 露出係数·ΔE/π の rgb の成分の値で、RMS は画素・成分(差はフレームの組も)にわたる。
export interface StaticVarianceSummary {
  readonly surfaceCount: number;
  // 受けた履歴の上限(lab が描いた値)、スライス数、読んだフレームの数。
  readonly historyCap: number;
  readonly sliceCount: number;
  readonly frames: number;
  // 蓄積の後と 1 パスの時間平均の RMS。
  readonly meanRms: number;
  readonly passMeanRms: number;
  // 画素ごとの時間方向の標準偏差の RMS(1 パスは σ_S、蓄積の後は σ_t)。
  readonly passStdRms: number;
  readonly accumulatedStdRms: number;
  // 隣り合うフレームの差の RMS。
  readonly passDifferenceRms: number;
  readonly accumulatedDifferenceRms: number;
  // 画素・成分ごとの σ_t(p)/σ_S(p) と、(蓄積の後の差の RMS(p))/σ_S(p) の中央値と 99% 分位。
  readonly stdRatioMedian: number;
  readonly stdRatioPercentile99: number;
  readonly differenceRatioMedian: number;
  readonly differenceRatioPercentile99: number;
  // 蓄積の後と、1 パスから積んだ理想の指数移動平均との差の RMS と絶対値の最大。
  readonly emaErrorRms: number;
  readonly emaErrorMax: number;
  // 標準偏差の地図に掛けた倍率(表示値 = q の標準偏差 × pngScale)。
  readonly pngScale: number;
  readonly elapsedMs: number;
}

// 要約と、蓄積の後・1 パスの標準偏差の地図(データ URL)。
export interface StaticVarianceRecord {
  readonly summary: StaticVarianceSummary;
  readonly accumulatedStdPng: string;
  readonly passStdPng: string;
}

// 画素・成分ごとの和を積む器。
class Moments {
  public readonly passSum: Float64Array;
  public readonly passSquares: Float64Array;
  public readonly accumulatedSum: Float64Array;
  public readonly accumulatedSquares: Float64Array;
  public readonly passDifferenceSquares: Float64Array;
  public readonly accumulatedDifferenceSquares: Float64Array;
  public readonly emaErrorSquares: Float64Array;
  // 1 パスから積んだ理想の指数移動平均。読み始めのフレームで蓄積の後の値から始める。
  public readonly ema: Float64Array;
  public emaErrorMax = 0;

  // 画素・成分 length 個ぶんの器を 0 で作る。
  public constructor(length: number) {
    this.passSum = new Float64Array(length);
    this.passSquares = new Float64Array(length);
    this.accumulatedSum = new Float64Array(length);
    this.accumulatedSquares = new Float64Array(length);
    this.passDifferenceSquares = new Float64Array(length);
    this.accumulatedDifferenceSquares = new Float64Array(length);
    this.emaErrorSquares = new Float64Array(length);
    this.ema = new Float64Array(length);
  }
}

export class StaticVariance {
  public constructor(private readonly view: LabView) {}

  // いまのケースと描画設定(スライス数 sliceCount・履歴の上限 historyCap)のまま、番号 0 を d = ∞、以後 d = 0 で描き、最初の
  // 3·historyCap フレームを捨てて続く frames フレームを量る。pngScale は標準偏差の地図の倍率で、null なら 1 パスの標準偏差の RMS の
  // PNG_STD_GAIN 倍を 1 にする(返す要約に使った倍率が入る)。lab が描いた履歴の上限が historyCap と違えば投げる。
  public async capture(
    sliceCount: number, historyCap: number, frames: number, pngScale: number | null,
  ): Promise<StaticVarianceRecord> {
    if (!Number.isInteger(sliceCount) || sliceCount < 1) throw new RangeError('render-lab: slice count must be a positive integer');
    if (!Number.isInteger(historyCap) || historyCap < 1) throw new RangeError('render-lab: history cap must be a positive integer');
    if (!Number.isInteger(frames) || frames < 2) throw new RangeError('render-lab: static variance needs at least two measured frames');
    if (pngScale !== null && (!Number.isFinite(pngScale) || pngScale < 0)) {
      throw new RangeError('render-lab: PNG scale must be finite and nonnegative');
    }
    const startedAt = performance.now();
    // 読み込み途中の絵を履歴へ入れないよう落ち着かせてから、本番の源で番号を進める。範囲の外の上限が黙って既定へ戻っていないか確かめる。
    await this.view.captureSettled(`static variance ${sliceCount}x${historyCap} before accumulation`);
    this.view.setJitterSources(JITTER_SOURCES);
    if (this.view.historyCapFrames !== historyCap) {
      throw new Error(`render-lab: requested history cap ${historyCap}, got ${this.view.historyCapFrames}`);
    }
    // 面のある画素は深度で決める。
    const depth = await this.view.readFloat('depth');
    const { width, height } = depth;
    const mask = Uint8Array.from({ length: width * height }, (_, p) => (depth.rgba[4 * p]! > 0 ? 1 : 0));
    const surfaceCount = mask.reduce((sum, value) => sum + value, 0);
    if (surfaceCount === 0) throw new Error('render-lab: static variance found no surface pixels');

    const moments = await this.accumulate(historyCap, frames, mask, width * height * 4);
    const statistics = statisticsOf(moments, frames);
    const exposureScale = this.view.exposureFactor / Math.PI;
    const passStdRms = maskedRms(image(statistics.passStd, width, height), mask, exposureScale);
    const scale = pngScale ?? PNG_STD_GAIN / passStdRms;
    // 地図の表示は符号付きの補正の表示を通るので、q ではなく ΔE の標準偏差へ倍率を掛ける。
    const stdPng = (std: Float32Array): Promise<string> => this.view.signedCorrectionPng(
      maskedImage(Float32Array.from(std, (value) => value * scale / Math.PI), width, height, mask));
    const rms = (values: Float32Array): number => maskedRms(image(values, width, height), mask, exposureScale);
    return {
      summary: {
        surfaceCount,
        historyCap: this.view.historyCapFrames,
        sliceCount,
        frames,
        meanRms: rms(statistics.accumulatedMean),
        passMeanRms: rms(statistics.passMean),
        passStdRms,
        accumulatedStdRms: rms(statistics.accumulatedStd),
        passDifferenceRms: rms(statistics.passDifferenceRms),
        accumulatedDifferenceRms: rms(statistics.accumulatedDifferenceRms),
        ...ratioPercentilesOf(statistics, mask, width, height),
        emaErrorRms: rms(statistics.emaErrorRms),
        emaErrorMax: moments.emaErrorMax * exposureScale,
        pngScale: scale,
        elapsedMs: performance.now() - startedAt,
      },
      accumulatedStdPng: await stdPng(statistics.accumulatedStd),
      passStdPng: await stdPng(statistics.passStd),
    };
  }

  // 番号 0〜3·historyCap + frames − 1 を描き、後ろの frames フレームの蓄積の後('correction')と 1 パス('upsampled-correction')を
  // 面のある画素 mask で積む。
  private async accumulate(historyCap: number, frames: number, mask: Uint8Array, length: number): Promise<Moments> {
    const moments = new Moments(length);
    const warmupFrames = 3 * historyCap;
    let passPrevious: Float32Array | null = null;
    let accumulatedPrevious: Float32Array | null = null;
    for (let frame = 0; frame < warmupFrames + frames; frame++) {
      // 上限 s に達した後、初期の算術平均の影響が e⁻⁴ ほどに減るまでは描くだけにする。
      this.view.setFrame(frame, frame === 0 ? Number.POSITIVE_INFINITY : 0);
      if (frame < warmupFrames) continue;
      const accumulated = (await this.view.readFloat('correction')).rgba;
      const pass = (await this.view.readFloat('upsampled-correction')).rgba;
      // 和と二乗和、隣り合う差、理想の指数移動平均(読み始めのフレームで蓄積の後の値から始める)との差を積む。
      for (let p = 0; p < mask.length; p++) {
        if (mask[p] === 0) continue;
        for (let c = 0; c < 3; c++) {
          const i = 4 * p + c;
          const passValue = pass[i]!;
          const accumulatedValue = accumulated[i]!;
          moments.passSum[i] = moments.passSum[i]! + passValue;
          moments.passSquares[i] = moments.passSquares[i]! + passValue * passValue;
          moments.accumulatedSum[i] = moments.accumulatedSum[i]! + accumulatedValue;
          moments.accumulatedSquares[i] = moments.accumulatedSquares[i]! + accumulatedValue * accumulatedValue;
          if (passPrevious !== null && accumulatedPrevious !== null) {
            const passDifference = passValue - passPrevious[i]!;
            const accumulatedDifference = accumulatedValue - accumulatedPrevious[i]!;
            moments.passDifferenceSquares[i] = moments.passDifferenceSquares[i]! + passDifference * passDifference;
            moments.accumulatedDifferenceSquares[i] = moments.accumulatedDifferenceSquares[i]!
              + accumulatedDifference * accumulatedDifference;
            moments.ema[i] = moments.ema[i]! + (passValue - moments.ema[i]!) / historyCap;
          } else {
            moments.ema[i] = accumulatedValue;
          }
          const emaError = accumulatedValue - moments.ema[i]!;
          moments.emaErrorSquares[i] = moments.emaErrorSquares[i]! + emaError * emaError;
          moments.emaErrorMax = Math.max(moments.emaErrorMax, Math.abs(emaError));
        }
      }
      passPrevious = pass;
      accumulatedPrevious = accumulated;
    }
    return moments;
  }
}

// 画素・成分ごとの時間平均・標準偏差・差の RMS・理想の指数移動平均との差の RMS(ΔE の値)。
interface Statistics {
  readonly passMean: Float32Array;
  readonly accumulatedMean: Float32Array;
  readonly passStd: Float32Array;
  readonly accumulatedStd: Float32Array;
  readonly passDifferenceRms: Float32Array;
  readonly accumulatedDifferenceRms: Float32Array;
  readonly emaErrorRms: Float32Array;
}

// frames フレームぶん積んだ moments から、画素・成分ごとの統計を求める。
function statisticsOf(moments: Moments, frames: number): Statistics {
  // 標準偏差は和と二乗和から(丸めで負になった分散は 0 へ)、差の RMS は差の組の数で割る。
  const std =(sum: Float64Array, squares: Float64Array): Float32Array => Float32Array.from(
    sum, (value, i) => Math.sqrt(Math.max(squares[i]! / frames - (value / frames) ** 2, 0)));
  const rmsOver = (squares: Float64Array, count: number): Float32Array => Float32Array.from(
    squares, (value) => Math.sqrt(value / count));
  return {
    passMean: Float32Array.from(moments.passSum, (sum) => sum / frames),
    accumulatedMean: Float32Array.from(moments.accumulatedSum, (sum) => sum / frames),
    passStd: std(moments.passSum, moments.passSquares),
    accumulatedStd: std(moments.accumulatedSum, moments.accumulatedSquares),
    passDifferenceRms: rmsOver(moments.passDifferenceSquares, frames - 1),
    accumulatedDifferenceRms: rmsOver(moments.accumulatedDifferenceSquares, frames - 1),
    emaErrorRms: rmsOver(moments.emaErrorSquares, frames),
  };
}

// 画素・成分ごとの σ_t(p)/σ_S(p) と差の RMS(p)/σ_S(p) の中央値と 99% 分位。σ_S(p) が RMS の RATIO_STD_FLOOR 倍より小さい
// 画素は数えない。
function ratioPercentilesOf(statistics: Statistics, mask: Uint8Array, width: number, height: number): Pick<
  StaticVarianceSummary, 'stdRatioMedian' | 'stdRatioPercentile99' | 'differenceRatioMedian' | 'differenceRatioPercentile99'
> {
  const { passStd, accumulatedStd, accumulatedDifferenceRms } = statistics;
  const floor = maskedRms(image(passStd, width, height), mask, 1) * RATIO_STD_FLOOR;
  // 面のある画素の成分ごとの比を集めて分位を取る。
  const ratios: number[] = [];
  const differenceRatios: number[] = [];
  for (let p = 0; p < mask.length; p++) {
    if (mask[p] === 0) continue;
    for (let c = 0; c < 3; c++) {
      const i = 4 * p + c;
      if (passStd[i]! < floor) continue;
      ratios.push(accumulatedStd[i]! / passStd[i]!);
      differenceRatios.push(accumulatedDifferenceRms[i]! / passStd[i]!);
    }
  }
  return {
    stdRatioMedian: percentileOf(ratios, 0.5),
    stdRatioPercentile99: percentileOf(ratios, 0.99),
    differenceRatioMedian: percentileOf(differenceRatios, 0.5),
    differenceRatioPercentile99: percentileOf(differenceRatios, 0.99),
  };
}

// values の分位 fraction(並べ替えた添字の切り捨て)。空なら 0。
function percentileOf(values: readonly number[], fraction: number): number {
  const sorted = Float64Array.from(values).sort();
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
}

// 画素・成分の並び rgba を width × height の画像として包む。
function image(rgba: Float32Array, width: number, height: number): FloatImage {
  return { width, height, rgba };
}
