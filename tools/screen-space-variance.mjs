// 近傍拡散補正の生の走査(均し・拡大の前の raw)の、seed についての画素ごとの分散の計測。候補の段ごとに、全候補で共通の
// seed の列で撮ったパスから q の画素ごとの平均と不偏分散を求め、先頭の候補 A と比べる。表・数・画素ごとの統計・目で見る
// 画像を .render-lab-shots/ssd-variance/<出力先>/ へ書く。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { encodeRgbPng } from './png.mjs';
import { srgbCodesOfLinear } from './screen-space-error.mjs';
import {
  ENTRIES, fixed, HEIGHT, headHash, maskOf, seedOf, selectedEntries, shotsDir, table, TIERS, WIDTH, withLab, writeFloats,
} from './screen-space-lab.mjs';

const USAGE = 'usage: variance [<candidates.json>] [--entries <key,...>] [--sets <set,...>] [--passes <N>] [--out <名前>]';
// 既定の候補: 中の精細さの均す前。
const DEFAULT_CANDIDATES = [{ label: 'medium-raw', tier: { ...TIERS.medium, denoiseRadius: 0 } }];
const DEFAULT_PASSES = 256;
// seed の列を k mod BLOCKS で分ける塊の数。塊 0・2 が偶数番目、1・3 が奇数番目のパス。
const BLOCKS = 4;
// 費用に使う GPU の行(src/render/gpu-timings.ts の GPU_PASS_LABELS の近傍拡散の走査)。
const SCAN_ROW = '近傍拡散走査';

// 撮影の候補ごとの行を測り、費用を測って、表と記録を書く。
export async function variance({ positional, options }) {
  const candidates = positional[0] === undefined ? DEFAULT_CANDIDATES : JSON.parse(readFileSync(positional[0], 'utf8'));
  const passes = Number(options.passes ?? DEFAULT_PASSES);
  if (!Number.isInteger(passes) || passes % BLOCKS !== 0 || passes < 2 * BLOCKS) {
    throw new Error(`--passes must be a multiple of ${BLOCKS} and at least ${2 * BLOCKS}\n${USAGE}`);
  }
  const entries = selectedEntries(options.entries === undefined && options.sets === undefined ? { sets: 'tuning' } : options);
  const head = headHash();
  const outDir = path.join(shotsDir, 'ssd-variance', options.out ?? head);
  mkdirSync(path.join(outDir, 'data'), { recursive: true });
  const { shots, scanCosts } = await withLab(async (lab) => {
    const measured = {};
    for (const entry of entries) measured[entry.key] = await measureShot(lab, outDir, entry, candidates, passes);
    // 費用。コンパイルを済ませてから、bay で段を交互に測る。
    await lab.show(ENTRIES[0]);
    await lab.capturePng();
    const costs = await lab.measureTiers(candidates.map((c) => c.tier), 3);
    return { shots: measured, scanCosts: costs.map((row) => row[SCAN_ROW]) };
  });
  const record = { head, passes, candidates, entries: entries.map((e) => e.key), scanCosts, shots };
  writeFileSync(path.join(outDir, 'record.json'), JSON.stringify(record, null, 1));
  const report = reportOf(record);
  writeFileSync(path.join(outDir, 'report.md'), report);
  console.log(`\n${report}`);
}

// ---- 撮影 ----

// 撮影 entry で候補 candidates を passes パスずつ撮り、画素ごとの統計と目で見る画像を dir へ書いて、撮影の記録
// { width, height, measured, exposure, meanRms, imageScales, rows } を返す。width × height は走査の解像度、measured は
// 測る画素の数、meanRms は A の平均 μ_A の RMS、rows は候補の label ごとの行(rowOf)。lab は withLab の口。
async function measureShot(lab, dir, entry, candidates, passes) {
  await lab.show(entry);
  await lab.capturePng();
  const radius = await lab.readFloat('projected-radius', 1);
  const exposure = await lab.exposureFactor();
  writeFloats(path.join(dir, 'data', `${entry.key}.radius.f32`), radius);
  const baseline = await capturePasses(lab, entry, candidates[0], passes, exposure);
  const { width, height } = baseline;
  const mask = scanMaskOf(radius, width, height);
  const imageScales = imageScalesOf(baseline, mask, passes);
  const rows = {};
  for (const [index, candidate] of candidates.entries()) {
    const current = index === 0 ? baseline : await capturePasses(lab, entry, candidate, passes, exposure);
    if (current.width !== width || current.height !== height) {
      throw new Error(`${candidate.label} scans ${current.width}×${current.height}, A scans ${width}×${height}`);
    }
    writeStatistics(dir, entry.key, candidate.label, current);
    writeImages(dir, entry.key, candidate.label, current, index === 0 ? null : baseline, mask, imageScales);
    rows[candidate.label] = rowOf(current, baseline, mask);
  }
  const measured = mask.reduce((count, m) => count + m, 0);
  const meanRms = Math.sqrt(maskedMeanOf(baseline.mean.map((v) => v * v), mask));
  return { width, height, measured, exposure, meanRms, imageScales, rows };
}

