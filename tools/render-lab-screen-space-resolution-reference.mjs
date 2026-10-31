import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { encodeRgbPng } from './png.mjs';
import { CHUNK_PASSES, SCENES, tierOf } from './screen-space-chain-setup.mjs';
import { RUNS, SCAN_HEIGHT, SCAN_WIDTH } from './screen-space-chain-runs.mjs';
import { HEIGHT, unpackedBand, WIDTH, withLab, writeFloats } from './screen-space-lab.mjs';

const arg = (name) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const run = arg('run');
const scale = Number(arg('scan-scale'));
const passes = Number(arg('passes') ?? 1024);
const sceneName = arg('scene');
if (!run || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(run)) throw new Error('usage: node tools/render-lab-screen-space-resolution-reference.mjs --run=<label> --scan-scale=<0.5|1> [--passes=1024] [--scene=<name>]');
if (![0.5, 1].includes(scale)) throw new Error('--scan-scale must be 0.5 or 1');
if (!Number.isInteger(passes) || passes <= 0 || passes % CHUNK_PASSES !== 0) throw new Error(`--passes must be a positive multiple of ${CHUNK_PASSES}`);
const scenes = sceneName === undefined ? SCENES : SCENES.filter((scene) => scene.name === sceneName);
if (!scenes.length) throw new Error(`unknown scene: ${sceneName}`);
const factor = scale / 0.25;
if (!Number.isInteger(factor)) throw new Error('scan scale must be an integer multiple of 0.25');
const output = path.join(RUNS, run);
const shortHead = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();

// 走査の解像度の rgb(画素ごとに 3 成分)を、240×135 へ factor × factor の箱で縮めた RGBA。
function boxDownsample(rgb) {
  const width = SCAN_WIDTH * factor, height = SCAN_HEIGHT * factor;
  if (rgb.length !== width * height * 3) throw new Error(`unexpected resolution reference size: ${rgb.length}`);
  const out = new Float32Array(SCAN_WIDTH * SCAN_HEIGHT * 4);
  for (let y = 0; y < SCAN_HEIGHT; y++) for (let x = 0; x < SCAN_WIDTH; x++) {
    const to = (y * SCAN_WIDTH + x) * 4;
    for (let dy = 0; dy < factor; dy++) for (let dx = 0; dx < factor; dx++) {
      const from = ((y * factor + dy) * width + x * factor + dx) * 3;
      for (let c = 0; c < 3; c++) out[to + c] += rgb[from + c] / (factor * factor);
    }
    out[to + 3] = 1;
  }
  return out;
}

for (const scene of scenes) {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  let bandSum;
  await withLab(async (lab) => {
    await lab.show({ caseName: scene.caseName, shot: scene.shot, mode: 2, set: 'tuning', key: scene.name });
    await lab.setUpsampleAlphaOne(false);
    await lab.setTier({ ...tierOf(0.451, 1), scale });
    await lab.renderProductionCorrectionPhase(0, true);
    for (let first = 0; first < passes; first += CHUNK_PASSES) {
      await lab.accumulateProductionPasses(first, CHUNK_PASSES, false, true);
      const sums = await lab.takePassSums(false);
      const packed = sums.sums[0][0].map((value, i) => value + sums.sums[1][0][i]);
      const rgb = unpackedBand([packed], 0);
      if (bandSum === undefined) bandSum = new Float64Array(rgb.length);
      for (let i = 0; i < rgb.length; i++) bandSum[i] += rgb[i];
    }
  });
  const dir = path.join(output, scene.name);
  mkdirSync(dir, { recursive: true });
  const averaged = Float32Array.from(bandSum, (value) => value / passes);
  const reduced = boxDownsample(averaged);
  const f32 = path.join(dir, `band-sum-ladder-${scale}.rgba.f32`);
  writeFloats(f32, reduced);
  const rgb8 = new Uint8Array(SCAN_WIDTH * SCAN_HEIGHT * 3);
  for (let p = 0; p < SCAN_WIDTH * SCAN_HEIGHT; p++) for (let c = 0; c < 3; c++) {
    rgb8[p * 3 + c] = Math.round(127.5 + 127.5 * Math.max(-1, Math.min(1, reduced[p * 4 + c] / 0.01)));
  }
  writeFileSync(path.join(dir, `band-sum-ladder-${scale}.png`), encodeRgbPng(SCAN_WIDTH, SCAN_HEIGHT, rgb8));
  writeFileSync(path.join(dir, `ladder-${scale}.json`), JSON.stringify({ scene: scene.name, run, scale, passes, head: shortHead,
    captureStartedAt: startedAt, captureWallTimeMs: performance.now() - started, shot: scene.shot, file: path.basename(f32) }, null, 2));
  console.log(`${scene.name}: ${passes} passes; ${Math.round(performance.now() - started)} ms`);
}
