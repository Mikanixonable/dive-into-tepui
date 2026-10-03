// 近傍拡散補正の拡大の前の走査の、seed についての帯ごとの画素ごとの分散と分布の形の計測。候補の段ごとに、全候補で共通の seed
// の列で撮ったパスから、遮りの画面距離の帯ごとの q の画素ごとの平均・不偏分散を求め、帯の和の収束先を先頭の候補 A(帯に
// 分けない段)と比べる。帯に分けない候補では raw(帯 0)の分散を A と比べ、分布の形と誤差の空間の相関も表にする。表・数・
// 画素ごとの統計・目で見る画像を .render-lab-shots/ssd-variance/<出力先>/ へ書く。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { encodeRgbPng } from './png.mjs';
import {
  distributionNotesOf, distributionOf, distributionTablesOf, errorCorrelationOf, exponential, kurtosisBoundOf,
  percentileOf, shapeOf, varianceSumOf,
} from './screen-space-distribution.mjs';
import { exposedCorrectionOf, srgbCodesOfLinear } from './screen-space-error.mjs';
import {
  ENTRIES, entryInMode, fixed, HEIGHT, headHash, maskOf, MEDIUM_RAW_TIER, packedBandsNamesOf, seedOf, selectedEntries,
  shotsDir, table, unpackedBand, WIDTH, WINDOW_HALF, WINDOWS, withLab, writeFloats,
} from './screen-space-lab.mjs';

const USAGE = 'usage: variance [<candidates.json>] [--entries <key,...>] [--sets <set,...>] [--mode occlusion|indirect] '
  + '[--passes <N>] [--out <名前>]';
// 既定の候補: 中の段の帯に分けない段。
const DEFAULT_CANDIDATES = [{ label: 'medium-raw', tier: MEDIUM_RAW_TIER }];
const DEFAULT_PASSES = 256;
// seed の列を k mod BLOCKS で分ける塊の数。塊 0・2 が偶数番目、1・3 が奇数番目のパス。
const BLOCKS = 4;
// 誤差の空間の相関を測る、先頭から取る 1 パスの補正の数。
const SAMPLED_PASSES = 2;
// 費用に使う GPU の行(src/render/gpu-timings.ts の GPU_PASS_LABELS の近傍拡散の走査)。
const SCAN_ROW = '近傍拡散走査';

// 撮影の候補ごとの行を測り、費用を測って、表と記録を書く。options.mode(MODE の名前)があれば、選んだ撮影をその方式で撮る。
export async function variance({ positional, options }) {
  const candidates = candidatesOf(positional[0]);
  const passes = Number(options.passes ?? DEFAULT_PASSES);
  if (!Number.isInteger(passes) || passes % BLOCKS !== 0 || passes < 2 * BLOCKS) {
    throw new Error(`--passes must be a multiple of ${BLOCKS} and at least ${2 * BLOCKS}\n${USAGE}`);
  }
  const inMode = (e) => (options.mode === undefined ? e : entryInMode(e, options.mode));
  const selected = selectedEntries(options.entries === undefined && options.sets === undefined ? { sets: 'tuning' } : options);
  // 方式を揃えると重なる撮影(解析値と照らす組の 2 方式)は 1 つにする。
  const entries = [...new Map(selected.map(inMode).map((e) => [e.key, e])).values()];
  const head = headHash();
  const outDir = path.join(shotsDir, 'ssd-variance', options.out ?? head);
  mkdirSync(path.join(outDir, 'data'), { recursive: true });
  const { shots, scanCosts, scales } = await withLab(async (lab) => {
    const measured = {};
    for (const entry of entries) measured[entry.key] = await measureShot(lab, outDir, entry, candidates, passes);
    // 費用。コンパイルを済ませてから、bay を撮影と同じ方式で、段を交互に測る。
    await lab.show(inMode(ENTRIES[0]));
    await lab.capturePng();
    const costs = await lab.measureTiers(candidates.map((c) => c.tier), 3);
    return { shots: measured, scanCosts: costs.map((row) => row[SCAN_ROW]), scales: await lab.errorScales() };
  });
  const record = { head, passes, candidates, entries: entries.map((e) => e.key), scales, scanCosts, shots };
  writeFileSync(path.join(outDir, 'record.json'), JSON.stringify(record, null, 1));
  const report = reportOf(record);
  writeFileSync(path.join(outDir, 'report.md'), report);
  console.log(`\n${report}`);
}

