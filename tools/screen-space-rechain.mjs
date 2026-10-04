// 近傍拡散補正の鎖のやり直し。帯の撮影(bands。帯の平均だけなら variance でもよい)が残した走査の帯の値を、走査を撮り
// 直さずに、走査を描かない段の範囲で鎖(帯の縮小・拡大と合流・最後の拡大)へ通し直す。候補の段ごとに、帯の全パスの平均を
// 流し込んだ鎖の出力(C_0 と段 m の帯 m)と、そのまま seed を回した表示、残した先頭のパスを 1 枚ずつ流し込んだ C_0 の
// 画素ごとの統計(恒等からのずれと揺れ)と 1 パスの絵(C_0 と描画バッファの解像度の補正)を、
// .render-lab-shots/ssd-chain/<出力先>/ へ書く。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { encodeRgbPng } from './png.mjs';
import { srgbCodesOfLinear } from './screen-space-error.mjs';
import {
  CHAIN_IMAGE_NOTES, CHAIN_NOTES, chainColorsOf, chainPlanesOf, chainRowOf, chainTableOf,
} from './screen-space-chain.mjs';
import {
  DIFFERENCE_GAIN, entryOfKey, fixed, HEIGHT, headHash, maskedMeanOf, maskOf, readFloats, readHalfFloats, seedOf,
  shotsDir, signedColorOf, signedGainOf, table, unpackedBand, WIDTH, withLab, writeFloats,
} from './screen-space-lab.mjs';
import { BLOCKS, keptPassesFileOf, scanMaskOf, scanPngOf, statisticsOf } from './screen-space-scan.mjs';

const USAGE = 'usage: chain <帯の撮影の置き場> [--bands <候補>] [--candidates <candidates.json>] [--display-seeds <N>] '
  + '[--frame-pass <k>] [--out <名前>]';

// 撮影の候補ごとに鎖をやり直し、画素ごとの値と画像と表を書く。<帯の撮影の置き場> は .render-lab-shots/ の下の帯の撮影の
// 出力先(例 ssd-bands/<名前>・ssd-variance/<名前>)、--bands はその中の流し込む帯の候補(候補が 1 つなら省ける)、
// --candidates は鎖の段の候補(既定は defaultCandidatesOf)、--display-seeds は表示を作る seed の数(既定 0 で作らない)、
// --frame-pass は 1 パスの絵を作る残したパスの番号。
export async function rechain({ positional, options }) {
  if (positional[0] === undefined) throw new Error(USAGE);
  const sourceDir = path.join(shotsDir, positional[0]);
  const source = JSON.parse(readFileSync(path.join(sourceDir, 'record.json'), 'utf8'));
  const banded = bandedCandidateOf(source.candidates, options.bands);
  const listed = options.candidates === undefined
    ? defaultCandidatesOf(banded) : JSON.parse(readFileSync(options.candidates, 'utf8'));
  const candidates = listed.map((candidate) => resolvedCandidateOf(candidate, banded.tier));
  const settings = {
    displaySeeds: Number(options['display-seeds'] ?? 0),
    keptPasses: source.keptPasses ?? 0,
    framePass: Number(options['frame-pass'] ?? 0),
  };
  if (settings.keptPasses % BLOCKS !== 0) throw new Error(`kept passes ${settings.keptPasses} is not a multiple of ${BLOCKS}`);
  const head = headHash();
  const outDir = path.join(shotsDir, 'ssd-chain', options.out ?? head);
  mkdirSync(path.join(outDir, 'data'), { recursive: true });
  const shots = await withLab(async (lab) => {
    const done = {};
    for (const key of source.entries) {
      done[key] = await rechainShot(lab, { sourceDir, source, banded, key }, candidates, settings, outDir);
    }
    return done;
  });
  const signedGain = signedGainOf(Object.values(shots).map(({ sumMean, mask }) => ({ values: sumMean, mask })));
  for (const [key, shot] of Object.entries(shots)) writeSignedImages(outDir, key, shot, signedGain);
  const record = {
    head, source: positional[0], banded: banded.label, candidates, ...settings, signedGain,
    entries: source.entries,
    shots: Object.fromEntries(Object.entries(shots).map(([key, { record: shot }]) => [key, shot])),
  };
  writeFileSync(path.join(outDir, 'record.json'), JSON.stringify(record, null, 1));
  const report = reportOf(record);
  writeFileSync(path.join(outDir, 'report.md'), report);
  console.log(`\n${report}`);
}

