// 近傍拡散補正の走査の帯の撮影。候補の段 1 つで、撮影ごとに (1) 帯の収束先 — 走査のずれをホワイトノイズから引いたパスを
// ページの GPU で偶数番目と奇数番目に分けて積んだ、帯ごとと帯の和の平均・偶数番目と奇数番目の平均と、帯ごとの 1 パスの
// 分散 — と、(2) 本番のブルーノイズの先頭のパスの帯の値(半精度のまま)とその C_0 の統計を、.render-lab-shots/ssd-bands/
// <出力先>/ へ書く。鎖のやり直し(rechain)が読む。撮影ごとに書くので、落ちても撮り終えた撮影を飛ばして続きから撮れる。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  fixed, headHash, maskedMeanOf, packedBandsNamesOf, seedOf, selectedEntries, shotsDir, table, TIERS, unpackedBand,
  withLab, writeFloats,
} from './screen-space-lab.mjs';
import { BLOCKS, keptPassesFileOf, scanMaskOf, statisticsOf, unbiasedVarianceOf } from './screen-space-scan.mjs';

const USAGE = 'usage: bands [<candidate.json>] [--entries <key,...>] [--sets <set,...>] [--passes <N>] [--keep-passes <K>] '
  + '[--out <名前>]';
// 既定の候補(本番の中の段)とパスの数。
const DEFAULT_CANDIDATE = { label: 'L4', tier: TIERS.medium };
const DEFAULT_PASSES = 50 * 1024;
const DEFAULT_KEPT_PASSES = 64;
// ページの GPU の和を読み戻して倍精度へ足す間隔 [パス]。float32 の和の丸めの誤差をこの項数に抑える。
const PASSES_PER_TAKE = 1024;

// 撮影ごとに帯を撮り、撮影ごとの記録と、全体の記録と表を書く。<candidate.json> は { label, tier }(既定は DEFAULT_CANDIDATE)、
// --passes はホワイトノイズのパスの数(偶数)、--keep-passes は残すブルーノイズのパスの数(BLOCKS の倍数、0 で残さない)。
export async function bands({ positional, options }) {
  const candidate = positional[0] === undefined ? DEFAULT_CANDIDATE : JSON.parse(readFileSync(positional[0], 'utf8'));
  const passes = Number(options.passes ?? DEFAULT_PASSES);
  const keptPasses = Number(options['keep-passes'] ?? DEFAULT_KEPT_PASSES);
  if (!Number.isInteger(passes) || passes < 2 || passes % 2 !== 0) throw new Error(`--passes must be even\n${USAGE}`);
  if (!Number.isInteger(keptPasses) || keptPasses % BLOCKS !== 0) {
    throw new Error(`--keep-passes must be a multiple of ${BLOCKS}\n${USAGE}`);
  }
  const entries = selectedEntries(options.entries === undefined && options.sets === undefined ? { sets: 'tuning' } : options);
  const outDir = path.join(shotsDir, 'ssd-bands', options.out ?? headHash());
  mkdirSync(path.join(outDir, 'data'), { recursive: true });
  const settings = { candidate, passes, keptPasses };
  const pending = entries.filter((entry) => !isCaptured(outDir, entry.key, settings));
  console.log(`撮る撮影 ${pending.length} / ${entries.length}(撮り終えた ${entries.length - pending.length} を飛ばす)`);
  if (pending.length > 0) {
    await withLab(async (lab) => {
      for (const entry of pending) {
        const shot = await captureShot(lab, outDir, entry, settings);
        writeFileSync(shotRecordFileOf(outDir, entry.key), JSON.stringify({ ...settings, ...shot }, null, 1));
      }
    });
  }
  const shots = Object.fromEntries(entries.filter((entry) => isCaptured(outDir, entry.key, settings)).map((entry) => {
    const { width, height, exposure, measured, sumRms, floorRatio, passSeconds, keptSeconds, seconds } = JSON.parse(
      readFileSync(shotRecordFileOf(outDir, entry.key), 'utf8'));
    return [entry.key, { width, height, exposure, measured, sumRms, floorRatio, passSeconds, keptSeconds, seconds }];
  }));
  const record = { head: headHash(), passes, keptPasses, candidates: [candidate], entries: Object.keys(shots), shots };
  writeFileSync(path.join(outDir, 'record.json'), JSON.stringify(record, null, 1));
  const report = reportOf(record);
  writeFileSync(path.join(outDir, 'report.md'), report);
  console.log(`\n${report}`);
}

// 撮影 key の記録の置き場。
const shotRecordFileOf = (dir, key) => path.join(dir, 'data', `${key}.json`);

// 撮影 key を、同じ候補とパスの数 settings で撮り終えているか。
function isCaptured(dir, key, settings) {
  const file = shotRecordFileOf(dir, key);
  if (!existsSync(file)) return false;
  const shot = JSON.parse(readFileSync(file, 'utf8'));
  return JSON.stringify(shot.candidate) === JSON.stringify(settings.candidate) && shot.passes === settings.passes
    && shot.keptPasses === settings.keptPasses;
}

