// 映り込みの多シード平均と均しの誤差を、線形 HDR のまま測る。
// 使い方: node tools/render-lab-reflection-chain-metrics.mjs --run=<label> [--scene=<key>] [--passes=<N>] [--graphics=<JSON>]
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { withLab, writeFloats } from './screen-space-lab.mjs';
import {
  BASE_GRAPHICS, GRID, PIXELS, SCENES, argumentOf, centeredPng, colorPng, difference, graphicsOf, logStep,
  meanImage, powerOfTwoAtMost, qImage, readImage, seedsOf, takeReflectionSums,
} from './reflection-chain-common.mjs';

const OUTPUT = path.join(path.resolve(import.meta.dirname, '..'), '.render-lab-shots', 'ssr-chain-metrics');
const RUNS = path.join(OUTPUT, 'runs');
const ONE_PASS_COUNT = 32;
const PASSES = Number(argumentOf('passes') ?? 1024);
const LABEL = argumentOf('run');
const SCENE_ARG = argumentOf('scene');
const GRAPHICS_ARG = argumentOf('graphics');
const REQUIRED_GRAPHICS = BASE_GRAPHICS;
const selectedScenes = SCENE_ARG === undefined ? SCENES : SCENES.filter(({ key }) => key === SCENE_ARG);

if (LABEL === undefined || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(LABEL)) {
  throw new Error('usage: node tools/render-lab-reflection-chain-metrics.mjs --run=<label> [--scene=<key>] [--passes=<N>] [--graphics=<JSON>]');
}
if (!Number.isInteger(PASSES) || PASSES < 1 || PASSES > GRID * GRID) throw new Error('--passes must be between 1 and 4096');
if (PASSES > GRID * GRID - ONE_PASS_COUNT && PASSES < GRID * GRID) {
  throw new Error('32 disjoint one-pass shifts are unavailable for --passes between 4065 and 4095');
}
if (selectedScenes.length === 0) throw new Error(`unknown scene: ${SCENE_ARG}`);
const GRAPHICS = { ...graphicsOf(GRAPHICS_ARG), ...REQUIRED_GRAPHICS };
const SEEDS = seedsOf();
const singleStart = PASSES === GRID * GRID ? 0 : GRID * GRID - ONE_PASS_COUNT;
const singleSeeds = SEEDS.slice(singleStart, singleStart + ONE_PASS_COUNT);
const outputDir = path.join(RUNS, LABEL);
mkdirSync(outputDir, { recursive: true });

await withLab(async (_lab, devTools) => {
  const startedAt = new Date().toISOString();
  const runStarted = performance.now();
  const scenes = [];
  for (const scene of selectedScenes) {
    scenes.push(await captureScene(devTools, scene));
  }
  const record = {
    schema: 1,
    run: LABEL,
    commit: execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(),
    startedAt,
    wallTimeMs: performance.now() - runStarted,
    passes: PASSES,
    onePassCount: ONE_PASS_COUNT,
    seedOrder: 'R2 sequence using plastic-number alpha=(1/g,1/g²), first N unique cells of 64×64 tile',
    singlePassSeeds: 'last 32 cells of the R2 sequence, except N=4096 uses the first 32',
    graphics: GRAPHICS,
    disabledGraphicsKeys: ['screenSpaceOcclusion', 'screenSpaceIndirect', 'antialias', 'lens'],
    scenes: scenes.map(({ key, captureWallTimeMs }) => ({ key, captureWallTimeMs })),
  };
  writeFileSync(path.join(outputDir, 'record.json'), JSON.stringify(record, null, 2));
  writeSummary(scenes, record);
  writeIndex();
});