// 帯の撮影の候補 candidates のうち、帯を流し込む候補(label。undefined なら候補が 1 つのときのその候補)。
function bandedCandidateOf(candidates, label) {
  if (label === undefined && candidates.length === 1) return candidates[0];
  const found = candidates.find((c) => c.label === label);
  if (found === undefined) throw new Error(`--bands must be one of ${candidates.map((c) => c.label).join(', ')}\n${USAGE}`);
  return found;
}

// 既定の候補: 帯に分けない段(帯の和を帯 0 に流し込む raw)、流し込む候補の段、その帯 1〜帯の数 − 1 を 1 つだけ残したもの。
const defaultCandidatesOf = (banded) => [
  { label: 'raw', tier: { bandCount: 1 } },
  { label: banded.label, tier: {} },
  ...Array.from({ length: banded.tier.bandCount - 1 }, (_, i) => ({
    label: `${banded.label}-iso${i + 1}`, tier: { isolatedBand: i + 1 },
  })),
];

// 候補 { label, tier }(tier は流し込む候補の段 bandedTier との差分。isolatedBand は残す帯)を、{ label, tier, isolatedBand }
// (tier は走査の段、isolatedBand は残す帯か null)へ。流し込む帯から作れない段(解像度が違う・帯が多い・帯の尺度が違う)なら
// 投げる。帯を減らした段の最上の帯は、流し込む帯のそれより上の帯の和(帯の重みは、帯の数を減らすと上の帯がそこへ畳まれる)。
function resolvedCandidateOf({ label, tier: changes }, bandedTier) {
  const { isolatedBand = null, ...tier } = { ...bandedTier, ...changes };
  const foldable = tier.scale === bandedTier.scale && tier.bandCount <= bandedTier.bandCount
    && (tier.bandCount === 1 || tier.bandScale === bandedTier.bandScale);
  if (!foldable) throw new Error(`${label}: ${JSON.stringify(tier)} cannot be made from the bands of ${JSON.stringify(bandedTier)}`);
  if (isolatedBand !== null && isolatedBand >= tier.bandCount) throw new Error(`${label}: no band ${isolatedBand} to isolate`);
  return { label, tier, isolatedBand };
}

// ---- 撮影 ----

// 撮影 key の候補 candidates の鎖をやり直し、画素ごとの値と符号つきでない画像を dir へ書いて、{ record, mask, fullMask,
// sumMean, images } を返す。record は撮影の記録 { width, height, exposure, meanRms, candidates }(candidates は候補の label
// ごとの { seconds, deviationRatio, chain, levels })、mask と fullMask は走査と描画バッファの解像度の測る画素の印、sumMean は
// 帯の和の平均(q)、images は候補の label ごとの符号つきの画像の材料。from は帯の撮影 { sourceDir, source, banded, key }、
// settings は rechain の設定。
async function rechainShot(lab, from, candidates, settings, dir) {
  const { sourceDir, source, banded, key } = from;
  const { width, height, exposure } = source.shots[key];
  const radius = readFloats(path.join(sourceDir, 'data', `${key}.radius.f32`));
  const mask = scanMaskOf(radius, banded.tier.scale, width, height);
  // ΔE と q(露出係数·ΔE/π)の換算。
  const toDelta = Math.PI / exposure;
  const toQ = exposure / Math.PI;
  const meanBands = Array.from({ length: banded.tier.bandCount }, (_, band) => Float32Array.from(
    readFloats(path.join(sourceDir, 'data', `${key}.${banded.label}.band${band}.mean.f32`)), (v) => v * toDelta));
  const sumMean = foldedBandsOf(meanBands, 1, null)[0].map((v) => v * toQ);
  const meanRms = Math.sqrt(maskedMeanOf(sumMean.map((v) => v * v), mask));
  const passes = keptPassesOf(sourceDir, key, banded, width * height * 4, settings.keptPasses);
  await lab.show(entryOfKey(key));
  await lab.capturePng();
  const records = {};
  const images = {};
  try {
    for (const candidate of candidates) {
      const started = Date.now();
      const bandsOf = (bands) => foldedBandsOf(bands, candidate.tier.bandCount, candidate.isolatedBand);
      await lab.setTier(candidate.tier);
      await lab.setStageRange('chain');
      // 描画先の寸法を段へ合わせてから流し込む。
      await lab.render();
      const mean = await meanChainOf(lab, bandsOf(meanBands), toQ, settings.displaySeeds);
      const run = await passChainOf(lab, passes, bandsOf, toQ, settings.framePass);
      const flowed = foldedBandsOf(bandsOf(meanBands), 1, null)[0].map((v) => v * toQ);
      const deviation = mean.c0.map((v, i) => v - flowed[i]);
      const planes = run === null ? null : chainPlanesOf(run.c0, run.sum, run.bands, mask, width, height);
      const chain = planes === null ? null : chainRowOf(planes, mask, width, meanRms, null);
      writeCandidate(dir, key, candidate.label, { mean, run, planes, mask, width, height });
      records[candidate.label] = {
        seconds: (Date.now() - started) / 1000,
        deviationRatio: Math.sqrt(maskedMeanOf(deviation.map((v) => v * v), mask)) / meanRms,
        chain,
        levels: mean.levels.map(({ level, width: w, height: h }) => ({ level, width: w, height: h })),
      };
      images[candidate.label] = { mean, run, deviation };
      console.log(`${key} ${candidate.label}: ${records[candidate.label].seconds.toFixed(1)} s`);
    }
  } finally {
    await lab.setStageRange('all');
  }
  const fullMask = maskOf(radius, banded.tier.scale);
  return { record: { width, height, exposure, meanRms, candidates: records }, mask, fullMask, sumMean, images };
}

