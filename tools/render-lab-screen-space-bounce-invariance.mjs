// 走査の天体照の遮りの積分を書き換える前後で、照り返し(方式 2 の値 − 方式 1 の値)が変わらないことの確かめ。
// 中の段・seedOf(0〜3)の各 1 フレームの帯ごとの出力と最終の補正を、方式 1・2 で float のまま撮り、2 つの撮影の照り返しの差を
// 半精度の丸めの許容と比べて数える。
//   node tools/render-lab-screen-space-bounce-invariance.mjs capture <名前> [--planet-light-model <0|1>]  (先に render-lab を組むこと)
//   node tools/render-lab-screen-space-bounce-invariance.mjs compare <名前A> <名前B>
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { encodeRgbPng } from './png.mjs';
import {
  headHash, packedBandsNamesOf, readFloats, seedOf, shotsDir, table, TIERS, WIDTH, withLab, writeFloats,
} from './screen-space-lab.mjs';

const outDir = path.join(shotsDir, 'ssd-8.5', 'bounce-invariance');
const SHOTS = [
  { shot: 'bay', caseName: 'bay' }, { shot: 'bay-earth-open', caseName: 'bay' },
  { shot: 'bay-earth-overhead', caseName: 'bay' }, { shot: 'bay-moon-open', caseName: 'bay' },
  { shot: 'cornell-box', caseName: 'cornell-box' },
];
// 描画設定 screenSpaceDiffuse の値。遮蔽と、遮蔽と照り返し。
const OCCLUSION = 1;
const INDIRECT = 2;
const SEED_COUNT = 4;
const TIER = TIERS.medium;
const PACKED_TARGETS = packedBandsNamesOf(TIER.bandCount);
const TARGETS = [...PACKED_TARGETS, 'correction'];
// 走査が直接書く段は半精度の書き込み 1 回。補正は走査 → 縮小 3 → 合流 3 → 最後の拡大と、半精度の描画先を 8 回通る
// (screen-space-pass.ts の createChainStages と createUpsampleStage)。
const CORRECTION_ROUNDINGS = 8;
const HALF_EPSILON = 2 ** -11;
const HALF_SUBNORMAL_STEP = 4 * 2 ** -25;

const fileOf = (name, { shot, mode, seed, target }) => path.join(outDir, name, `${shot}.m${mode}.s${seed}.${target}.f32`);

const { positionals: [command, ...names], values: options } = parseArgs({
  allowPositionals: true, options: { 'planet-light-model': { type: 'string' } },
});
// 撮影の描画設定 planetLightModel を差し替える値。null なら撮影の描画設定のまま撮る。
const planetLightModelArgument = options['planet-light-model'] === undefined ? null : Number(options['planet-light-model']);

async function capture(name) {
  const started = Date.now();
  mkdirSync(path.join(outDir, name), { recursive: true });
  const jobs = SHOTS.flatMap((s) => [OCCLUSION, INDIRECT].map((mode) => ({ ...s, mode })));
  const isDone = (job, seed) => TARGETS.every((target) => existsSync(fileOf(name, { ...job, seed, target })));
  const pendingJobs = jobs.filter((job) => Array.from({ length: SEED_COUNT }, (_, seed) => seed).some((seed) => !isDone(job, seed)));
  let succeeded = false;
  try {
    await withLab(async (lab) => {
      for (const job of pendingJobs) {
        await lab.show({ caseName: job.caseName, shot: job.shot, mode: job.mode, dolly: 0, key: job.shot });
        if (planetLightModelArgument !== null) await lab.setGraphicsOption('planetLightModel', planetLightModelArgument);
        await lab.setTier(TIER);
        for (let seed = 0; seed < SEED_COUNT; seed++) {
          if (isDone(job, seed)) continue;
          await lab.setSeed(seedOf(seed));
          const { images } = await lab.readSettled(TARGETS);
          for (const [i, target] of TARGETS.entries()) writeFloats(fileOf(name, { ...job, seed, target }), images[i].rgba);
          console.log(`${job.shot} mode ${job.mode} seed ${seed}`);
        }
      }
      succeeded = true;
    });
  } catch (error) {
    if (error?.code !== 'EPERM' || !succeeded) throw error;
    console.warn('captured; Chrome temp profile cleanup returned EPERM');
  }
  const seconds = (Date.now() - started) / 1000;
  writeFileSync(path.join(outDir, name, 'meta.json'),
    JSON.stringify({ head: headHash(), tier: TIER, seedCount: SEED_COUNT, secondsOfLastCall: seconds }, null, 1));
  console.log(`${name}: ${seconds.toFixed(0)} s, HEAD ${headHash()}`);
}