// ---- 撮影 ----

// 撮影 entry の帯を撮り、画素ごとの値を dir の data/ へ書いて、撮影の記録 { width, height, exposure, measured, sumRms,
// floorRatio, passSeconds, keptSeconds, seconds } を返す。measured は測る画素の数、sumRms は帯の和の平均の RMS(q)、
// floorRatio は帯の和の偶数番目と奇数番目の平均の差の半分の RMS の sumRms に対する比(収束先の雑音)、passSeconds は
// ホワイトノイズの 1 パスの所要、keptSeconds は残すパスを撮った所要。lab は withLab の口。
async function captureShot(lab, dir, entry, { candidate, passes, keptPasses }) {
  const started = Date.now();
  const { label, tier } = candidate;
  await lab.show(entry);
  await lab.setTier(tier);
  await lab.setSeed(seedOf(0));
  await lab.capturePng();
  const radius = await lab.readFloat('projected-radius', 1);
  const exposure = await lab.exposureFactor();
  writeFloats(path.join(dir, 'data', `${entry.key}.radius.f32`), radius);
  // ΔE から q(露出係数·ΔE/π)への係数。
  const scale = exposure / Math.PI;
  const whiteStarted = Date.now();
  const { sums, squares } = await whitePassSumsOf(lab, passes);
  const passSeconds = (Date.now() - whiteStarted) / 1000 / passes;
  const [width, height] = await lab.floatSizeOf('packed-bands-0');
  const write = (kind, values) => writeFloats(path.join(dir, 'data', `${entry.key}.${label}.${kind}.f32`), Float32Array.from(values));
  // 帯ごとの偶数番目・奇数番目の平均(q)。
  const bandHalves = Array.from({ length: tier.bandCount }, (_, band) => sums.map(
    (packed) => unpackedBand(packed, band).map((v) => scale * v / (passes / 2))));
  const sumHalves = [0, 1].map((h) => bandHalves[0][h].map((_, i) => bandHalves.reduce((sum, b) => sum + b[h][i], 0)));
  for (const [name, [even, odd]] of [...bandHalves.map((b, band) => [`band${band}`, b]), ['sum', sumHalves]]) {
    write(`${name}.mean`, even.map((v, i) => (v + odd[i]) / 2));
    write(`${name}.even`, even);
    write(`${name}.odd`, odd);
  }
  // 帯ごとの、1 パスの値の画素ごとの不偏分散(q²)。
  for (let band = 0; band < tier.bandCount; band++) {
    const [sum, square] = [sums, squares].map((halves) => {
      const [even, odd] = halves.map((packed) => unpackedBand(packed, band));
      return even.map((v, i) => v + odd[i]);
    });
    write(`band${band}.variance`, sum.map((s, i) => scale * scale * unbiasedVarianceOf(s, square[i], passes)));
  }
  const keptStarted = Date.now();
  if (keptPasses > 0) await captureKeptPasses(lab, dir, entry.key, candidate, keptPasses, scale);
  const keptSeconds = (Date.now() - keptStarted) / 1000;
  const mask = scanMaskOf(radius, tier.scale, width, height);
  const sumRms = Math.sqrt(maskedMeanOf(sumHalves[0].map((v, i) => ((v + sumHalves[1][i]) / 2) ** 2), mask));
  const floorRms = Math.sqrt(maskedMeanOf(sumHalves[0].map((v, i) => ((v - sumHalves[1][i]) / 2) ** 2), mask));
  const seconds = (Date.now() - started) / 1000;
  console.log(`${entry.key}: ホワイトノイズ ${passes} パス ${(passSeconds * 1000).toFixed(2)} ms/パス、`
    + `残すパス ${keptSeconds.toFixed(0)} s、計 ${seconds.toFixed(0)} s、床 / RMS ${floorRms / sumRms}`);
  return {
    width, height, exposure, measured: mask.reduce((count, m) => count + m, 0), sumRms, floorRatio: floorRms / sumRms,
    passSeconds, keptSeconds, seconds,
  };
}

// 表示中の撮影の、ホワイトノイズのパス 0〜passes − 1 の、帯を詰めたテクスチャの値の和 sums と成分ごとの二乗の和 squares。
// どちらも [偶数番目, 奇数番目] の、テクスチャごとに画素ごとの RGBA の(ΔE の)和の Float64Array。
async function whitePassSumsOf(lab, passes) {
  const zerosOf = (halves) => halves.map((textures) => textures.map((values) => new Float64Array(values.length)));
  let totals = null;
  for (let first = 0; first < passes; first += PASSES_PER_TAKE) {
    await lab.accumulateWhitePasses(first, Math.min(PASSES_PER_TAKE, passes - first));
    const taken = await lab.takePassSums();
    totals ??= { sums: zerosOf(taken.sums), squares: zerosOf(taken.squares) };
    for (const kind of ['sums', 'squares']) {
      for (const [h, textures] of taken[kind].entries()) {
        for (const [i, values] of textures.entries()) values.forEach((v, j) => { totals[kind][h][i][j] += v; });
      }
    }
  }
  return totals;
}