// 候補 { label, tier } の並び。file(候補の JSON)が undefined なら既定の候補。帯の数を持たない段は帯に分けない段として
// 撮る。V/V_A の基準になる先頭の候補 A が帯に分けない段でなければ投げる。
function candidatesOf(file) {
  const listed = file === undefined ? DEFAULT_CANDIDATES : JSON.parse(readFileSync(file, 'utf8'));
  const candidates = listed.map(({ tier, ...candidate }) => ({
    ...candidate, tier: { bandCount: 1, bandScale: MEDIUM_RAW_TIER.bandScale, ...tier },
  }));
  if (candidates[0].tier.bandCount !== 1) {
    throw new Error(`the first candidate ${candidates[0].label} must not split into bands (bandCount 1): it is A of V/V_A`);
  }
  return candidates;
}

// ---- 撮影 ----

// 撮影 entry で候補 candidates を passes パスずつ撮り、画素ごとの統計と目で見る画像を dir へ書いて、撮影の記録
// { width, height, measured, exposure, meanRms, imageScales, rows, distributions } を返す。width × height は走査の解像度、
// measured は測る画素の数、meanRms は A の平均 μ_A の RMS、rows は候補の label ごとの行(rowOf)、distributions は帯に
// 分けない候補の label ごとの分布(distributionOf)に誤差の空間の相関 r(errorCorrelationOf)を足したもの。lab は withLab の口。
async function measureShot(lab, dir, entry, candidates, passes) {
  await lab.show(entry);
  await lab.capturePng();
  const radius = await lab.readFloat('projected-radius', 1);
  const exposure = await lab.exposureFactor();
  writeFloats(path.join(dir, 'data', `${entry.key}.radius.f32`), radius);
  const baseline = await capturePasses(lab, entry, candidates[0], passes, exposure);
  const { width, height } = baseline;
  const mask = scanMaskOf(radius, candidates[0].tier.scale, width, height);
  const windowPixels = entry.caseName === 'bay' ? bayWindowPixelsOf(width, height) : null;
  const imageScales = imageScalesOf(baseline.raw, mask, passes);
  const rows = {};
  const distributions = {};
  for (const [index, candidate] of candidates.entries()) {
    const current = index === 0 ? baseline : await capturePasses(lab, entry, candidate, passes, exposure);
    if (current.width !== width || current.height !== height) {
      throw new Error(`${candidate.label} scans ${current.width}×${current.height}, A scans ${width}×${height}`);
    }
    writeStatistics(dir, entry.key, candidate.label, current);
    writeImages(dir, entry.key, candidate.label, current, index === 0 ? null : baseline, mask, imageScales);
    rows[candidate.label] = rowOf(current, baseline, mask);
    if (current.raw === null) continue;
    distributions[candidate.label] = {
      ...distributionOf(current.raw, mask, windowPixels),
      r: await errorCorrelationOf(lab, current.raw.samples, current.raw.mean, mask, width, height),
    };
  }
  const measured = mask.reduce((count, m) => count + m, 0);
  const meanRms = Math.sqrt(maskedMeanOf(baseline.mean.map((v) => v * v), mask));
  return { width, height, measured, exposure, meanRms, imageScales, rows, distributions };
}

