// 手順8-15の κ の候補について、成分ごとの平均の帯(Σ|値| で重みを付けた帯番号)を測り、基準(κ = 0.75。--baseline-scale で変える)と
// 平均の帯が揃う κ を成分ごとに求める。--target を渡すと、基準はその場で測らず過去の出力の基準の行の値を使う
// (固定の因子 d を入れる前に測った、距離だけの帯座標)。照り返し = 「照り返しあり − 遮蔽のみ」の収束した帯、遮蔽 = 「遮蔽のみ」の収束した帯。
// 使い方: node tools/render-lab-screen-space-band-balance.mjs [--scales=0.5,0.6,0.75] [--target=<過去の band-balance の label>]
//   [--baseline-scale=<κ>](基準を測る κ。省くと 0.75) [--passes=128] [--scene=<name>] [--label=<出力名>]
// 1 つの Chrome で全ケースを測る。κ の切り替えは setTier だけ。
// 揃う κ は、候補の平均の帯が基準の値をまたぐ隣り合う 2 点の間を、κ の対数について線形補間して出す(またがなければ null)。
// 角度ケースは遮蔽が 0 なので遮蔽の欄を省く。出力は OUTPUT/band-balance/<label>.json と .md(label の既定は latest)。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bandStatsOf, BAND_COUNT } from './screen-space-chain-bands.mjs';
import { OUTPUT } from './screen-space-chain-runs.mjs';
import { SCENES, tierOf } from './screen-space-chain-setup.mjs';
import { fixed, table, unpackedBand, withLab } from './screen-space-lab.mjs';

const BASELINE_KAPPA = 0.75;
const argumentOf = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const listOf = (name, fallback) => (argumentOf(name) ?? fallback).split(',').map(Number);
for (const removed of ['factors', 'bounce-scales', 'occlusion-scales']) {
  if (argumentOf(removed) !== undefined) throw new Error(`--${removed}: 8-15 で因子の切り替えと成分ごとの κ を閉じた(κ は --scales の 1 つ)`);
}
const scales = listOf('scales', String(BASELINE_KAPPA));
if (scales.some((kappa) => !(kappa > 0))) throw new Error('κ list must be positive numbers');
const PASSES = Number(argumentOf('passes') ?? 128);
const LABEL = argumentOf('label') ?? 'latest';
if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(LABEL)) throw new Error('--label must be a safe lowercase label');
const TARGET = argumentOf('target');
if (TARGET !== undefined && !/^[a-z0-9][a-z0-9-]{0,47}$/.test(TARGET)) throw new Error('--target must be a safe lowercase label');
const scenes = argumentOf('scene') === undefined ? SCENES : SCENES.filter(({ name }) => name === argumentOf('scene'));
if (scenes.length === 0) throw new Error(`unknown scene: ${argumentOf('scene')}`);

// 測る組。baseline は基準の κ、candidates は --scales の κ。
const baselineScale = Number(argumentOf('baseline-scale') ?? BASELINE_KAPPA);
if (!(baselineScale > 0)) throw new Error('baseline κ must be a positive number');
const candidateTiers = scales.map(tierOf);
const allTiers = TARGET === undefined ? [tierOf(baselineScale), ...candidateTiers] : candidateTiers;

// いまの tier で PASSES パスの白色雑音を平均した、帯ごとの画素ごとの RGB(Float32Array × 帯数)。
async function meanBands(lab, tier) {
  await lab.setTier(tier);
  await lab.render();
  await lab.accumulateWhitePasses(0, PASSES);
  const { sums: [even, odd] } = await lab.takePassSums(false);
  const mean = even.map((image, texture) => Float32Array.from(image, (value, i) => (value + odd[texture][i]) / PASSES));
  return Array.from({ length: BAND_COUNT }, (_, band) => unpackedBand(mean, band));
}

const summaryOf = (bands) => {
  const { bands: stats, meanBandNumber } = bandStatsOf(bands);
  return { sumAbs: stats.map(({ sumAbs }) => sumAbs), meanBand: meanBandNumber };
};
const minus = (bands, other) => bands.map((band, b) => Float32Array.from(band, (value, i) => value - other[b][i]));