// 表示中の撮影 key を、候補 candidate の段のブルーノイズのパス 0〜count − 1 で撮り、帯を詰めたテクスチャの値を半精度のまま
// (keptPassesFileOf)、そのパスの C_0 の q の統計(係数 scale)を kept-c0.{mean,variance,even,odd} として dir の data/ へ書く。
async function captureKeptPasses(lab, dir, key, candidate, count, scale) {
  const names = packedBandsNamesOf(candidate.tier.bandCount);
  const kept = names.map(() => []);
  let slots = null;
  for (let k = 0; k < count; k++) {
    await lab.setSeed(seedOf(k));
    await lab.render();
    for (const [i, name] of names.entries()) kept[i].push(Float16Array.from(await lab.readFloat(name, 4)));
    const c0 = await lab.readFloat('scan-correction', 3);
    slots ??= Array.from({ length: BLOCKS }, () => ({
      sum: new Float64Array(c0.length), squareSum: new Float64Array(c0.length),
    }));
    const slot = slots[k % BLOCKS];
    c0.forEach((v, i) => {
      slot.sum[i] += v;
      slot.squareSum[i] += v * v;
    });
  }
  for (const [i, passes] of kept.entries()) {
    const values = new Float16Array(passes.length * passes[0].length);
    for (const [k, pass] of passes.entries()) values.set(pass, k * pass.length);
    writeFloats(keptPassesFileOf(dir, key, candidate.label, i), values);
  }
  const { mean, variance, halves: [even, odd] } = statisticsOf(slots, scale, count);
  for (const [kind, values] of Object.entries({ mean, variance, even, odd })) {
    writeFloats(path.join(dir, 'data', `${key}.${candidate.label}.kept-c0.${kind}.f32`), Float32Array.from(values));
  }
}

// ---- 表 ----

// 記録 record の表と、保存したものの説明。
function reportOf({ head, passes, keptPasses, candidates: [candidate], entries, shots }) {
  return [
    '# 近傍拡散補正の走査の帯の撮影', '',
    `HEAD ${head}、候補 ${candidate.label} \`${JSON.stringify(candidate.tier)}\`。帯の収束先はホワイトノイズの ${passes} パス`,
    `(走査の 3 つのずれを画素・パス・成分ごとに独立な一様な値から引く)、残すパスは本番のブルーノイズの seedOf(0〜${keptPasses - 1})。`,
    '床 / RMS は帯の和の偶数番目と奇数番目のパスの平均の差の半分の RMS の、帯の和の平均の RMS に対する比(測る画素で、q で)。',
    '', ...table(['撮影', '走査', '帯の和の RMS', '床 / RMS', 'ホワイトノイズ [ms/パス]', '残すパス [s]', '計 [s]'],
      entries.map((key) => {
        const shot = shots[key];
        return [
          key, `${shot.width}×${shot.height}`, fixed(shot.sumRms, 5), fixed(shot.floorRatio, 5), fixed(1000 * shot.passSeconds, 2),
          fixed(shot.keptSeconds, 0), fixed(shot.seconds, 0),
        ];
      })),
    '', '## 保存したもの', '',
    '- `data/<撮影>.<候補>.{band<ℓ>,sum}.{mean,even,odd}.f32` — 帯 ℓ と帯の和の q の、ホワイトノイズの全パスの平均と偶数番目・',
    '  奇数番目のパスの平均。単精度で、走査の解像度の画素ごとに rgb、行は上から。',
    '- `data/<撮影>.<候補>.band<ℓ>.variance.f32` — 帯 ℓ の、ホワイトノイズの 1 パスの値の画素ごとの不偏分散(q²)。並びは',
    '  mean と同じ。帯の和の分散は帯どうしの共分散が要るので出さない。',
    `- \`data/<撮影>.<候補>.packed<i>.passes.f16\` — 先頭 ${keptPasses} パス(ブルーノイズ)の、走査が帯を詰めた描画先の i 枚目の`,
    '  値(ΔE)。パスの順に、走査の解像度の画素ごとに RGBA を半精度で並べたもの(帯 b の成分 c は通しのチャンネル 3b + c)。',
    '- `data/<撮影>.<候補>.kept-c0.{mean,variance,even,odd}.f32` — その残したパスの C_0 の q の統計。',
    `- \`data/<撮影>.radius.f32\` — 近傍の半径 [絵の画素]。\`data/<撮影>.json\` — 撮影の記録(撮り終えた印)。`,
    '',
  ].join('\n');
}