// 表示中の撮影 entry を候補 candidate の段で passes パス撮り、露出係数 exposure の q の統計
// { width, height, bands, mean, halves, raw, display, passSeconds, seconds } を返す。bands は帯ごとの画素ごとの統計
// (statisticsOf)、mean と halves は帯の和の全パスの平均と偶数番目・奇数番目のパスの平均の組、raw は帯に分けない段なら帯 0 の
// 統計に成分の和の画素ごとの形 shape(shapeOf)と先頭 SAMPLED_PASSES パスの q の平面の組(R・G・B)の並び samples を足した
// もの(帯に分ける段では null)、display は全パスの HDR の平均の表示(線形 sRGB)、passSeconds は最初のパスを除く 1 パスの所要、
// seconds は全体の所要。
async function capturePasses(lab, entry, candidate, passes, exposure) {
  const started = Date.now();
  const { bandCount } = candidate.tier;
  const names = packedBandsNamesOf(bandCount);
  await lab.setTier(candidate.tier);
  let firstPassSeconds = 0;
  const samples = [];
  for (let k = 0; k < passes; k++) {
    await lab.setSeed(seedOf(k));
    // 絵の落ち着きを待つのは最初のパスだけで、以後は seed だけが変わる。
    if (k === 0) await lab.capturePng();
    else await lab.render();
    for (const name of names) await lab.accumulateMoments(name, 4, k % BLOCKS);
    await lab.accumulateFloat('hdr', 3, 0);
    if (bandCount === 1 && k < SAMPLED_PASSES) samples.push(exposedCorrectionOf(await lab.readFloat(names[0], 3), exposure));
    if (k === 0) firstPassSeconds = (Date.now() - started) / 1000;
  }
  const passSeconds = ((Date.now() - started) / 1000 - firstPassSeconds) / (passes - 1);
  const display = await lab.displayOfMean('hdr', passes);
  await lab.dropAccumulated('hdr');
  const packed = [];
  for (const name of names) packed.push(await lab.takeMoments(name, BLOCKS));
  // 帯ごとの冪和を詰めたテクスチャのチャンネルから取り出して、統計にする。
  const scale = exposure / Math.PI;
  const bands = Array.from({ length: bandCount }, (_, band) => statisticsOf(packed[0].slots.map((_, slot) => ({
    sum: unpackedBand(packed.map((texture) => texture.slots[slot].sum), band),
    squareSum: unpackedBand(packed.map((texture) => texture.slots[slot].squareSum), band),
  })), scale, passes));
  // 帯に分けない段の成分の和は、詰めたテクスチャ 0 の 4 成分の和(余りのチャンネルは 0)。
  const raw = bandCount === 1 ? { ...bands[0], shape: shapeOf(packed[0].channelSum, scale, passes), samples } : null;
  const seconds = (Date.now() - started) / 1000;
  console.log(`${entry.key} ${candidate.label}: ${passSeconds.toFixed(3)} s/パス、最初のパス ${firstPassSeconds.toFixed(1)} s、`
    + `計 ${seconds.toFixed(0)} s`);
  return {
    width: packed[0].width,
    height: packed[0].height,
    bands,
    mean: elementSumOf(bands.map((b) => b.mean)),
    halves: [0, 1].map((h) => elementSumOf(bands.map((b) => b.halves[h]))),
    raw,
    display,
    passSeconds,
    seconds,
  };
}

// 走査(寸法 size)の画素の座標 pixel が読む、G バッファ(寸法 fullSize)の画素の座標
// (src/render/pipeline/screen-space/hemisphere-scan.ts の gbufferTexelOf)。
const gbufferTexelOf = (pixel, size, fullSize) => Math.floor((2 * pixel + 1) * fullSize / (2 * size));

// 解像度 scale の走査(width × height)の画素ごとの、測る画素の印。走査の画素が読む G バッファの画素での、近傍の半径
// radius(絵の画素ごと)の印 maskOf。
function scanMaskOf(radius, scale, width, height) {
  const full = maskOf(radius, scale);
  return Uint8Array.from({ length: width * height }, (_, p) => (
    full[gbufferTexelOf(Math.floor(p / width), height, HEIGHT) * WIDTH + gbufferTexelOf(p % width, width, WIDTH)]));
}

// 分布を読む bay の窓(WINDOWS の名前)。
const DISTRIBUTION_WINDOWS = ['P_glow', 'P_out', 'P_base'];

// 走査(width × height)の画素のうち、読む G バッファの画素が DISTRIBUTION_WINDOWS の窓に落ちるものの番号の並びを、
// 窓の名前ごとに。
function bayWindowPixelsOf(width, height) {
  const covered = (center, size, fullSize) => Array.from({ length: size }, (_, i) => i)
    .filter((i) => Math.abs(gbufferTexelOf(i, size, fullSize) - center) <= WINDOW_HALF);
  return Object.fromEntries(DISTRIBUTION_WINDOWS.map((name) => {
    const [x, y] = WINDOWS[name];
    const columns = covered(x, width, WIDTH);
    return [name, covered(y, height, HEIGHT).flatMap((row) => columns.map((column) => row * width + column))];
  }));
}

// ---- 統計 ----

