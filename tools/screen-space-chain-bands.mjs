// 手順8-15の収束した4帯(1024パス平均など)と1パスの4帯の、符号付き PNG と帯ごとの大きさの集計。
// PNG の尺度はケースごとに基準 run の収束した4帯で固定し、候補にも同じ尺度を使う。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASELINE_RUN, metricsOf, OUTPUT, sceneDirOf, signedPng } from './screen-space-chain-runs.mjs';
import { readFloats, unpackedBand } from './screen-space-lab.mjs';

export const BAND_COUNT = 4;
const SCALE_QUANTILE = 0.999;
export const ZOOMS = [1, 4];

// 帯の PNG と集計を置く、ケースのフォルダ内のフォルダ。
export const bandsDirOf = (run, scene) => path.join(sceneDirOf(run, scene), 'bands');

// run のケースの、収束した4帯(画素ごとに RGB の Float32Array × 4)。キャッシュに平均が無ければ null。
export function convergedBandsOf(run, scene) {
  const metrics = metricsOf(run, scene);
  if (metrics === null) return null;
  const cache = path.join(OUTPUT, 'cache', scene, metrics.cacheKey);
  const files = [0, 1, 2].map((texture) => path.join(cache, `mean-${metrics.conditions.passes}-packed-${texture}.f32`));
  if (!files.every((file) => existsSync(file))) return null;
  const packed = files.map(readFloats);
  return Array.from({ length: BAND_COUNT }, (_, band) => unpackedBand(packed, band));
}

// ケースの帯 PNG の表示幅(値 ±scale を白黒の端へ写す)。基準 run の収束した4帯の |値| の 0.999 分位。
export function bandScaleOf(scene) {
  const bands = convergedBandsOf(BASELINE_RUN, scene);
  if (bands === null) throw new Error(`${BASELINE_RUN}/${scene}: converged bands are missing`);
  const magnitudes = Float32Array.from(bands.flatMap((values) => Array.from(values, Math.abs))).sort();
  return Math.max(magnitudes[Math.floor(SCALE_QUANTILE * (magnitudes.length - 1))], 1e-12);
}

// 帯ごとの Σ|値|(画素・RGB の和)・正の和・負の和と、Σ|値| で重みを付けた平均の帯番号 Σ k·E_k / Σ E_k。
export function bandStatsOf(bands) {
  const stats = bands.map((values, band) => {
    let sumAbs = 0, positiveSum = 0, negativeSum = 0;
    for (const value of values) {
      sumAbs += Math.abs(value);
      if (value > 0) positiveSum += value;
      else negativeSum += value;
    }
    return { band, sumAbs, positiveSum, negativeSum };
  });
  const total = stats.reduce((sum, { sumAbs }) => sum + sumAbs, 0);
  const weighted = stats.reduce((sum, { band, sumAbs }) => sum + band * sumAbs, 0);
  return { bands: stats, meanBandNumber: total === 0 ? null : weighted / total };
}

// bands を dir へ `<prefix>-<帯>.x<倍率>.png`(値を倍率倍して scale で表示)に保存し、書いたファイル名の並びを返す。
export function writeBandImages(dir, prefix, bands, scale) {
  mkdirSync(dir, { recursive: true });
  const files = [];
  for (const [band, values] of bands.entries()) {
    for (const zoom of ZOOMS) {
      const file = `${prefix}-${band}.x${zoom}.png`;
      writeFileSync(path.join(dir, file), signedPng(values, 3, scale / zoom));
      files.push(file);
    }
  }
  return files;
}

// run のケースの収束した4帯を bands/ へ書き、集計 converged-bands.json を返す。4帯が無ければ null。
export function writeConvergedBands(run, scene) {
  const bands = convergedBandsOf(run, scene);
  if (bands === null) return null;
  const scale = bandScaleOf(scene);
  const dir = bandsDirOf(run, scene);
  const files = writeBandImages(dir, 'converged-band', bands, scale);
  const summary = { run, scene, passes: metricsOf(run, scene).conditions.passes,
    scale: { baseline: BASELINE_RUN, quantile: SCALE_QUANTILE, value: scale }, ...bandStatsOf(bands), files };
  writeFileSync(path.join(dir, 'converged-bands.json'), JSON.stringify(summary, null, 2));
  return summary;
}