// 撮影 a と b の job(撮影・seed・ターゲット)の、照り返しの差の超過画素の印を許容の k 倍で引く関数と、差の大きさの指標。
function compareOne(a, b, job) {
  const read = (name, mode) => readFloats(fileOf(name, { ...job, mode }));
  const [a1, a2, b1, b2] = [read(a, OCCLUSION), read(a, INDIRECT), read(b, OCCLUSION), read(b, INDIRECT)];
  const length = a1.length;
  const difference = new Float64Array(length);
  const tolerance = new Float64Array(length);
  let squareD = 0, squareR = 0, maxD = 0;
  for (let i = 0; i < length; i++) {
    const rA = a2[i] - a1[i];
    difference[i] = (b2[i] - b1[i]) - rA;
    tolerance[i] = HALF_EPSILON * (Math.abs(a2[i]) + Math.abs(a1[i]) + Math.abs(b2[i]) + Math.abs(b1[i])) + HALF_SUBNORMAL_STEP;
    squareD += difference[i] ** 2;
    squareR += rA ** 2;
    maxD = Math.max(maxD, Math.abs(difference[i]));
  }
  const exceeding = (k) => Uint8Array.from({ length: length / 4 }, (_, p) =>
    [0, 1, 2, 3].some((c) => Math.abs(difference[4 * p + c]) > k * tolerance[4 * p + c]) ? 1 : 0);
  return { exceeding, maxD, rmsD: Math.sqrt(squareD / length), rmsR: Math.sqrt(squareR / length) };
}

function compare(a, b) {
  const mapDir = path.join(outDir, `compare-${a}-${b}`);
  mkdirSync(mapDir, { recursive: true });
  const rows = [];
  for (const job of SHOTS) {
    for (let seed = 0; seed < SEED_COUNT; seed++) {
      for (const target of TARGETS) {
        const isCorrection = target === 'correction';
        const { exceeding, maxD, rmsD, rmsR } = compareOne(a, b, { ...job, seed, target });
        const count = (k) => exceeding(k).reduce((sum, v) => sum + v, 0);
        const ks = isCorrection ? [1, CORRECTION_ROUNDINGS, 2 * CORRECTION_ROUNDINGS] : [1];
        const counts = ks.map(count);
        rows.push([job.shot, seed, target, ...Array.from({ length: 3 }, (_, i) => counts[i] ?? '—'),
          maxD.toExponential(2), rmsD.toExponential(2), rmsR.toExponential(2)]);
        const mask = exceeding(ks.length === 1 ? 1 : CORRECTION_ROUNDINGS);
        const width = isCorrection ? WIDTH : Math.round(WIDTH * TIER.scale);
        const rgb = new Uint8Array(mask.length * 3).fill(0);
        for (const [p, v] of mask.entries()) rgb.fill(v * 255, 3 * p, 3 * p + 3);
        writeFileSync(path.join(mapDir, `${job.shot}.s${seed}.${target}.png`), encodeRgbPng(width, mask.length / width, rgb));
      }
    }
  }
  const lines = [
    `# 照り返し r = (方式 2) − (方式 1) の差 d = r_${b} − r_${a}`, '',
    `許容は tol₁ = 2⁻¹¹ × (4 つの値の絶対値の和) + 4 × 2⁻²⁵、k 段ぶんは k·tol₁。超過画素はどれかの RGBA 成分が超えた画素。`
    + `packed-bands-* は k = 1(半精度の書き込み 1 回)、correction は k = 1・${CORRECTION_ROUNDINGS}・${2 * CORRECTION_ROUNDINGS}。`
    + `max・RMS は全成分の |d|、rmsR は |r_${a}| の RMS。地図は packed が k = 1、correction が k = ${CORRECTION_ROUNDINGS} の超過画素。`, '',
    ...table(['撮影', 'seed', 'ターゲット', '超過 k=1', `超過 k=${CORRECTION_ROUNDINGS}`, `超過 k=${2 * CORRECTION_ROUNDINGS}`,
      'max｜d｜', 'RMS d', `RMS r_${a}`], rows), '',
  ];
  writeFileSync(path.join(outDir, `compare-${a}-${b}.md`), lines.join('\n'));
  console.log(lines.join('\n'));
}

if (command === 'capture' && names.length === 1) await capture(names[0]);
else if (command === 'compare' && names.length === 2) compare(...names);
else throw new Error('usage: capture <名前> [--planet-light-model <0|1>] | compare <名前A> <名前B>');