// 帯 1 つの塊ごとの和と二乗和 slots(塊の番号順の { sum, squareSum }。画素ごとに rgb を並べた Float64Array)の、ΔE から q への
// 係数 scale での画素ごとの統計 { mean, variance, halves, blockVariances }。どれも画素ごとに rgb を並べた Float64Array で、
// mean と variance は全 passes パスの平均と不偏分散、halves は偶数番目と奇数番目のパスの平均の組、blockVariances は塊ごとの
// 不偏分散。
function statisticsOf(slots, scale, passes) {
  const length = slots[0].sum.length;
  const mean = new Float64Array(length);
  const variance = new Float64Array(length);
  const halves = [new Float64Array(length), new Float64Array(length)];
  const blockVariances = slots.map(() => new Float64Array(length));
  for (let i = 0; i < length; i++) {
    let [sum, squareSum] = [0, 0];
    for (const [b, slot] of slots.entries()) {
      const [blockSum, blockSquareSum] = [scale * slot.sum[i], scale * scale * slot.squareSum[i]];
      blockVariances[b][i] = unbiasedVarianceOf(blockSum, blockSquareSum, passes / BLOCKS);
      halves[b % 2][i] += blockSum / (passes / 2);
      sum += blockSum;
      squareSum += blockSquareSum;
    }
    mean[i] = sum / passes;
    variance[i] = unbiasedVarianceOf(sum, squareSum, passes);
  }
  return { mean, variance, halves, blockVariances };
}

// n 個の値の和 sum と二乗和 squareSum からの不偏分散。
const unbiasedVarianceOf = (sum, squareSum, n) => (squareSum - sum * sum / n) / (n - 1);

// 同じ長さの並び arrays の、要素ごとの和。
const elementSumOf = (arrays) => arrays[0].map((_, i) => arrays.reduce((sum, values) => sum + values[i], 0));

// 画素ごとに rgb を並べた values の、印 mask の立った画素での 3 成分の和の平均。
function maskedMeanOf(values, mask) {
  let [total, count] = [0, 0];
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    total += values[3 * p] + values[3 * p + 1] + values[3 * p + 2];
    count++;
  }
  return total / count;
}

// 候補の統計 current の、A の統計 baseline に対する撮影ごとの行 { variance, ratio, blockRatioRange, shift, shiftCorrelation,
// bands, passSeconds, seconds }。印 mask の立った画素で測る。variance は raw の V、ratio は V/V_A、blockRatioRange は塊ごとの
// 比の [最小, 最大] で、どれも帯に分ける候補では null(帯の和の分散は帯ごとの積算から求まらない)。shift は帯の和の偶数番目と
// 奇数番目の平均の A との差 d偶・d奇 の mean(Σ_c d偶·d奇)、shiftCorrelation はその中心化しない相関。bands は帯ごとの
// { variance, meanRms }(帯の V と μ の RMS)。
function rowOf(current, baseline, mask) {
  const [evenShift, oddShift] = current.halves.map((half, h) => half.map((v, i) => v - baseline.halves[h][i]));
  const shift = maskedMeanOf(evenShift.map((d, i) => d * oddShift[i]), mask);
  const [evenPower, oddPower] = [evenShift, oddShift].map((d) => maskedMeanOf(d.map((v) => v * v), mask));
  const rawRow = current.raw === null
    ? { variance: null, ratio: null, blockRatioRange: null } : rawRowOf(current.raw, baseline.raw, mask);
  return {
    ...rawRow,
    shift,
    shiftCorrelation: shift / Math.sqrt(evenPower * oddPower),
    bands: current.bands.map(({ mean, variance }) => ({
      variance: maskedMeanOf(variance, mask),
      meanRms: Math.sqrt(maskedMeanOf(mean.map((v) => v * v), mask)),
    })),
    passSeconds: current.passSeconds,
    seconds: current.seconds,
  };
}

// 帯に分けない候補の raw の統計 raw の、A の raw の統計 baseline に対する { variance, ratio, blockRatioRange }(rowOf)。
function rawRowOf(raw, baseline, mask) {
  const variance = maskedMeanOf(raw.variance, mask);
  const blockRatios = raw.blockVariances.map(
    (values, b) => maskedMeanOf(values, mask) / maskedMeanOf(baseline.blockVariances[b], mask));
  return {
    variance,
    ratio: variance / maskedMeanOf(baseline.variance, mask),
    blockRatioRange: [Math.min(...blockRatios), Math.max(...blockRatios)],
  };
}

// ---- 保存と画像 ----