// 表示中の撮影 entry を候補 candidate の段で passes パス撮り、露出係数 exposure の q の画素ごとの統計(statisticsOf)に、
// 全パスの HDR の平均の表示 display(線形 sRGB)と、最初のパスを除く 1 パスの所要 passSeconds と全体の所要 seconds を
// 足して返す。
async function capturePasses(lab, entry, candidate, passes, exposure) {
  const started = Date.now();
  await lab.setTier(candidate.tier);
  let firstPassSeconds = 0;
  for (let k = 0; k < passes; k++) {
    await lab.setSeed(seedOf(k));
    // 絵の落ち着きを待つのは最初のパスだけで、以後は seed だけが変わる。
    if (k === 0) await lab.capturePng();
    else await lab.render();
    await lab.accumulateMoments('raw-correction', 3, k % BLOCKS);
    await lab.accumulateFloat('hdr', 3, 0);
    if (k === 0) firstPassSeconds = (Date.now() - started) / 1000;
  }
  const passSeconds = ((Date.now() - started) / 1000 - firstPassSeconds) / (passes - 1);
  const display = await lab.displayOfMean('hdr', passes);
  await lab.dropAccumulated('hdr');
  const statistics = statisticsOf(await lab.takeMoments('raw-correction', BLOCKS), exposure, passes);
  const seconds = (Date.now() - started) / 1000;
  console.log(`${entry.key} ${candidate.label}: ${passSeconds.toFixed(3)} s/パス、最初のパス ${firstPassSeconds.toFixed(1)} s、`
    + `計 ${seconds.toFixed(0)} s`);
  return { ...statistics, display, passSeconds, seconds };
}

// 走査の解像度 width × height の画素ごとの、測る画素の印。走査の画素が読む G バッファの画素
// (src/render/pipeline/screen-space/hemisphere-scan.ts の gbufferTexelOf)での、近傍の半径 radius(絵の画素ごと)の印 maskOf。
function scanMaskOf(radius, width, height) {
  const full = maskOf(radius);
  const texelOf = (pixel, size, fullSize) => Math.floor((2 * pixel + 1) * fullSize / (2 * size));
  return Uint8Array.from({ length: width * height }, (_, p) => (
    full[texelOf(Math.floor(p / width), height, HEIGHT) * WIDTH + texelOf(p % width, width, WIDTH)]));
}

// ---- 統計 ----

// ページで積んだ塊ごとの補正の和と二乗和 moments(takeMoments の返り値)の、露出係数 exposure の q の尺度での画素ごとの
// 統計 { width, height, mean, variance, halves, blockVariances }。どれも画素ごとに rgb を並べた Float64Array で、mean と
// variance は全 passes パスの平均と不偏分散、halves は偶数番目と奇数番目のパスの平均の組、blockVariances は塊ごとの不偏分散。
function statisticsOf({ width, height, slots }, exposure, passes) {
  const scale = exposure / Math.PI;
  const length = width * height * 3;
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
  return { width, height, mean, variance, halves, blockVariances };
}

// n 個の値の和 sum と二乗和 squareSum からの不偏分散。
const unbiasedVarianceOf = (sum, squareSum, n) => (squareSum - sum * sum / n) / (n - 1);

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

// 画素ごとに rgb を並べた分散 variance の、画素 p の 3 成分の和。
const varianceSumOf = (variance, p) => variance[3 * p] + variance[3 * p + 1] + variance[3 * p + 2];

