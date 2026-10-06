// 近傍拡散補正の拡大の前の走査の、seed についての帯ごとの画素ごとの分散と分布の形の計測(帯の撮影)。候補の段ごとに、全候補で
// 共通の seed の列で撮ったパスから、遮りの画面距離の帯ごとの q と帯の和と、最後の拡大の前の補正 C_0 の画素ごとの平均・不偏
// 分散を求め、先頭の候補 A と比べる。C_0 は同じパスの帯の和からの恒等のずれ・揺れとその見込み・bay の系の窓の比を表にする。
// 帯に分けない候補では、分布の形と誤差の空間の相関も表にする。表・数・画素ごとの統計・目で見る画像を
// .render-lab-shots/ssd-variance/<出力先>/ へ書く。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { encodeRgbPng } from './png.mjs';
import {
  distributionNotesOf, distributionOf, distributionTablesOf, errorCorrelationOf, exponential, kurtosisBoundOf,
  percentileOf, shapeOf, varianceSumOf,
} from './screen-space-distribution.mjs';
import { exposedCorrectionOf, srgbCodesOfLinear } from './screen-space-error.mjs';
import {
  CHAIN_IMAGE_NOTES, CHAIN_NOTES, chainColorsOf, chainPlanesOf, chainRowOf, chainTableOf,
} from './screen-space-chain.mjs';
import {
  DIFFERENCE_GAIN, ENTRIES, entryInMode, fixed, HEIGHT, headHash, maskedMeanOf, MEDIUM_RAW_TIER, packedBandsNamesOf,
  ratioColorOf, seedOf, selectedEntries, shotsDir, signedColorOf, signedGainOf, table, unpackedBand, WIDTH, WINDOW_HALF,
  WINDOWS, windowRatiosOf, withLab, writeFloats,
} from './screen-space-lab.mjs';
import { BLOCKS, gbufferTexelOf, scanMaskOf, scanPngOf, statisticsOf } from './screen-space-scan.mjs';

const USAGE = 'usage: variance [<candidates.json>] [--entries <key,...>] [--sets <set,...>] [--mode occlusion|indirect] '
  + '[--passes <N>] [--out <名前>]';
// 既定の候補: 中の段の帯に分けない段。
const DEFAULT_CANDIDATES = [{ label: 'medium-raw', tier: MEDIUM_RAW_TIER }];
const DEFAULT_PASSES = 256;
// 誤差の空間の相関を測る、先頭から取る 1 パスの補正の数。
const SAMPLED_PASSES = 2;
// 費用に使う GPU の行(src/render/gpu-timings.ts の GPU_PASS_LABELS)。SCAN_ROW は近傍拡散の走査、COST_ROWS は表に出す行で、
// 最後のマテリアルの行を費用の比の分母にする。
const SCAN_ROW = '近傍拡散走査';
const COST_ROWS = [
  '近傍拡散写しと源', SCAN_ROW, '近傍拡散代表縮小', '近傍拡散帯縮小', '近傍拡散合流', '近傍拡散拡大', 'マテリアル',
];
// 最後の拡大の前の補正(走査の解像度。帯に分けない段は帯 0、分ける段は拡大と合流の段 0 の出力)と、走査の帯の和の
// 読み戻しの名前。
const C0_NAME = 'scan-correction';
const BAND_SUM_NAME = 'band-sum';

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
  const signed = {};
  const { shots, costs, scales } = await withLab(async (lab) => {
    const measured = {};
    for (const entry of entries) {
      ({ shot: measured[entry.key], signed: signed[entry.key] } = await measureShot(lab, outDir, entry, candidates, passes));
    }
    // 費用。コンパイルを済ませてから、bay を撮影と同じ方式で、段を交互に測る。
    await lab.show(inMode(ENTRIES[0]));
    await lab.capturePng();
    const rows = await lab.measureTiers(candidates.map((c) => c.tier), 3);
    return {
      shots: measured,
      costs: rows.map((row) => Object.fromEntries(COST_ROWS.map((label) => [label, row[label]]))),
      scales: await lab.errorScales(),
    };
  });
  const scanCosts = costs.map((row) => row[SCAN_ROW]);
  const signedGain = writeSignedImages(outDir, signed, candidates[0].label);
  const record = { head, passes, candidates, entries: entries.map((e) => e.key), scales, scanCosts, costs, signedGain, shots };
  writeFileSync(path.join(outDir, 'record.json'), JSON.stringify(record, null, 1));
  const report = reportOf(record);
  writeFileSync(path.join(outDir, 'report.md'), report);
  console.log(`\n${report}`);
}