// 候補 label の撮影 key の、帯ごとの q の画素ごとの平均・不偏分散・偶数番目と奇数番目のパスの平均(画素ごとに rgb)と、帯に
// 分けない候補では成分の和の歪度・尖度(画素ごとに 1 つ。定まらない画素は NaN)を、単精度で dir の data/ へ書く。
function writeStatistics(dir, key, label, { bands, raw }) {
  const write = (kind, values) => writeFloats(path.join(dir, 'data', `${key}.${label}.${kind}.f32`), Float32Array.from(values));
  for (const [band, { mean, variance, halves: [even, odd] }] of bands.entries()) {
    for (const [kind, values] of Object.entries({ mean, variance, even, odd })) write(`band${band}.${kind}`, values);
  }
  if (raw === null) return;
  write('skewness', raw.shape.skewness);
  write('kurtosis', raw.shape.kurtosis);
}

// 目で見る画像の撮影ごとの尺度 { meanRange, sigmaWhite, diffRange, ratioFloor, kurtosisWhite }。A の raw の統計 baseline の、
// 印 mask の立った画素とパス数 passes から決める。meanRange は平均の表示の 0.5 からの振れ幅 1 に当たる q、sigmaWhite は白に
// 当たる σ、diffRange は A との差の表示の振れ幅 1 に当たる q、ratioFloor は分散の比を読まない分散の和の上限、kurtosisWhite は
// 白に当たる尖度(passes パスでとれる上限)。
function imageScalesOf(baseline, mask, passes) {
  const pixels = Array.from(mask.keys()).filter((p) => mask[p]);
  const variance = maskedMeanOf(baseline.variance, mask);
  return {
    meanRange: 2 * percentileOf(pixels.flatMap((p) => [0, 1, 2].map((c) => Math.abs(baseline.mean[3 * p + c]))), 0.99),
    sigmaWhite: percentileOf(pixels.map((p) => Math.sqrt(varianceSumOf(baseline.variance, p))), 0.99),
    diffRange: 8 * Math.sqrt(2 * variance / passes),
    ratioFloor: 0.01 * variance,
    kurtosisWhite: kurtosisBoundOf(passes),
  };
}

// 分散の比の表示: log2 の比を ±RATIO_OCTAVES で、下がると LOWER_COLOR、上がると HIGHER_COLOR、同じなら SAME_COLOR へ。
const RATIO_OCTAVES = 2;
const LOWER_COLOR = [0.15, 0.35, 1];
const HIGHER_COLOR = [1, 0.2, 0.15];
const SAME_COLOR = [0.5, 0.5, 0.5];

// 画素の分散の和 current の、A の分散の和 baseline に対する比の色。両方が floor 未満なら SAME_COLOR。
function ratioColorOf(current, baseline, floor) {
  if (current < floor && baseline < floor) return SAME_COLOR;
  const t = Math.max(-1, Math.min(1, Math.log2(current / baseline) / RATIO_OCTAVES));
  const end = t < 0 ? LOWER_COLOR : HIGHER_COLOR;
  return SAME_COLOR.map((v, c) => v + Math.abs(t) * (end[c] - v));
}

// 尖度の表示: log β₂ を、正規分布の NORMAL_KURTOSIS で灰、白に当たる尖度で白へ。β₂ の定まらない画素(σ_s = 0)は
// UNDEFINED_KURTOSIS_COLOR。
const NORMAL_KURTOSIS = 3;
const UNDEFINED_KURTOSIS_COLOR = [0.1, 0.2, 0.6];

// 画素の尖度 kurtosis の色。white は白に当たる尖度。
function kurtosisColorOf(kurtosis, white) {
  if (!Number.isFinite(kurtosis)) return UNDEFINED_KURTOSIS_COLOR;
  return Array(3).fill(0.5 + 0.5 * Math.log(kurtosis / NORMAL_KURTOSIS) / Math.log(white / NORMAL_KURTOSIS));
}