// 候補の統計 current の、A の統計 baseline に対する撮影ごとの行 { variance, ratio, blockRatioRange, shift, shiftCorrelation,
// passSeconds, seconds }。印 mask の立った画素で測る。variance は V、ratio は V/V_A、blockRatioRange は塊ごとの比の
// [最小, 最大]、shift は偶数番目と奇数番目の平均の A との差 d偶・d奇 の mean(Σ_c d偶·d奇)、shiftCorrelation はその中心化
// しない相関。
function rowOf(current, baseline, mask) {
  const variance = maskedMeanOf(current.variance, mask);
  const blockRatios = current.blockVariances.map(
    (values, b) => maskedMeanOf(values, mask) / maskedMeanOf(baseline.blockVariances[b], mask));
  const [evenShift, oddShift] = current.halves.map((half, h) => half.map((v, i) => v - baseline.halves[h][i]));
  const shift = maskedMeanOf(evenShift.map((d, i) => d * oddShift[i]), mask);
  const [evenPower, oddPower] = [evenShift, oddShift].map((d) => maskedMeanOf(d.map((v) => v * v), mask));
  return {
    variance,
    ratio: variance / maskedMeanOf(baseline.variance, mask),
    blockRatioRange: [Math.min(...blockRatios), Math.max(...blockRatios)],
    shift,
    shiftCorrelation: shift / Math.sqrt(evenPower * oddPower),
    passSeconds: current.passSeconds,
    seconds: current.seconds,
  };
}

// ---- 保存と画像 ----

// 候補 label の撮影 key の、q の画素ごとの平均・不偏分散・偶数番目と奇数番目のパスの平均を、単精度で dir の data/ へ書く。
function writeStatistics(dir, key, label, { mean, variance, halves: [even, odd] }) {
  for (const [kind, values] of Object.entries({ mean, variance, even, odd })) {
    writeFloats(path.join(dir, 'data', `${key}.${label}.${kind}.f32`), Float32Array.from(values));
  }
}

// 目で見る画像の撮影ごとの尺度 { meanRange, sigmaWhite, diffRange, ratioFloor }。A の統計 baseline の、印 mask の立った
// 画素から決める。meanRange は平均の表示の 0.5 からの振れ幅 1 に当たる q、sigmaWhite は白に当たる σ、diffRange は A との差の
// 表示の振れ幅 1 に当たる q、ratioFloor は分散の比を読まない分散の和の上限。
function imageScalesOf(baseline, mask, passes) {
  const pixels = Array.from(mask.keys()).filter((p) => mask[p]);
  const variance = maskedMeanOf(baseline.variance, mask);
  return {
    meanRange: 2 * percentileOf(pixels.flatMap((p) => [0, 1, 2].map((c) => Math.abs(baseline.mean[3 * p + c]))), 0.99),
    sigmaWhite: percentileOf(pixels.map((p) => Math.sqrt(varianceSumOf(baseline.variance, p))), 0.99),
    diffRange: 8 * Math.sqrt(2 * variance / passes),
    ratioFloor: 0.01 * variance,
  };
}

