// 手順8-15の1パス雑音の輝点の指標。独立な複数パスについて、画素ごとの最大偏差(RGB の二乗平均の平方根の、パスについての最大)を
// 取り、ROI ごとに RMS・最大偏差の分位・最大偏差/RMS の中央値を出す。白色雑音なら比は約 2、1 回だけの輝点なら √(パス数)。
import { SCAN_WIDTH } from './screen-space-chain-runs.mjs';

// 1パスの合流 one と収束した合流 converged(どちらも画素ごとに RGBA)の偏差の大きさ(RGB の二乗平均の平方根)の、
// 画素ごとの最大 maxima(Float32Array。呼ぶたびに更新)。
export function accumulateMaxDeviation(maxima, one, converged) {
  for (let p = 0; p < maxima.length; p++) {
    let squares = 0;
    for (let c = 0; c < 3; c++) squares += (one[p * 4 + c] - converged[p * 4 + c]) ** 2;
    maxima[p] = Math.max(maxima[p], Math.sqrt(squares / 3));
  }
}

// 画素ごとの値 maxima を RGB に複写した RGBA(PNG・float の保存用)。
export const rgbaOfScalar = (maxima) => Float32Array.from({ length: maxima.length * 4 }, (_, i) => (i % 4 === 3 ? 1 : maxima[i >> 2]));

const quantileOf = (sorted, q) => sorted[Math.floor(q * (sorted.length - 1))];

// ROI(走査画素の [x, y, 幅, 高さ])の、noise(パスについての RMS。画素ごとに RGBA)と maxima による集計。
export function deviationStatsOf(noise, maxima, [left, top, width, height]) {
  const maximaInRoi = [], ratios = [];
  let squares = 0;
  for (let y = top; y < top + height; y++) for (let x = left; x < left + width; x++) {
    const p = y * SCAN_WIDTH + x;
    const rms = Math.sqrt((noise[p * 4] ** 2 + noise[p * 4 + 1] ** 2 + noise[p * 4 + 2] ** 2) / 3);
    squares += rms * rms;
    maximaInRoi.push(maxima[p]);
    if (rms > 0) ratios.push(maxima[p] / rms);
  }
  maximaInRoi.sort((a, b) => a - b);
  ratios.sort((a, b) => a - b);
  return { rms: Math.sqrt(squares / maximaInRoi.length), maxP50: quantileOf(maximaInRoi, 0.5), maxP99: quantileOf(maximaInRoi, 0.99),
    ratioMedian: ratios.length === 0 ? null : quantileOf(ratios, 0.5) };
}

// ROI の、画素ごとに stride 成分の先頭 3 成分(RGB)の RMS。
export function roiRms(values, stride, [left, top, width, height]) {
  let squares = 0;
  for (let y = top; y < top + height; y++) for (let x = left; x < left + width; x++) {
    for (let c = 0; c < 3; c++) squares += values[(y * SCAN_WIDTH + x) * stride + c] ** 2;
  }
  return Math.sqrt(squares / (width * height * 3));
}