// 候補 label の撮影 key の目で見る画像を dir へ書く。statistics は候補の統計と表示(capturePasses)、baseline は A の統計
// (A 自身なら null で、A と比べる画像を書かない)、mask は測る画素の印、scales は撮影の尺度(imageScalesOf)。σ・尖度・
// 分散の比は帯に分けない候補だけ書く。
function writeImages(dir, key, label, statistics, baseline, mask, scales) {
  const { width, height, mean, raw, display } = statistics;
  const write = (kind, png) => writeFileSync(path.join(dir, `${key}.${label}.${kind}.png`), png);
  const scanPng = (colorOf) => scanPngOf(width, height, mask, colorOf);
  write('mean', encodeRgbPng(WIDTH, HEIGHT, srgbCodesOfLinear(display)));
  write('mean-q', scanPng((p) => [0, 1, 2].map((c) => 0.5 + mean[3 * p + c] / scales.meanRange)));
  if (raw !== null) {
    write('sigma', scanPng((p) => Array(3).fill(Math.sqrt(varianceSumOf(raw.variance, p)) / scales.sigmaWhite)));
    write('kurtosis', scanPng((p) => kurtosisColorOf(raw.shape.kurtosis[p], scales.kurtosisWhite)));
  }
  if (baseline === null) return;
  write('diff', scanPng((p) => [0, 1, 2].map((c) => 0.5 + (mean[3 * p + c] - baseline.mean[3 * p + c]) / scales.diffRange)));
  if (raw === null) return;
  write('ratio', scanPng((p) => ratioColorOf(
    varianceSumOf(raw.variance, p), varianceSumOf(baseline.raw.variance, p), scales.ratioFloor)));
}

// 走査の解像度 width × height の画素 p ごとの表示の色 colorOf(p)(rgb、[0, 1] へ切る)を、最近傍で絵の寸法へ広げた PNG。
// 印 mask の外は黒。
function scanPngOf(width, height, mask, colorOf) {
  const codes = new Uint8Array(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const p = Math.floor(y * height / HEIGHT) * width + Math.floor(x * width / WIDTH);
      if (!mask[p]) continue;
      const color = colorOf(p);
      for (let c = 0; c < 3; c++) codes[(y * WIDTH + x) * 3 + c] = Math.round(255 * Math.min(1, Math.max(0, color[c])));
    }
  }
  return encodeRgbPng(WIDTH, HEIGHT, codes);
}

// ---- 表 ----

// 値の並び values(どれも正)の幾何平均。
const geometricMeanOf = (values) => Math.exp(values.reduce((sum, v) => sum + Math.log(v), 0) / values.length);
// 最小〜最大の文字列。測れなかった範囲は —。
const rangeOf = (range, digits) => (range === null ? '—' : `${fixed(range[0], digits)}〜${fixed(range[1], digits)}`);