// 候補 { label, tier } の並び。file(候補の JSON)が undefined なら既定の候補。帯の数を持たない段は帯に分けない段として
// 撮る。先頭の候補が V/V_A の基準 A。
function candidatesOf(file) {
  const listed = file === undefined ? DEFAULT_CANDIDATES : JSON.parse(readFileSync(file, 'utf8'));
  return listed.map(({ tier, ...candidate }) => ({
    ...candidate, tier: { bandCount: 1, bandScale: MEDIUM_RAW_TIER.bandScale, ...tier },
  }));
}

// ---- 撮影 ----

// 撮影 entry で候補 candidates を passes パスずつ撮り、画素ごとの統計と符号つきでない画像を dir へ書いて、{ shot, signed } を
// 返す。shot は撮影の記録 { width, height, measured, exposure, meanRms, imageScales, levels,
// rows, chains, distributions } — width × height は走査の解像度、measured は測る画素の数、meanRms は A の帯の和の平均 μ_A の
// RMS、levels は帯に分ける候補の label ごとの段の寸法の並び [{ level, width, height }]、rows は候補の label ごとの行(rowOf)、
// chains は候補の label ごとの C_0 の行(chainRowOf)、distributions は帯に分けない候補の label ごとの分布(distributionOf)に
// 誤差の空間の相関 r(errorCorrelationOf)を足したもの。signed は符号つきの画像の材料(signedFieldsOf)。lab は withLab の口。
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
  const imageScales = imageScalesOf(baseline.sum, mask, passes);
  const meanRms = Math.sqrt(maskedMeanOf(baseline.sum.mean.map((v) => v * v), mask));
  const levels = {};
  const rows = {};
  const chains = {};
  const distributions = {};
  const signed = { width, height, mask, candidates: {} };
  for (const [index, candidate] of candidates.entries()) {
    const current = index === 0 ? baseline : await capturePasses(lab, entry, candidate, passes, exposure);
    if (current.width !== width || current.height !== height) {
      throw new Error(`${candidate.label} scans ${current.width}×${current.height}, A scans ${width}×${height}`);
    }
    const chain = chainPlanesOf(current.c0, current.sum, current.bands, mask, width, height);
    writeStatistics(dir, entry.key, candidate.label, current);
    writeImages(dir, entry.key, candidate.label, current, index === 0 ? null : baseline, mask, imageScales, chain);
    signed.candidates[candidate.label] = signedFieldsOf(current, index === 0 ? null : baseline, chain);
    if (current.levels.length > 0) {
      levels[candidate.label] = current.levels.map(({ level, width: levelWidth, height: levelHeight }) => ({
        level, width: levelWidth, height: levelHeight,
      }));
    }
    rows[candidate.label] = rowOf(current, baseline, mask);
    chains[candidate.label] = chainRowOf(chain, mask, width, meanRms, current.windowRatio);
    if (current.raw === null) continue;
    distributions[candidate.label] = {
      ...distributionOf(current.raw, mask, windowPixels),
      r: await errorCorrelationOf(lab, current.raw.samples, current.raw.mean, mask, width, height),
    };
  }
  const measured = mask.reduce((count, m) => count + m, 0);
  return { shot: { width, height, measured, exposure, meanRms, imageScales, levels, rows, chains, distributions }, signed };
}