// 帯の撮影が残した撮影 key の先頭 count パスの、パスごとの帯の値(帯ごとに画素ごとの rgb の ΔE)。size は帯を詰めた
// テクスチャ 1 枚の値の数。
function keptPassesOf(sourceDir, key, banded, size, count) {
  if (count === 0) return [];
  const textures = Array.from({ length: Math.ceil(3 * banded.tier.bandCount / 4) }, (_, i) => (
    readHalfFloats(keptPassesFileOf(sourceDir, key, banded.label, i))));
  return Array.from({ length: count }, (_, k) => {
    const packed = textures.map((values) => values.subarray(k * size, (k + 1) * size));
    return Array.from({ length: banded.tier.bandCount }, (_, band) => unpackedBand(packed, band));
  });
}

// 帯の値 bands(帯ごとに画素ごとの rgb)を、帯の数 count の段の帯へ畳む。帯 count − 1 は、それより上の帯の和。isolated が
// null でなければ、その帯のほかを 0 にする。
function foldedBandsOf(bands, count, isolated) {
  const top = bands[count - 1].map((_, i) => bands.slice(count - 1).reduce((sum, band) => sum + band[i], 0));
  return [...bands.slice(0, count - 1), top].map((band, b) => (
    isolated === null || isolated === b ? band : new Float32Array(band.length)));
}

// 帯の値 bands(帯ごとに画素ごとの rgb の ΔE)を、走査が帯を詰めた描画先へ流し込んで、段の範囲 'chain' で 1 回描く。
async function drawBands(lab, bands) {
  const pixels = bands[0].length / 3;
  const textures = Array.from({ length: Math.ceil(3 * bands.length / 4) }, () => new Float32Array(4 * pixels));
  for (const [band, values] of bands.entries()) {
    for (let c = 0; c < 3; c++) {
      const channel = 3 * band + c;
      for (let p = 0; p < pixels; p++) textures[Math.floor(channel / 4)][4 * p + channel % 4] = values[3 * p + c];
    }
  }
  for (const [i, rgba] of textures.entries()) await lab.writePackedBands(i, rgba);
  await lab.render();
}

// 帯の全パスの平均 bands(ΔE)を流し込んだ鎖の出力 { c0, levels, display }。c0 は C_0、levels は段 m = 1〜帯の数 − 1 の
// 帯 m の [{ level, width, height, values }](どれも q、画素ごとに rgb)、display は seed を displaySeeds 回回した HDR の平均の
// 表示(線形 sRGB。0 回なら null)。toQ は ΔE から q への係数。
async function meanChainOf(lab, bands, toQ, displaySeeds) {
  await drawBands(lab, bands);
  const inQ = (values) => values.map((v) => v * toQ);
  const c0 = inQ(await lab.readFloat('scan-correction', 3));
  const levels = [];
  for (let level = 1; level < bands.length; level++) {
    const name = `reduced-${level}-0`;
    const [levelWidth, levelHeight] = await lab.floatSizeOf(name);
    levels.push({ level, width: levelWidth, height: levelHeight, values: inQ(await lab.readFloat(name, 3)) });
  }
  if (displaySeeds === 0) return { c0, levels, display: null };
  for (let k = 0; k < displaySeeds; k++) {
    await lab.setSeed(seedOf(k));
    await lab.render();
    await lab.accumulateFloat('hdr', 3, 0);
  }
  const display = await lab.displayOfMean('hdr', displaySeeds);
  await lab.dropAccumulated('hdr');
  return { c0, levels, display };
}