async function captureScene(devTools, scene) {
  const dir = path.join(outputDir, scene.key);
  mkdirSync(dir, { recursive: true });
  const started = performance.now();
  await devTools.evaluate(`window.renderLab.showShot(${JSON.stringify(scene.caseName)}, ${JSON.stringify(scene.shot)}, ${JSON.stringify(GRAPHICS)})`);
  for (const [key, value] of Object.entries(GRAPHICS)) {
    await devTools.evaluate(`window.renderLab.setGraphicsOption(${JSON.stringify(key)}, ${JSON.stringify(value)})`);
  }
  await devTools.evaluate('window.renderLab.setTarget("off")');

  logStep(scene.key, 'repeat check');
  const repeated = await repeatedSeedDifference(devTools);
  if (repeated.maximumAbsoluteDifference !== 0) {
    throw new Error(`${scene.key}: same-seed repeat differs: ${JSON.stringify(repeated)}`);
  }

  const exposure = await devTools.evaluate('window.renderLab.exposureFactor()');
  logStep(scene.key, 'accumulate');
  const sums = await takeReflectionSums(devTools, SEEDS.slice(0, PASSES));
  logStep(scene.key, 'read sums done');
  const far = await readImage(devTools, 'far-specular');
  const rawMean = meanImage(sums[0][0], sums[1][0], PASSES);
  const denoisedMean = meanImage(sums[0][1], sums[1][1], PASSES);
  const q1 = qImage(rawMean, far, exposure);
  const q2 = qImage(denoisedMean, far, exposure);
  const parityCount = Math.ceil(PASSES / 2);
  const oddCount = Math.floor(PASSES / 2);
  const evenQ = qImage(meanImage(sums[0][0], null, parityCount), far, exposure);
  const oddQ = oddCount === 0 ? new Float32Array(evenQ.length) : qImage(meanImage(sums[1][0], null, oddCount), far, exposure);
  const convergence = difference(evenQ, oddQ);
  const structure = difference(q2, q1);

  const noiseSquares = new Float64Array(3);
  const rawNoiseSquares = new Float64Array(3);
  let sampleQ = null;
  let sampleDifference = null;
  logStep(scene.key, 'one passes');
  for (let index = 0; index < singleSeeds.length; index++) {
    const [x, y] = singleSeeds[index];
    await devTools.evaluate(`window.renderLab.renderReflectionPass(${x}, ${y})`);
    const raw = await readImage(devTools, 'reflection-raw');
    const denoised = await readImage(devTools, 'reflection-denoised');
    const qRaw = qImage(raw, far, exposure);
    const qDenoised = qImage(denoised, far, exposure);
    const oneDiff = difference(qDenoised, q2);
    const oneRawDiff = difference(qRaw, q1);
    accumulateSquares(noiseSquares, oneDiff);
    accumulateSquares(rawNoiseSquares, oneRawDiff);
    if (index === 0) {
      sampleQ = qDenoised;
      sampleDifference = oneDiff;
    }
  }

  logStep(scene.key, 'metrics');
  const mask = surfaceMask(rawMean, denoisedMean);
  const metrics = {
    scene: scene.key,
    passes: PASSES,
    exposureFactor: exposure,
    surfacePixelCount: mask.reduce((sum, value) => sum + value, 0),
    structuralErrorRms: rmsOf(structure, mask),
    denoisedOnePassNoiseRms: rmsFromSquares(noiseSquares, mask, ONE_PASS_COUNT),
    rawOnePassNoiseRms: rmsFromSquares(rawNoiseSquares, mask, ONE_PASS_COUNT),
    convergenceHalfDifferenceRms: rmsOf(convergence, mask),
    deterministicRepeat: repeated,
    captureWallTimeMs: performance.now() - started,
  };
  const gain = powerOfTwoAtMost(0.95 / Math.max(quantilePositive(q1, mask, 0.99), 1e-12));
  const h = powerOfTwoAtMost(0.5 / Math.max(quantileAbs([structure, sampleDifference, convergence], mask, 0.999), 1e-12));
  metrics.display = { gain, differenceGain: h };

  logStep(scene.key, 'write floats');
  writeFloats(path.join(dir, 'raw-even-sum.f32'), sums[0][0].rgba);
  writeFloats(path.join(dir, 'raw-odd-sum.f32'), sums[1][0].rgba);
  writeFloats(path.join(dir, 'denoised-even-sum.f32'), sums[0][1].rgba);
  writeFloats(path.join(dir, 'denoised-odd-sum.f32'), sums[1][1].rgba);
  writeFloats(path.join(dir, 'far-specular.f32'), far.rgba);
  writeFloats(path.join(dir, 'exposure-factor.f32'), Float32Array.of(exposure));
  writeFloats(path.join(dir, 'q1.f32'), q1);
  writeFloats(path.join(dir, 'q2.f32'), q2);
  writeFloats(path.join(dir, 'q3.f32'), sampleQ);
  writeFileSync(path.join(dir, 'metrics.json'), JSON.stringify(metrics, null, 2));
  logStep(scene.key, 'write pngs');
  for (const [name, image] of Object.entries({
    q1: colorPng(q1, gain), q2: colorPng(q2, gain), q3: colorPng(sampleQ, gain),
    'q2-minus-q1': centeredPng(structure, h), 'q3-minus-q2': centeredPng(sampleDifference, h),
    'q1-even-minus-odd': centeredPng(convergence, h),
  })) writeFileSync(path.join(dir, `${name}.png`), image);
  return { ...metrics, q1, q2, structure, convergence, sampleDifference };
}