// ケース scene を測り、組ごとの { tier, bounce, occlusion }(occlusion は遮蔽が無いケースで null)を返す。
async function measureScene(lab, scene) {
  const hasOcclusion = scene.hasOcclusionOnly !== false;
  const occlusionOnly = new Map();
  if (hasOcclusion) {
    await lab.show({ caseName: scene.caseName, shot: scene.shot, mode: 1, set: 'tuning', key: scene.name });
    await lab.setUpsampleAlphaOne(false);
    for (const tier of allTiers) occlusionOnly.set(tier.bandScale, await meanBands(lab, tier));
  }
  await lab.show({ caseName: scene.caseName, shot: scene.shot, mode: 2, set: 'tuning', key: scene.name });
  await lab.setUpsampleAlphaOne(false);
  const rows = [];
  for (const tier of allTiers) {
    const withBounce = await meanBands(lab, tier);
    const occlusion = occlusionOnly.get(tier.bandScale);
    rows.push({ tier, kappa: tier.bandScale,
      bounce: summaryOf(hasOcclusion ? minus(withBounce, occlusion) : withBounce),
      occlusion: hasOcclusion ? summaryOf(occlusion) : null });
  }
  return rows;
}

// 点 points([{ kappa, meanBand }])を κ の昇順に並べ、meanBand が target をまたぐ最初の隣り合う 2 点を κ の対数で線形補間した κ。
// またがなければ null。
function matchedKappa(points, target) {
  const sorted = [...points].sort((a, b) => a.kappa - b.kappa);
  for (let i = 0; i + 1 < sorted.length; i++) {
    const [p, q] = [sorted[i], sorted[i + 1]];
    if ((p.meanBand - target) * (q.meanBand - target) > 0 || p.meanBand === q.meanBand) continue;
    const t = (target - p.meanBand) / (q.meanBand - p.meanBand);
    return Math.exp(Math.log(p.kappa) + t * (Math.log(q.kappa) - Math.log(p.kappa)));
  }
  return null;
}

// 候補の行 rows と基準の行 baseline から、基準と平均の帯が揃う κ(成分ごと)。
function matchesOf(rows, baseline) {
  const candidates = rows.filter((row) => row !== baseline);
  const matchOf = (component) => baseline[component] === null ? null : matchedKappa(
    candidates.map((row) => ({ kappa: row.kappa, meanBand: row[component].meanBand })), baseline[component].meanBand);
  return { bounce: matchOf('bounce'), occlusion: matchOf('occlusion') };
}

function markdownOf(results) {
  const lines = [`# 成分ごとの平均の帯(${PASSES}パス平均)`, ''];
  for (const { scene, rows, matches } of results) {
    const hasOcclusion = rows[0].occlusion !== null;
    const header = ['κ', '照り返し 平均の帯', ...(hasOcclusion ? ['遮蔽 平均の帯'] : []), '照り返し Σ|値| (帯0〜3)'];
    const body = rows.map((row) => [fixed(row.kappa, 3), fixed(row.bounce.meanBand, 3),
      ...(hasOcclusion ? [fixed(row.occlusion.meanBand, 3)] : []), row.bounce.sumAbs.map((v) => fixed(v, 1)).join(' / ')]);
    lines.push(`## ${scene}`, '', ...table(header, body), '',
      `基準と揃う照り返しの κ: ${matches.bounce === null ? '—' : fixed(matches.bounce, 3)}`,
      ...(hasOcclusion ? [`基準と揃う遮蔽の κ: ${matches.occlusion === null ? '—' : fixed(matches.occlusion, 3)}`] : []), '');
  }
  return lines.join('\n');
}

// --target の出力の、ケース scene の基準の行(測った最初の行)の平均の帯。
function targetBaselineOf(scene) {
  const file = path.join(OUTPUT, 'band-balance', `${TARGET}.json`);
  const row = JSON.parse(readFileSync(file, 'utf8')).results.find((result) => result.scene === scene)?.rows[0];
  if (row === undefined) throw new Error(`--target ${TARGET}: no row for ${scene}`);
  return row;
}

const results = [];
await withLab(async (lab) => {
  for (const scene of scenes) {
    const rows = await measureScene(lab, scene);
    const matches = matchesOf(rows, TARGET === undefined ? rows[0] : targetBaselineOf(scene.name));
    results.push({ scene: scene.name, rows, matches });
    console.log(`${scene.name}: measured ${rows.length} settings`);
  }
});
const directory = path.join(OUTPUT, 'band-balance');
mkdirSync(directory, { recursive: true });
writeFileSync(path.join(directory, `${LABEL}.json`), JSON.stringify({ passes: PASSES, scales,
  results }, null, 2));
writeFileSync(path.join(directory, `${LABEL}.md`), markdownOf(results));
console.log(markdownOf(results));
