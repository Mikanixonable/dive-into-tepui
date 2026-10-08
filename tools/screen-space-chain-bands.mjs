// 手順8-15の収束した4帯(1024パス平均など)・その標準偏差(パスについて)・1パスの4帯の、PNG と帯ごとの大きさの集計。
// PNG の尺度はケースごとに基準 run の収束した4帯(標準偏差は基準 run の標準偏差)で固定し、候補にも同じ尺度を使う。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bandSumInvariant } from './screen-space-band-sum-invariant.mjs';
import { cachedMean, chunkComplete } from './screen-space-chain-cache.mjs';
import { BASELINE_RUN, metricsOf, OUTPUT, sceneDirOf, signedPng, unsignedPng } from './screen-space-chain-runs.mjs';
import { CHUNK_PASSES } from './screen-space-chain-setup.mjs';
import { readFloats, seedOf, unpackedBand, writeFloats } from './screen-space-lab.mjs';

export const BAND_COUNT = 4;
const SCALE_QUANTILE = 0.999;
export const ZOOMS = [1, 4];

// 帯の PNG と集計を置く、ケースのフォルダ内のフォルダ。
export const bandsDirOf = (run, scene) => path.join(sceneDirOf(run, scene), 'bands');

const cacheDirOf = (metrics) => path.join(OUTPUT, 'cache', metrics.scene, metrics.cacheKey);

// run のケースの、収束した4帯(画素ごとに RGB の Float32Array × 4)。キャッシュに平均が無ければ null。
export function convergedBandsOf(run, scene) {
  const metrics = metricsOf(run, scene);
  if (metrics === null) return null;
  const cache = cacheDirOf(metrics);
  const files = [0, 1, 2].map((texture) => path.join(cache, `mean-${metrics.conditions.passes}-packed-${texture}.f32`));
  if (!files.every((file) => existsSync(file))) return null;
  const packed = files.map(readFloats);
  return Array.from({ length: BAND_COUNT }, (_, band) => unpackedBand(packed, band));
}

// ケースの帯 PNG の表示幅(値 ±scale を白黒の端へ写す)。基準 run の収束した4帯の |値| の 0.999 分位。
export function bandScaleOf(scene) {
  const bands = convergedBandsOf(BASELINE_RUN, scene);
  if (bands === null) throw new Error(`${BASELINE_RUN}/${scene}: converged bands are missing`);
  return scaleOfBands(bands);
}

export const scaleOfBands = (bands) => {
  const magnitudes = Float32Array.from(bands.flatMap((values) => Array.from(values, Math.abs))).sort();
  return Math.max(magnitudes[Math.floor(SCALE_QUANTILE * (magnitudes.length - 1))], 1e-12);
};

// キャッシュ cache の passes パスについての、帯ごとの画素ごとの標準偏差(帯ごとに RGB の Float32Array)。
// 二乗の和が足りなければ null。
export function stdBandsOfCache(cache, passes) {
  for (let first = 0; first < passes; first += CHUNK_PASSES) {
    if (!chunkComplete(cache, first) || !chunkComplete(cache, first, 'sumsq')) return null;
  }
  const mean = cachedMean(cache, 0, passes), meanSquare = cachedMean(cache, 0, passes, 'sumsq');
  return Array.from({ length: BAND_COUNT }, (_, band) => {
    const m = unpackedBand(mean, band), s = unpackedBand(meanSquare, band);
    return Float32Array.from(m, (value, i) => Math.sqrt(Math.max(0, s[i] - value * value)));
  });
}

function stdBandsOf(run, scene) {
  const metrics = metricsOf(run, scene);
  return metrics === null ? null : stdBandsOfCache(cacheDirOf(metrics), metrics.conditions.passes);
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

// bands を dir へ `<prefix>-<帯>.x<倍率>.png`(値を倍率倍して scale で表示。pngOf は signedPng か unsignedPng)に保存し、書いたファイル名の並びを返す。
export function writeBandImages(dir, prefix, bands, scale, pngOf = signedPng) {
  mkdirSync(dir, { recursive: true });
  const files = [];
  for (const [band, values] of bands.entries()) {
    for (const zoom of ZOOMS) {
      const file = `${prefix}-${band}.x${zoom}.png`;
      writeFileSync(path.join(dir, file), pngOf(values, 3, scale / zoom));
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

// run のケースの収束した4帯の標準偏差を bands/ へ(PNG は 0 を黒とする)書き、集計 converged-std-bands.json を返す。
// 尺度は基準 run の標準偏差の 0.999 分位。標準偏差が無い(二乗の和のキャッシュが無い)か、基準の標準偏差が無ければ null。
export function writeConvergedStdBands(run, scene) {
  const bands = stdBandsOf(run, scene);
  const baseline = run === BASELINE_RUN ? bands : stdBandsOf(BASELINE_RUN, scene);
  if (bands === null || baseline === null) return null;
  const scale = scaleOfBands(baseline);
  const dir = bandsDirOf(run, scene);
  const files = writeBandImages(dir, 'converged-band-std', bands, scale, unsignedPng);
  for (const [band, values] of bands.entries()) writeFloats(path.join(dir, `converged-band-std-${band}.rgb.f32`), values);
  const summary = { run, scene, passes: metricsOf(run, scene).conditions.passes,
    scale: { baseline: BASELINE_RUN, quantile: SCALE_QUANTILE, value: scale }, ...bandStatsOf(bands), files };
  writeFileSync(path.join(dir, 'converged-std-bands.json'), JSON.stringify(summary, null, 2));
  return summary;
}

// 走査が直前に描いた1パスの4帯(帯ごとに RGB の Float32Array)。
export async function readBands(lab) {
  const packed = [];
  for (let texture = 0; texture < 3; texture++) packed.push(await lab.readFloat(`packed-bands-${texture}`, 4));
  return Array.from({ length: BAND_COUNT }, (_, band) => unpackedBand(packed, band));
}

// blue-noise seed 0 の1パスの4帯 bands を bands/ へ(float と、基準の尺度 scale の符号付き PNG)書き、集計
// one-pass-bands.json を返す。recordedBandSum は同じ描画の帯和(画素ごとに RGBA)で、帯の足し合わせと照合する。
export function writeOnePassBands(run, scene, bands, scale, recordedBandSum) {
  const dir = bandsDirOf(run, scene);
  const files = writeBandImages(dir, 'one-pass-band', bands, scale);
  for (const [band, values] of bands.entries()) writeFloats(path.join(dir, `one-pass-band-${band}.rgb.f32`), values);
  const { stats } = bandSumInvariant(recordedBandSum, bands);
  const summary = { run, scene, blueNoiseSeed: seedOf(0), scale: { baseline: BASELINE_RUN, value: scale },
    ...bandStatsOf(bands), againstRecordedBandSum: stats, files };
  writeFileSync(path.join(dir, 'one-pass-bands.json'), JSON.stringify(summary, null, 2));
  return summary;
}