async function repeatedSeedDifference(devTools) {
  await devTools.evaluate('window.renderLab.renderReflectionPass(0, 0)');
  const firstRaw = await readImage(devTools, 'reflection-raw');
  const firstDenoised = await readImage(devTools, 'reflection-denoised');
  await devTools.evaluate('window.renderLab.renderReflectionPass(0, 0)');
  const secondRaw = await readImage(devTools, 'reflection-raw');
  const secondDenoised = await readImage(devTools, 'reflection-denoised');
  return {
    rawMaximumAbsoluteDifference: maximumDifference(firstRaw.rgba, secondRaw.rgba),
    denoisedMaximumAbsoluteDifference: maximumDifference(firstDenoised.rgba, secondDenoised.rgba),
    maximumAbsoluteDifference: Math.max(
      maximumDifference(firstRaw.rgba, secondRaw.rgba), maximumDifference(firstDenoised.rgba, secondDenoised.rgba)),
  };
}

// 撮影の段の始まりを時刻つきで出す。
function surfaceMask(raw, denoised) {
  return Uint8Array.from({ length: PIXELS }, (_, p) => Number(raw.rgba[p * 4 + 3] > 0 || denoised.rgba[p * 4 + 3] > 0));
}

function accumulateSquares(squares, values) {
  for (let p = 0; p < PIXELS; p++) for (let c = 0; c < 3; c++) squares[c] += values[p * 4 + c] ** 2;
}

function rmsOf(values, mask) {
  const squares = [0, 0, 0];
  for (let p = 0; p < PIXELS; p++) if (mask[p]) for (let c = 0; c < 3; c++) squares[c] += values[p * 4 + c] ** 2;
  return squares.map((sum) => Math.sqrt(sum / Math.max(mask.reduce((count, value) => count + value, 0), 1)));
}

function rmsFromSquares(squares, mask, samples) {
  const count = Math.max(mask.reduce((sum, value) => sum + value, 0) * samples, 1);
  return Array.from(squares, (sum) => Math.sqrt(sum / count));
}

function maximumDifference(a, b) {
  let maximum = 0;
  for (let i = 0; i < a.length; i++) maximum = Math.max(maximum, Math.abs(a[i] - b[i]));
  return maximum;
}

function quantilePositive(image, mask, fraction) {
  const values = [];
  for (let p = 0; p < PIXELS; p++) if (mask[p]) for (let c = 0; c < 3; c++) values.push(Math.max(0, image[p * 4 + c]));
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.floor(fraction * (values.length - 1)))] ?? 0;
}