// 値の並び values の、小さい側から割合 fraction の位置の値。
function percentileOf(values, fraction) {
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
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

// 候補 label の撮影 key の目で見る画像を dir へ書く。statistics は候補の統計と表示(capturePasses)、baseline は A の統計
// (A 自身なら null で、A と比べる画像を書かない)、mask は測る画素の印、scales は撮影の尺度(imageScalesOf)。
function writeImages(dir, key, label, statistics, baseline, mask, scales) {
  const { width, height, mean, variance, display } = statistics;
  const write = (kind, png) => writeFileSync(path.join(dir, `${key}.${label}.${kind}.png`), png);
  const scanPng = (colorOf) => scanPngOf(width, height, mask, colorOf);
  write('mean', encodeRgbPng(WIDTH, HEIGHT, srgbCodesOfLinear(display)));
  write('mean-q', scanPng((p) => [0, 1, 2].map((c) => 0.5 + mean[3 * p + c] / scales.meanRange)));
  write('sigma', scanPng((p) => Array(3).fill(Math.sqrt(varianceSumOf(variance, p)) / scales.sigmaWhite)));
  if (baseline === null) return;
  write('diff', scanPng((p) => [0, 1, 2].map((c) => 0.5 + (mean[3 * p + c] - baseline.mean[3 * p + c]) / scales.diffRange)));
  write('ratio', scanPng((p) => ratioColorOf(
    varianceSumOf(variance, p), varianceSumOf(baseline.variance, p), scales.ratioFloor)));
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
// 有効数字 3 桁の指数表記の文字列。測れなかった値は —。
const exponential = (v) => (Number.isFinite(v) ? v.toExponential(2) : '—');
// 最小〜最大の文字列。
const rangeOf = ([low, high], digits) => `${fixed(low, digits)}〜${fixed(high, digits)}`;

// 記録 record の表。候補ごとのまとめ、撮影ごとの行、保存したものの説明。
function reportOf({ head, passes, candidates, entries, scanCosts, shots }) {
  const summary = candidates.map((candidate, i) => {
    const ratios = entries.map((key) => shots[key].rows[candidate.label].ratio);
    const costRatio = scanCosts[i] / scanCosts[0];
    return [
      candidate.label, fixed(geometricMeanOf(ratios), 3), rangeOf([Math.min(...ratios), Math.max(...ratios)], 3),
      fixed(scanCosts[i], 3), fixed(costRatio, 3), fixed(geometricMeanOf(ratios.map((r) => 1 / (r * costRatio))), 3),
    ];
  });
  const perShot = entries.flatMap((key) => {
    const { width, height, measured, meanRms, rows } = shots[key];
    return [
      '', `### ${key}(走査 ${width}×${height}、測る画素 ${measured}、μ_A の RMS ${fixed(meanRms, 5)})`, '',
      ...table(['候補', '√V', 'V/V_A', '塊ごとの V_b/V_A,b', 'mean(Σ d偶·d奇)', '√mean(Σ d偶·d奇)', 'd偶 と d奇 の相関'],
        candidates.map(({ label }) => {
          const row = rows[label];
          return [
            label, fixed(Math.sqrt(row.variance), 5), fixed(row.ratio, 3), rangeOf(row.blockRatioRange, 3),
            exponential(row.shift), fixed(Math.sqrt(row.shift), 5), fixed(row.shiftCorrelation, 3),
          ];
        })),
    ];
  });
  return [
    '# 近傍拡散補正の raw の、seed についての画素ごとの分散', '',
    `HEAD ${head}、${passes} パス(seedOf(0〜${passes - 1})、k mod ${BLOCKS} の塊に分ける)。基準 A = ${candidates[0].label}。`,
    'q = 露出係数·ΔE/π。V は測る画素で平均した Σ_c s²(s² は seed についての不偏分散)。d偶・d奇 は偶数番目・奇数番目の',
    'パスの平均の A との差で、相関は中心化しない Σ d偶·d奇 / √(Σ d偶² · Σ d奇²)。', '',
    ...candidates.map((c) => `- ${c.label}: \`${JSON.stringify(c.tier)}\``),
    '', '## まとめ', '',
    ...table(['候補', 'V/V_A 幾何平均', 'V/V_A 最小〜最大', '走査 p50 [ms]', 'T/T_A', '効率比 (V_A·T_A)/(V·T)'], summary),
    '', '## 撮影ごと', ...perShot,
    '', '## 保存したもの', '',
    `- \`data/<撮影>.<候補>.{mean,variance,even,odd}.f32\` — q の全パスの平均・不偏分散・偶数番目と奇数番目のパスの平均。`
      + '単精度で、走査の解像度(撮影ごとの width × height は record.json の shots)の画素ごとに rgb。',
    `- \`data/<撮影>.radius.f32\` — 近傍の半径 [絵の画素](${WIDTH}×${HEIGHT}、単精度)。測る画素はこれが 8 を超える面。`,
    '- `<撮影>.<候補>.mean.png` — HDR のパス平均の表示。`mean-q.png` — 0.5 + μ / meanRange。`sigma.png` — √(Σ_c s²) / sigmaWhite。',
    '  `diff.png` — 0.5 + (μ − μ_A) / diffRange。`ratio.png` — log2(Σ_c s² / Σ_c s²_A) を ±2 で青〜灰〜赤。尺度は record.json の',
    '  shots.<撮影>.imageScales。印の外は黒。', '',
  ].join('\n');
}