// 記録 record の表。候補ごとのまとめ、撮影ごとの行と帯ごとの表と分布の表、保存したものの説明。
function reportOf({ head, passes, candidates, entries, scales, scanCosts, shots }) {
  const labels = candidates.map((c) => c.label);
  const unsplitLabels = candidates.filter((c) => c.tier.bandCount === 1).map((c) => c.label);
  const split = candidates.filter((c) => c.tier.bandCount > 1);
  const summary = candidates.map((candidate, i) => {
    const costRatio = scanCosts[i] / scanCosts[0];
    const costCells = [fixed(scanCosts[i], 3), fixed(costRatio, 3)];
    if (candidate.tier.bandCount > 1) return [candidate.label, '—', '—', ...costCells, '—'];
    const ratios = entries.map((key) => shots[key].rows[candidate.label].ratio);
    return [
      candidate.label, fixed(geometricMeanOf(ratios), 3), rangeOf([Math.min(...ratios), Math.max(...ratios)], 3),
      ...costCells, fixed(geometricMeanOf(ratios.map((r) => 1 / (r * costRatio))), 3),
    ];
  });
  const perShot = entries.flatMap((key) => {
    const { width, height, measured, meanRms, rows, distributions } = shots[key];
    return [
      '', `### ${key}(走査 ${width}×${height}、測る画素 ${measured}、μ_A の RMS ${fixed(meanRms, 5)})`, '',
      ...table(['候補', '√V', 'V/V_A', '塊ごとの V_b/V_A,b', 'mean(Σ d偶·d奇)', '√mean(Σ d偶·d奇)', 'd偶 と d奇 の相関'],
        labels.map((label) => {
          const row = rows[label];
          return [
            label, fixed(row.variance === null ? null : Math.sqrt(row.variance), 5), fixed(row.ratio, 3),
            rangeOf(row.blockRatioRange, 3), exponential(row.shift), fixed(Math.sqrt(row.shift), 5),
            fixed(row.shiftCorrelation, 3),
          ];
        })),
      ...(split.length === 0 ? [] : [
        '', '#### 帯ごと(√V_ℓ / μ_ℓ の RMS)', '',
        ...table(['候補', ...Array.from({ length: Math.max(...split.map((c) => c.tier.bandCount)) }, (_, b) => `帯 ${b}`)],
          split.map(({ label }) => [label, ...rows[label].bands.map(
            (band) => `${fixed(Math.sqrt(band.variance), 5)} / ${fixed(band.meanRms, 5)}`)])),
      ]),
      ...distributionTablesOf(distributions, unsplitLabels, scales),
    ];
  });
  return [
    '# 近傍拡散補正の拡大の前の走査の、seed についての帯ごとの画素ごとの分散と分布の形', '',
    `HEAD ${head}、${passes} パス(seedOf(0〜${passes - 1})、k mod ${BLOCKS} の塊に分ける)。基準 A = ${candidates[0].label}。`,
    '撮影の key の @occlusion は遮蔽だけの方式。q = 露出係数·ΔE/π。V は測る画素で平均した Σ_c V_c(V_c は成分 c の seed に',
    'ついての不偏分散)で、帯に分けない候補の raw だけが持つ(帯の和の分散は帯ごとに積んだ和から求まらない)。V_ℓ は帯 ℓ の V。',
    'd偶・d奇 は帯の和の偶数番目・奇数番目のパスの平均の A との差で、相関は中心化しない Σ d偶·d奇 / √(Σ d偶² · Σ d奇²)。',
    'μ_ℓ の RMS は √(測る画素で平均した Σ_c μ_ℓ,c²)。',
    '', ...distributionNotesOf(passes), '',
    ...candidates.map((c) => `- ${c.label}: \`${JSON.stringify(c.tier)}\``),
    '', '## まとめ', '',
    ...table(['候補', 'V/V_A 幾何平均', 'V/V_A 最小〜最大', '走査 p50 [ms]', 'T/T_A', '効率比 (V_A·T_A)/(V·T)'], summary),
    '', '## 撮影ごと', ...perShot,
    '', '## 保存したもの', '',
    '- `data/<撮影>.<候補>.band<ℓ>.{mean,variance,even,odd}.f32` — 帯 ℓ(0〜帯の数 − 1。帯に分けない候補は帯 0 = raw)の q の',
    '  全パスの平均・不偏分散・偶数番目と奇数番目のパスの平均。単精度で、走査の解像度(撮影ごとの width × height は record.json の',
    '  shots)の画素ごとに rgb、行は上から。帯の和の平均は帯ごとの mean の和。',
    '- `data/<撮影>.<候補>.{skewness,kurtosis}.f32` — 帯に分けない候補の s の歪度 γ₁・尖度 β₂。単精度で、走査の解像度の画素ごとに',
    '  1 つ。σ_s = 0 の画素は NaN。',
    `- \`data/<撮影>.radius.f32\` — 近傍の半径 [絵の画素](${WIDTH}×${HEIGHT}、単精度)。測る画素は、走査の画素で近傍の半径が 2 を超える面。`,
    '- `<撮影>.<候補>.mean.png` — HDR のパス平均の表示。`mean-q.png` — 0.5 + μ / meanRange(μ は帯の和)。`sigma.png` —',
    `  √(Σ_c V_c) / sigmaWhite。\`kurtosis.png\` — 0.5 + 0.5·ln(β₂/${NORMAL_KURTOSIS}) / ln(kurtosisWhite/${NORMAL_KURTOSIS}) の灰色`,
    `  (正規分布の β₂ = ${NORMAL_KURTOSIS} で灰、${passes} パスでとれる上限 kurtosisWhite で白、β₂ = 1 で暗い灰)。σ_s = 0 の画素は青。`,
    '  `diff.png` — 0.5 + (μ − μ_A) / diffRange。`ratio.png` — log2(Σ_c V_c / Σ_c V_A,c) を ±2 で青〜灰〜赤。sigma・kurtosis・',
    '  ratio は帯に分けない候補だけ。尺度は record.json の shots.<撮影>.imageScales。印の外は黒。',
    '- `record.json` の shots.<撮影>.rows.<候補>.bands — 帯ごとの V_ℓ(variance)と μ_ℓ の RMS(meanRms)。',
    '  shots.<撮影>.distributions.<候補> — 帯に分けない候補の分布の表の数(groups・quiet・windows)と R(s)(r。scales の順)。', '',
  ].join('\n');
}