// 残したパスの帯の値 passes(パスごとに帯ごとの画素ごとの rgb の ΔE)を、候補の段の帯へ畳んで(bandsOf)1 枚ずつ流し込み、
// パス k の seed で描いた鎖の { c0, sum, bands, frame }。c0・sum・bands は C_0・流し込んだ帯の和・帯ごとの q の統計
// (statisticsOf)、frame はパス framePass の { c0, correction }(走査の解像度の C_0 と描画バッファの解像度の補正。q、画素ごとに
// rgb)。passes が空なら null。
async function passChainOf(lab, passes, bandsOf, toQ, framePass) {
  if (passes.length === 0) return null;
  const slotsOf = (length) => Array.from({ length: BLOCKS }, () => ({
    sum: new Float64Array(length), squareSum: new Float64Array(length),
  }));
  const add = (slot, values) => values.forEach((v, i) => {
    slot.sum[i] += v;
    slot.squareSum[i] += v * v;
  });
  const length = passes[0][0].length;
  const [c0Slots, sumSlots] = [slotsOf(length), slotsOf(length)];
  const bandSlots = bandsOf(passes[0]).map(() => slotsOf(length));
  let frame = null;
  for (const [k, pass] of passes.entries()) {
    const bands = bandsOf(pass);
    await lab.setSeed(seedOf(k));
    await drawBands(lab, bands);
    const c0 = await lab.readFloat('scan-correction', 3);
    add(c0Slots[k % BLOCKS], c0);
    add(sumSlots[k % BLOCKS], foldedBandsOf(bands, 1, null)[0]);
    for (const [band, values] of bands.entries()) add(bandSlots[band][k % BLOCKS], values);
    if (k === framePass) {
      frame = { c0: c0.map((v) => v * toQ), correction: (await lab.readFloat('correction', 3)).map((v) => v * toQ) };
    }
  }
  const statisticsOfSlots = (slots) => statisticsOf(slots, toQ, passes.length);
  return {
    c0: statisticsOfSlots(c0Slots), sum: statisticsOfSlots(sumSlots), bands: bandSlots.map(statisticsOfSlots), frame,
  };
}

// ---- 保存と画像 ----

// 候補 label の撮影 key の画素ごとの値を単精度で dir の data/ へ、符号つきでない画像を dir へ書く。mean は meanChainOf、run は
// passChainOf の出力(null なら書かない)、planes はその C_0 の画素ごとの量(chainPlanesOf)、mask は走査(width × height)の
// 測る画素の印。
function writeCandidate(dir, key, label, { mean, run, planes, mask, width, height }) {
  const write = (kind, values) => writeFloats(path.join(dir, 'data', `${key}.${label}.${kind}.f32`), Float32Array.from(values));
  write('mean-chain.c0', mean.c0);
  for (const { level, values } of mean.levels) write(`mean-chain.level${level}.band${level}`, values);
  if (mean.display !== null) {
    write('display', mean.display);
    writeFileSync(path.join(dir, `${key}.${label}.display.png`), encodeRgbPng(WIDTH, HEIGHT, srgbCodesOfLinear(mean.display)));
  }
  if (run === null) return;
  for (const [kind, values] of Object.entries({
    mean: run.c0.mean, variance: run.c0.variance, even: run.c0.halves[0], odd: run.c0.halves[1],
  })) write(`c0.${kind}`, values);
  if (run.frame !== null) {
    write('frame.c0', run.frame.c0);
    write('frame.correction', run.frame.correction);
  }
  for (const [kind, colorOf] of Object.entries(chainColorsOf(planes))) {
    writeFileSync(path.join(dir, `${key}.${label}.${kind}.png`), scanPngOf(width, height, mask, colorOf));
  }
}

