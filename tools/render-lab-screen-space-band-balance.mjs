// 手順8-15の因子の組と κ の候補について、成分ごとの平均の帯(Σ|値| で重みを付けた帯番号)を測り、基準(因子なし、
// κ_b = κ_o = 0.75)と平均の帯が揃う κ を求める。--target を渡すと、基準はその場で測らず過去の出力の基準の行の値を使う
// (固定の因子 d を入れる前に測った、距離だけの帯座標)。照り返し = 「照り返しあり − 遮蔽のみ」の収束した帯、遮蔽 = 「遮蔽のみ」の収束した帯。
// 使い方: node tools/render-lab-screen-space-band-balance.mjs [--factors=b.d=1,o.d=1] [--bounce-scales=0.5,0.6,0.75]
//   [--occlusion-scales=0.75] [--target=<過去の band-balance の label>] [--passes=128] [--scene=<name>] [--label=<出力名>]
// 1 つの Chrome で全ケースを測る。mode 1(遮蔽のみ)は κ_b に依らないので、同じ遮蔽の因子・κ_o なら使い回す。組の切り替えは setTier だけ。
// 揃う κ は、候補の平均の帯が基準の値をまたぐ隣り合う 2 点の間を、κ の対数について線形補間して出す(またがなければ null)。
// 角度ケースは遮蔽が 0 なので遮蔽の欄を省く。出力は OUTPUT/band-balance/<label>.json と .md(label の既定は latest)。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bandStatsOf, BAND_COUNT } from './screen-space-chain-bands.mjs';
import { factorsLabelOf, FIXED_FACTORS, parseFactors } from './screen-space-chain-factors.mjs';
import { OUTPUT } from './screen-space-chain-runs.mjs';
import { SCENES, tierOf } from './screen-space-chain-setup.mjs';
import { fixed, table, unpackedBand, withLab } from './screen-space-lab.mjs';

const BASELINE_KAPPA = 0.75;
const argumentOf = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const listOf = (name, fallback) => (argumentOf(name) ?? fallback).split(',').map(Number);
const bounceScales = listOf('bounce-scales', String(BASELINE_KAPPA));
const occlusionScales = listOf('occlusion-scales', String(BASELINE_KAPPA));
if ([...bounceScales, ...occlusionScales].some((kappa) => !(kappa > 0))) throw new Error('κ lists must be positive numbers');
const PASSES = Number(argumentOf('passes') ?? 128);
const LABEL = argumentOf('label') ?? 'latest';
if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(LABEL)) throw new Error('--label must be a safe lowercase label');
const factorsText = argumentOf('factors');
const TARGET = argumentOf('target');
if (TARGET !== undefined && !/^[a-z0-9][a-z0-9-]{0,47}$/.test(TARGET)) throw new Error('--target must be a safe lowercase label');
const scenes = argumentOf('scene') === undefined ? SCENES : SCENES.filter(({ name }) => name === argumentOf('scene'));
if (scenes.length === 0) throw new Error(`unknown scene: ${argumentOf('scene')}`);

// 測る組。baseline は因子なし(欄ごと無し)、candidates は κ_o × κ_b の全組(--factors を省くと因子の強さは全部 0)。
const baselineTier = tierOf(BASELINE_KAPPA);
const candidateTiers = occlusionScales.flatMap((ko) => bounceScales.map((kb) => tierOf(ko, { ...parseFactors(factorsText ?? 'kb=0', ko), bounceScale: kb })));
const allTiers = TARGET === undefined ? [baselineTier, ...candidateTiers] : candidateTiers;
// mode 1 の結果は、遮蔽の因子と κ_o が同じ組で共通。
const occlusionKeyOf = (tier) => JSON.stringify([tier.bandScale, tier.bandFactors?.occlusion ?? null]);

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
    for (const tier of allTiers) {
      if (!occlusionOnly.has(occlusionKeyOf(tier))) occlusionOnly.set(occlusionKeyOf(tier), await meanBands(lab, tier));
    }
  }
  await lab.show({ caseName: scene.caseName, shot: scene.shot, mode: 2, set: 'tuning', key: scene.name });
  await lab.setUpsampleAlphaOne(false);
  const rows = [];
  for (const tier of allTiers) {
    const withBounce = await meanBands(lab, tier);
    const occlusion = occlusionOnly.get(occlusionKeyOf(tier));
    rows.push({ tier, label: factorsLabelOf(tier, FIXED_FACTORS), kappaBounce: tier.bandFactors?.bounceScale ?? tier.bandScale, kappaOcclusion: tier.bandScale,
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

// 候補の行 rows と基準の行 baseline から、基準と平均の帯が揃う κ_b(κ_o ごと)と κ_o。
function matchesOf(rows, baseline) {
  const candidates = rows.filter((row) => row !== baseline);
  const kappaOcclusions = [...new Set(candidates.map((row) => row.kappaOcclusion))];
  const bounce = kappaOcclusions.map((ko) => ({ kappaOcclusion: ko, kappaBounce: matchedKappa(
    candidates.filter((row) => row.kappaOcclusion === ko).map((row) => ({ kappa: row.kappaBounce, meanBand: row.bounce.meanBand })),
    baseline.bounce.meanBand) }));
  const occlusionRows = [...new Map(candidates.filter((row) => row.occlusion !== null).map((row) => [row.kappaOcclusion, row])).values()];
  const occlusion = baseline.occlusion === null ? null : matchedKappa(
    occlusionRows.map((row) => ({ kappa: row.kappaOcclusion, meanBand: row.occlusion.meanBand })), baseline.occlusion.meanBand);
  return { bounce, occlusion };
}

function markdownOf(results) {
  const lines = [`# 成分ごとの平均の帯(${PASSES}パス平均)`, '', `因子: ${factorsText ?? '(なし)'}`, ''];
  for (const { scene, rows, matches } of results) {
    const hasOcclusion = rows[0].occlusion !== null;
    const header = ['組', 'κ_b', 'κ_o', '照り返し 平均の帯', ...(hasOcclusion ? ['遮蔽 平均の帯'] : []), '照り返し Σ|値| (帯0〜3)'];
    const body = rows.map((row) => [row.label, fixed(row.kappaBounce, 3), fixed(row.kappaOcclusion, 3), fixed(row.bounce.meanBand, 3),
      ...(hasOcclusion ? [fixed(row.occlusion.meanBand, 3)] : []), row.bounce.sumAbs.map((v) => fixed(v, 1)).join(' / ')]);
    lines.push(`## ${scene}`, '', ...table(header, body), '',
      `基準と揃う κ_b: ${matches.bounce.map(({ kappaOcclusion, kappaBounce }) => `κ_o=${kappaOcclusion} で ${fixed(kappaBounce, 3)}`).join('、') || '—'}`,
      ...(hasOcclusion ? [`基準と揃う κ_o: ${fixed(matches.occlusion, 3)}`] : []), '');
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
writeFileSync(path.join(directory, `${LABEL}.json`), JSON.stringify({ passes: PASSES, factors: factorsText ?? null, bounceScales, occlusionScales,
  results }, null, 2));
writeFileSync(path.join(directory, `${LABEL}.md`), markdownOf(results));
console.log(markdownOf(results));