// 表示中の撮影 entry を候補 candidate の段で passes パス撮り、露出係数 exposure の q の統計
// { width, height, bands, sum, raw, c0, levels, windowRatio, display, passSeconds, seconds } を返す。bands と sum は帯ごとと
// 帯の和の画素ごとの統計(statisticsOf)、raw は帯に分けない段なら帯 0 の統計に成分の和の画素ごとの形 shape(shapeOf)と先頭
// SAMPLED_PASSES パスの q の平面の組(R・G・B)の並び samples を足したもの(帯に分ける段では null)、c0 は最後の拡大の前の補正の
// 統計、levels は帯に分ける段の段 m = 1〜帯の数 − 1 の帯 m の全パスの平均 [{ level, width, height, mean }](mean は段の解像度
// width × height の画素ごとに rgb。帯に分けない段では空)、windowRatio は bay の系の撮影での拡散照度の全パスの平均の窓の比 P_in / P_out
// (ほかの撮影では null)、display は全パスの HDR の平均の表示(線形 sRGB)、passSeconds は最初のパスを除く 1 パスの所要、
// seconds は全体の所要。
async function capturePasses(lab, entry, candidate, passes, exposure) {
  const started = Date.now();
  const { bandCount } = candidate.tier;
  const names = packedBandsNamesOf(bandCount);
  // 段 m の帯 m は、段 m の帯を詰めた描画先の 1 枚目の rgb。
  const levelNames = Array.from({ length: bandCount - 1 }, (_, i) => `reduced-${i + 1}-0`);
  const inBay = entry.caseName === 'bay';
  await lab.setTier(candidate.tier);
  let firstPassSeconds = 0;
  const samples = [];
  for (let k = 0; k < passes; k++) {
    await lab.setSeed(seedOf(k));
    // 絵の落ち着きを待つのは最初のパスだけで、以後は seed だけが変わる。
    if (k === 0) await lab.capturePng();
    else await lab.render();
    for (const name of names) await lab.accumulateMoments(name, 4, k % BLOCKS);
    // 帯の和の分散は帯ごとの冪和から求まらないので、和を別に積む。帯に分けない段では帯 0 が和。
    if (bandCount > 1) await lab.accumulateMoments(BAND_SUM_NAME, 3, k % BLOCKS);
    await lab.accumulateMoments(C0_NAME, 3, k % BLOCKS);
    for (const name of levelNames) await lab.accumulateFloat(name, 3, 0);
    await lab.accumulateFloat('hdr', 3, 0);
    if (inBay) await lab.accumulateFloat('diffuse', 3, 0);
    if (bandCount === 1 && k < SAMPLED_PASSES) samples.push(exposedCorrectionOf(await lab.readFloat(names[0], 3), exposure));
    if (k === 0) firstPassSeconds = (Date.now() - started) / 1000;
  }
  const passSeconds = ((Date.now() - started) / 1000 - firstPassSeconds) / (passes - 1);
  const display = await lab.displayOfMean('hdr', passes);
  await lab.dropAccumulated('hdr');
  const windowRatio = inBay
    ? windowRatiosOf(entry, (await lab.takeAccumulated('diffuse', 1))[0].map((v) => v / passes))[0] : null;
  const packed = [];
  for (const name of names) packed.push(await lab.takeMoments(name, BLOCKS));
  // 帯ごとの冪和を詰めたテクスチャのチャンネルから取り出して、統計にする。
  const scale = exposure / Math.PI;
  const levels = [];
  for (const [i, name] of levelNames.entries()) {
    const [levelWidth, levelHeight] = await lab.floatSizeOf(name);
    const [sum] = await lab.takeAccumulated(name, 1);
    levels.push({ level: i + 1, width: levelWidth, height: levelHeight, mean: sum.map((v) => scale * v / passes) });
  }
  const bands = Array.from({ length: bandCount }, (_, band) => statisticsOf(packed[0].slots.map((_, slot) => ({
    sum: unpackedBand(packed.map((texture) => texture.slots[slot].sum), band),
    squareSum: unpackedBand(packed.map((texture) => texture.slots[slot].squareSum), band),
  })), scale, passes));
  const sum = bandCount === 1 ? bands[0] : statisticsOf((await lab.takeMoments(BAND_SUM_NAME, BLOCKS)).slots, scale, passes);
  const c0 = statisticsOf((await lab.takeMoments(C0_NAME, BLOCKS)).slots, scale, passes);
  // 帯に分けない段の成分の和は、詰めたテクスチャ 0 の 4 成分の和(余りのチャンネルは 0)。
  const raw = bandCount === 1 ? { ...bands[0], shape: shapeOf(packed[0].channelSum, scale, passes), samples } : null;
  const seconds = (Date.now() - started) / 1000;
  console.log(`${entry.key} ${candidate.label}: ${passSeconds.toFixed(3)} s/パス、最初のパス ${firstPassSeconds.toFixed(1)} s、`
    + `計 ${seconds.toFixed(0)} s`);
  return {
    width: packed[0].width, height: packed[0].height, bands, sum, raw, c0, levels, windowRatio, display,
    passSeconds, seconds,
  };
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

// 候補の統計 current の、A の統計 baseline に対する撮影ごとの行 { variance, ratio, blockRatioRange, shift, shiftCorrelation,
// bands, passSeconds, seconds }。印 mask の立った画素で測る。variance は帯の和の V、ratio は V/V_A、blockRatioRange は塊ごとの
// 比の [最小, 最大]。shift は帯の和の偶数番目と奇数番目の平均の A との差 d偶・d奇 の mean(Σ_c d偶·d奇)、shiftCorrelation は
// その中心化しない相関。bands は帯ごとの { variance, meanRms }(帯の V と μ の RMS)。
function rowOf(current, baseline, mask) {
  const [evenShift, oddShift] = current.sum.halves.map((half, h) => half.map((v, i) => v - baseline.sum.halves[h][i]));
  const shift = maskedMeanOf(evenShift.map((d, i) => d * oddShift[i]), mask);
  const [evenPower, oddPower] = [evenShift, oddShift].map((d) => maskedMeanOf(d.map((v) => v * v), mask));
  return {
    ...sumRowOf(current.sum, baseline.sum, mask),
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

// 候補の帯の和の統計 sum の、A の帯の和の統計 baseline に対する { variance, ratio, blockRatioRange }(rowOf)。
function sumRowOf(sum, baseline, mask) {
  const variance = maskedMeanOf(sum.variance, mask);
  const blockRatios = sum.blockVariances.map(
    (values, b) => maskedMeanOf(values, mask) / maskedMeanOf(baseline.blockVariances[b], mask));
  return {
    variance,
    ratio: variance / maskedMeanOf(baseline.variance, mask),
    blockRatioRange: [Math.min(...blockRatios), Math.max(...blockRatios)],
  };
}

// ---- 保存と画像 ----

// 候補 label の撮影 key の、帯ごと・帯の和・C_0 の q の画素ごとの平均・不偏分散・偶数番目と奇数番目のパスの平均(画素ごとに
// rgb)、段 m の帯 m の q の平均(段の解像度の画素ごとに rgb)、全パスの HDR の平均の表示(線形 sRGB、絵の画素ごとに rgb)と、
// 帯に分けない候補では成分の和の歪度・尖度(画素ごとに 1 つ。定まらない画素は NaN)を、単精度で dir の data/ へ書く。
function writeStatistics(dir, key, label, { bands, sum, c0, levels, display, raw }) {
  const write = (kind, values) => writeFloats(path.join(dir, 'data', `${key}.${label}.${kind}.f32`), Float32Array.from(values));
  const named = [...bands.map((b, i) => [`band${i}`, b]), ['sum', sum], ['c0', c0]];
  for (const [name, { mean, variance, halves: [even, odd] }] of named) {
    for (const [kind, values] of Object.entries({ mean, variance, even, odd })) write(`${name}.${kind}`, values);
  }
  for (const { level, mean } of levels) write(`level${level}.band${level}.mean`, mean);
  write('display', display);
  if (raw === null) return;
  write('skewness', raw.shape.skewness);
  write('kurtosis', raw.shape.kurtosis);
}

// 符号つきでない画像の撮影ごとの尺度 { sigmaWhite, ratioFloor, kurtosisWhite }。A の帯の和の統計 baseline の、印 mask の立った
// 画素とパス数 passes から決める。sigmaWhite は白に当たる σ、ratioFloor は分散の比を読まない分散の和の上限、kurtosisWhite は
// 白に当たる尖度(passes パスでとれる上限)。
function imageScalesOf(baseline, mask, passes) {
  const pixels = Array.from(mask.keys()).filter((p) => mask[p]);
  return {
    sigmaWhite: percentileOf(pixels.map((p) => Math.sqrt(varianceSumOf(baseline.variance, p))), 0.99),
    ratioFloor: 0.01 * maskedMeanOf(baseline.variance, mask),
    kurtosisWhite: kurtosisBoundOf(passes),
  };
}

// 分散の比の表示の、端の色に当たる log2 の比。
const RATIO_OCTAVES = 2;

// 尖度の表示: log β₂ を、正規分布の NORMAL_KURTOSIS で灰、白に当たる尖度で白へ。β₂ の定まらない画素(σ_s = 0)は
// UNDEFINED_KURTOSIS_COLOR。
const NORMAL_KURTOSIS = 3;
const UNDEFINED_KURTOSIS_COLOR = [0.1, 0.2, 0.6];

// 画素の尖度 kurtosis の色。white は白に当たる尖度。
function kurtosisColorOf(kurtosis, white) {
  if (!Number.isFinite(kurtosis)) return UNDEFINED_KURTOSIS_COLOR;
  return Array(3).fill(0.5 + 0.5 * Math.log(kurtosis / NORMAL_KURTOSIS) / Math.log(white / NORMAL_KURTOSIS));
}

// 候補 label の撮影 key の、符号つきでない目で見る画像を dir へ書く。statistics は候補の統計と表示(capturePasses)、baseline は
// A の統計(A 自身なら null で、A と比べる画像を書かない)、mask は測る画素の印、scales は撮影の尺度(imageScalesOf)、chain は
// C_0 の画素ごとの量(chainPlanesOf)。σ と分散の比は帯の和の、尖度は帯に分けない候補の raw の。
function writeImages(dir, key, label, statistics, baseline, mask, scales, chain) {
  const { width, height, sum, raw, display } = statistics;
  const write = (kind, png) => writeFileSync(path.join(dir, `${key}.${label}.${kind}.png`), png);
  const scanPng = (colorOf) => scanPngOf(width, height, mask, colorOf);
  write('display', encodeRgbPng(WIDTH, HEIGHT, srgbCodesOfLinear(display)));
  for (const [kind, colorOf] of Object.entries(chainColorsOf(chain))) write(kind, scanPng(colorOf));
  write('sigma', scanPng((p) => Array(3).fill(Math.sqrt(varianceSumOf(sum.variance, p)) / scales.sigmaWhite)));
  if (raw !== null) write('kurtosis', scanPng((p) => kurtosisColorOf(raw.shape.kurtosis[p], scales.kurtosisWhite)));
  if (baseline === null) return;
  write('ratio', scanPng((p) => ratioColorOf(
    varianceSumOf(sum.variance, p), varianceSumOf(baseline.sum.variance, p), scales.ratioFloor, RATIO_OCTAVES)));
}

// 符号つきの画像の材料: 候補の統計 statistics(capturePasses)と A の統計 baseline(A 自身なら null)と C_0 の画素ごとの量 chain の、
// 補正項の値 { 'mean-c0', 'mean-q' }(μ(C_0) と帯の和の平均)と差分の値 { dev, diff }(恒等からのずれ d と、帯の和の平均の A との
// 差。diff は A では無い)。どれも画素ごとに rgb の Float32Array。
function signedFieldsOf({ c0, sum }, baseline, chain) {
  return {
    terms: { 'mean-c0': Float32Array.from(c0.mean), 'mean-q': Float32Array.from(sum.mean) },
    differences: {
      dev: Float32Array.from(chain.deviation),
      ...(baseline === null ? {} : { diff: Float32Array.from(sum.mean, (v, i) => v - baseline.sum.mean[i]) }),
    },
  };
}

// 撮影ごとの符号つきの画像の材料 signed(撮影の key → { width, height, mask, candidates: label → signedFieldsOf })から、
// <撮影>.<候補>.<種類>.x<g>.png を dir へ書き、補正項の係数 g を返す。g は A(label baseline)の μ(C_0) の全撮影の測る画素から
// signedGainOf で決め、全候補の補正項(mean-c0・mean-q)に使う。差分(dev・diff)の係数は DIFFERENCE_GAIN。
function writeSignedImages(dir, signed, baseline) {
  const gain = signedGainOf(Object.values(signed).map(({ mask, candidates }) => ({
    values: candidates[baseline].terms['mean-c0'], mask,
  })));
  for (const [key, { width, height, mask, candidates }] of Object.entries(signed)) {
    for (const [label, { terms, differences }] of Object.entries(candidates)) {
      for (const [values, kindGain] of [[terms, gain], [differences, DIFFERENCE_GAIN]]) {
        for (const [kind, field] of Object.entries(values)) {
          writeFileSync(path.join(dir, `${key}.${label}.${kind}.x${kindGain}.png`),
            scanPngOf(width, height, mask, signedColorOf(field, kindGain)));
        }
      }
    }
  }
  return gain;
}

// ---- 表 ----

// 値の並び values(どれも正)の幾何平均。
const geometricMeanOf = (values) => Math.exp(values.reduce((sum, v) => sum + Math.log(v), 0) / values.length);
// 最小〜最大の文字列。測れなかった範囲は —。
const rangeOf = (range, digits) => (range === null ? '—' : `${fixed(range[0], digits)}〜${fixed(range[1], digits)}`);

// 記録 record の表。候補ごとのまとめと費用、撮影ごとの行と C_0 と帯ごとの表と分布の表、保存したものの説明。
function reportOf({ head, passes, candidates, entries, scales, scanCosts, costs, signedGain, shots }) {
  const labels = candidates.map((c) => c.label);
  const unsplitLabels = candidates.filter((c) => c.tier.bandCount === 1).map((c) => c.label);
  const split = candidates.filter((c) => c.tier.bandCount > 1);
  const summary = candidates.map((candidate, i) => {
    const costRatio = scanCosts[i] / scanCosts[0];
    const costCells = [fixed(scanCosts[i], 3), fixed(costRatio, 3)];
    const ratios = entries.map((key) => shots[key].rows[candidate.label].ratio);
    return [
      candidate.label, fixed(geometricMeanOf(ratios), 3), rangeOf([Math.min(...ratios), Math.max(...ratios)], 3),
      ...costCells, fixed(geometricMeanOf(ratios.map((r) => 1 / (r * costRatio))), 3),
    ];
  });
  // 近傍拡散の行の和の、マテリアルの行に対する比。測れなかった行があれば null。
  const nearbyRatioOf = (row) => (COST_ROWS.some((label) => row[label] === null) ? null
    : COST_ROWS.slice(0, -1).reduce((sum, label) => sum + row[label], 0) / row[COST_ROWS.at(-1)]);
  const costTable = table(['候補', ...COST_ROWS, '近傍拡散の和 / マテリアル'], candidates.map((candidate, i) => [
    candidate.label, ...COST_ROWS.map((label) => fixed(costs[i][label], 3)), fixed(nearbyRatioOf(costs[i]), 3),
  ]));
  const perShot = entries.flatMap((key) => {
    const { width, height, measured, meanRms, rows, chains, distributions } = shots[key];
    return [
      '', `### ${key}(走査 ${width}×${height}、測る画素 ${measured}、μ_A の RMS ${fixed(meanRms, 5)})`, '',
      ...table(['候補', '√V', 'V/V_A', '塊ごとの V_b/V_A,b', 'mean(Σ d偶·d奇)', '√mean(Σ d偶·d奇)', 'd偶 と d奇 の相関'],
        labels.map((label) => {
          const row = rows[label];
          return [
            label, fixed(Math.sqrt(row.variance), 5), fixed(row.ratio, 3),
            rangeOf(row.blockRatioRange, 3), exponential(row.shift), fixed(Math.sqrt(row.shift), 5),
            fixed(row.shiftCorrelation, 3),
          ];
        })),
      ...chainTableOf(labels, chains),
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
    '撮影の key の @occlusion は遮蔽だけの方式。q = 露出係数·ΔE/π。V は帯の和の、測る画素で平均した Σ_c V_c(V_c は成分 c の',
    'seed についての不偏分散。帯の和はパスごとに帯を足してから積む)。V_ℓ は帯 ℓ の V。',
    'd偶・d奇 は帯の和の偶数番目・奇数番目のパスの平均の A との差で、相関は中心化しない Σ d偶·d奇 / √(Σ d偶² · Σ d奇²)。',
    'μ_ℓ の RMS は √(測る画素で平均した Σ_c μ_ℓ,c²)。',
    ...CHAIN_NOTES,
    '', ...distributionNotesOf(passes), '',
    ...candidates.map((c) => `- ${c.label}: \`${JSON.stringify(c.tier)}\``),
    '', '## まとめ', '',
    ...table(['候補', 'V/V_A 幾何平均', 'V/V_A 最小〜最大', '走査 p50 [ms]', 'T/T_A', '効率比 (V_A·T_A)/(V·T)'], summary),
    '', '### 費用(bay、同じページで段を交互に 3 巡した p50 の中央値 [ms])', '', ...costTable,
    '', '## 撮影ごと', ...perShot,
    '', '## 保存したもの', '',
    '- `data/<撮影>.<候補>.band<ℓ>.{mean,variance,even,odd}.f32` — 帯 ℓ(0〜帯の数 − 1。帯に分けない候補は帯 0 = raw)の q の',
    '  全パスの平均・不偏分散・偶数番目と奇数番目のパスの平均。単精度で、走査の解像度(撮影ごとの width × height は record.json の',
    '  shots)の画素ごとに rgb、行は上から。',
    '- `data/<撮影>.<候補>.{sum,c0}.{mean,variance,even,odd}.f32` — 帯の和(パスごとに帯を足したもの)と C_0 の同じ形の統計。',
    '- `data/<撮影>.<候補>.level<m>.band<m>.mean.f32` — 帯に分ける候補の、段 m(1〜帯の数 − 1)の帯 m の q の全パスの平均。段の',
    '  解像度(record.json の shots.<撮影>.levels.<候補>)の画素ごとに rgb。',
    `- \`data/<撮影>.<候補>.display.f32\` — 全パスの HDR の平均の表示(線形 sRGB、${WIDTH}×${HEIGHT} の画素ごとに rgb)。`,
    '- `data/<撮影>.<候補>.{skewness,kurtosis}.f32` — 帯に分けない候補の s の歪度 γ₁・尖度 β₂。単精度で、走査の解像度の画素ごとに',
    '  1 つ。σ_s = 0 の画素は NaN。',
    `- \`data/<撮影>.radius.f32\` — 近傍の半径 [絵の画素](${WIDTH}×${HEIGHT}、単精度)。測る画素は、走査の画素で近傍の半径が 2 を超える面。`,
    `- 符号つきの画像 \`<撮影>.<候補>.<種類>.x<g>.png\` — 値 v を成分ごとに符号値 round(255·clamp(0.5 + g·v, 0, 1)) で描いたもの`,
    '  (sRGB の変換なし、0 が 50% の灰色、土台の画像を足さない)。補正項の `mean-c0`(μ(C_0))と `mean-q`(帯の和の平均)は',
    `  g = ${signedGain}(A の μ(C_0) の全撮影の測る画素の |q| の 99.5 パーセンタイル p で g·p ≤ 0.45 を満たす最大の 2 の冪、全候補で`,
    `  共通)、差分の \`dev\`(d = μ(C_0 − 帯の和))と \`diff\`(帯の和の平均 − μ_A)は g = ${DIFFERENCE_GAIN}。印の外は濃い青。`,
    '- `<撮影>.<候補>.display.png` — HDR のパス平均の表示。`sigma.png` — 帯の和の',
    `  √(Σ_c V_c) / sigmaWhite。\`kurtosis.png\` — 0.5 + 0.5·ln(β₂/${NORMAL_KURTOSIS}) / ln(kurtosisWhite/${NORMAL_KURTOSIS}) の灰色`,
    `  (正規分布の β₂ = ${NORMAL_KURTOSIS} で灰、${passes} パスでとれる上限 kurtosisWhite で白、β₂ = 1 で暗い灰)。σ_s = 0 の画素は青。`,
    '  `ratio.png` — 帯の和の log2(Σ_c V_c / Σ_c V_A,c) を ±2 で青〜灰〜赤(A には無い)。kurtosis は帯に分けない候補',
    '  だけ。尺度は record.json の shots.<撮影>.imageScales。印の外は濃い青。',
    ...CHAIN_IMAGE_NOTES,
    '- `record.json` の shots.<撮影>.rows.<候補>.bands — 帯ごとの V_ℓ(variance)と μ_ℓ の RMS(meanRms)。',
    '  shots.<撮影>.chains.<候補> — C_0 の行(上の表の数)。costs — 候補ごとの GPU の行の p50 [ms]。',
    '  shots.<撮影>.distributions.<候補> — 帯に分けない候補の分布の表の数(groups・quiet・windows)と R(s)(r。scales の順)。', '',
  ].join('\n');
}