// 撮影 key の符号つきの画像 <撮影>.<候補>.<種類>.x<g>.png を dir へ書く。shot は rechainShot の出力、gain は補正項の係数。
// 補正項は mean-chain-c0(平均の鎖の C_0)・level<m>(段 m の帯 m)・frame-c0・frame-correction、差分の dev(平均の鎖の C_0 −
// 流し込んだ帯の和)の係数は DIFFERENCE_GAIN。
function writeSignedImages(dir, key, { record, mask, fullMask, images }, gain) {
  const write = (label, kind, kindGain, width, height, imageMask, values) => writeFileSync(
    path.join(dir, `${key}.${label}.${kind}.x${kindGain}.png`),
    scanPngOf(width, height, imageMask, signedColorOf(values, kindGain)));
  for (const [label, { mean, run, deviation }] of Object.entries(images)) {
    const { width, height } = record;
    write(label, 'mean-chain-c0', gain, width, height, mask, mean.c0);
    write(label, 'dev', DIFFERENCE_GAIN, width, height, mask, deviation);
    for (const level of mean.levels) {
      write(label, `level${level.level}`, gain, level.width, level.height, new Uint8Array(level.width * level.height).fill(1),
        level.values);
    }
    if (run === null || run.frame === null) continue;
    write(label, 'frame-c0', gain, width, height, mask, run.frame.c0);
    write(label, 'frame-correction', gain, WIDTH, HEIGHT, fullMask, run.frame.correction);
  }
}

// ---- 表 ----

// 記録 record の表と、保存したものの説明。
function reportOf({ head, source, banded, candidates, displaySeeds, keptPasses, framePass, signedGain, entries, shots }) {
  const labels = candidates.map((c) => c.label);
  const perShot = entries.flatMap((key) => {
    const { width, height, meanRms, candidates: rows } = shots[key];
    const chains = Object.fromEntries(labels.map((label) => [label, rows[label].chain]));
    return [
      '', `### ${key}(走査 ${width}×${height}、帯の和の μ の RMS ${fixed(meanRms, 5)})`, '',
      ...table(['候補', '平均の鎖の RMS(d) / RMS(μ)', '所要 [s]'],
        labels.map((label) => [label, fixed(rows[label].deviationRatio, 5), fixed(rows[label].seconds, 1)])),
      ...(keptPasses === 0 ? [] : chainTableOf(labels, chains)),
    ];
  });
  return [
    '# 近傍拡散補正の鎖のやり直し', '',
    `HEAD ${head}、帯は \`${source}/\` の ${banded}(帯の全パスの平均と、残した先頭 ${keptPasses} パス)。`,
    `表示は走査を描かずに seed を ${displaySeeds} 回回した HDR の平均(0 なら作らない)。1 パスの絵は残したパス ${framePass}。`,
    'd は C_0 − 流し込んだ帯の和(帯を 1 つだけ残した候補では、その帯)。比の分母は帯の和の μ の RMS(どの候補でも同じ)。',
    '平均の鎖は帯の全パスの平均を流し込んだもので、鎖が線形なので鎖の出力の平均と丸めの範囲で一致する。下の C_0 の表は残した',
    'パスから(帯の撮影の表と同じ読み方。μ_A は帯の和)。',
    ...CHAIN_NOTES,
    '', ...candidates.map((c) => `- ${c.label}: \`${JSON.stringify(c.tier)}\`${c.isolatedBand === null ? '' : `、帯 ${c.isolatedBand} だけ`}`),
    '', '## 撮影ごと', ...perShot,
    '', '## 保存したもの', '',
    '- `data/<撮影>.<候補>.mean-chain.c0.f32` と `mean-chain.level<m>.band<m>.f32` — 平均の鎖の C_0 と段 m の帯 m(q。単精度で、',
    '  走査か段の解像度の画素ごとに rgb、行は上から。段の寸法は record.json の shots.<撮影>.candidates.<候補>.levels)。',
    `- \`data/<撮影>.<候補>.display.f32\` と \`display.png\` — 表示(線形 sRGB、${WIDTH}×${HEIGHT} の画素ごとに rgb)。`,
    '- `data/<撮影>.<候補>.c0.{mean,variance,even,odd}.f32` — 残したパスの鎖の C_0 の統計。`frame.c0.f32`・`frame.correction.f32`',
    `  — 残したパス ${framePass} の、その seed で描いた C_0 と描画バッファの解像度の補正(q)。`,
    `- 符号つきの画像 \`<撮影>.<候補>.<種類>.x<g>.png\` — 成分ごとに 0.5 + g·v。補正項(mean-chain-c0・level<m>・frame-c0・`,
    `  frame-correction)は g = ${signedGain}(帯の和の平均の全撮影の測る画素から variance と同じ決め方)、差分の dev は`,
    `  g = ${DIFFERENCE_GAIN}。段の画像は印を付けない。印の外は濃い青。`,
    ...CHAIN_IMAGE_NOTES, '',
  ].join('\n');
}