function quantileAbs(images, mask, fraction) {
  const values = [];
  for (const image of images) for (let p = 0; p < PIXELS; p++) if (mask[p]) {
    for (let c = 0; c < 3; c++) values.push(Math.abs(image[p * 4 + c]));
  }
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.floor(fraction * (values.length - 1)))] ?? 0;
}

function writeSummary(scenes, record) {
  const rows = scenes.map((scene) => `| ${scene.scene} | ${formatVector(scene.structuralErrorRms)} | ${formatVector(scene.denoisedOnePassNoiseRms)} | ${formatVector(scene.rawOnePassNoiseRms)} | ${formatVector(scene.convergenceHalfDifferenceRms)} | ${(scene.captureWallTimeMs / 1000).toFixed(1)} |`);
  const body = `# SSR chain metrics: ${record.run}\n\nCommit: \`${record.commit}\`  \nPasses: ${record.passes}  \nGraphics: \`${JSON.stringify(record.graphics)}\`  \nSeed order: ${record.seedOrder}\n\n| Scene | RMS(q₂−q₁) RGB | RMS(q₃−q₂) RGB | raw RMS(q−q₁) RGB | RMS(q₁ even−odd) RGB | seconds |\n|---|---:|---:|---:|---:|---:|\n${rows.join('\n')}\n\nRoughness bands are not included; per-band routing needs an additional roughness capture/readback path.\n`;
  writeFileSync(path.join(outputDir, 'summary.md'), body);
}

function writeIndex() {
  const runs = readdirSync(RUNS, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const scenes = Object.fromEntries(runs.map((run) => [run,
    existsSync(path.join(RUNS, run)) ? readdirSync(path.join(RUNS, run), { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort() : []]));
  const imageNames = ['q1', 'q2', 'q3', 'q2-minus-q1', 'q3-minus-q2', 'q1-even-minus-odd'];
  const html = `<!doctype html><meta charset="utf-8"><title>SSR chain metrics</title><style>
body{font:14px system-ui;margin:20px;background:#17191d;color:#eee}nav,section{display:flex;gap:8px;white-space:nowrap;overflow:auto;margin:10px 0}button{padding:7px 12px;color:#eee;background:#343840;border:0;cursor:pointer}button.selected{background:#167d9a}img{width:960px;height:540px;object-fit:contain;background:#08090a}#frame{width:960px;height:540px;overflow:hidden}small{display:block;color:#aaa}</style>
<h1>SSR chain metrics</h1><nav id="runs"></nav><nav id="scenes"></nav><nav id="images"></nav><small id="caption"></small><div id="frame"><img id="image"></div>
<script>const scenes=${JSON.stringify(scenes)},images=${JSON.stringify(imageNames)};let run=Object.keys(scenes).at(-1),scene='',kind=images[0];
function buttons(id,items,selected,choose){const host=document.getElementById(id);host.replaceChildren(...items.map((name,index)=>{const b=document.createElement('button');b.textContent=name;b.className=name===selected?'selected':'';b.onclick=()=>choose(name);if(id==='runs'&&index<9)b.title='Key '+(index+1);return b}))}
function draw(){buttons('runs',Object.keys(scenes),run,v=>{run=v;scene=scenes[run][0]??'';draw()});buttons('scenes',scenes[run]??[],scene,v=>{scene=v;draw()});buttons('images',images,kind,v=>{kind=v;draw()});document.getElementById('image').src='runs/'+encodeURIComponent(run)+'/'+encodeURIComponent(scene)+'/'+kind+'.png';document.getElementById('caption').textContent=run+' / '+scene+' / '+kind}
onkeydown=e=>{if(e.key>='1'&&e.key<='9'){const v=Object.keys(scenes)[Number(e.key)-1];if(v){run=v;scene=scenes[run][0]??'';draw()}}};draw()</script>`;
  writeFileSync(path.join(OUTPUT, 'index.html'), html);
}

function formatVector(values) {
  return values.map((value) => value.toExponential(3)).join(' / ');
}
