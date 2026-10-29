// 映り込みの多シード平均と均しの誤差を、線形 HDR のまま測る。
// 使い方: node tools/render-lab-reflection-chain-metrics.mjs --run=<label> [--scene=<key>] [--passes=<N>] [--graphics=<JSON>]
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { encodeRgbPng } from './png.mjs';
import { HEIGHT, WIDTH, withLab, writeFloats } from './screen-space-lab.mjs';

const OUTPUT = path.join(path.resolve(import.meta.dirname, '..'), '.render-lab-shots', 'ssr-chain-metrics');
const RUNS = path.join(OUTPUT, 'runs');
const GRID = 64;
const PIXELS = WIDTH * HEIGHT;
const ONE_PASS_COUNT = 32;
const CHUNK_PASSES = 128;
const PASSES = Number(argumentOf('passes') ?? 1024);
const LABEL = argumentOf('run');
const SCENE_ARG = argumentOf('scene');
const GRAPHICS_ARG = argumentOf('graphics');
const BASE_GRAPHICS = {
  screenSpaceSpecular: true,
  screenSpaceSpecularDenoise: true,
  screenSpaceOcclusion: false,
  screenSpaceIndirect: false,
  antialias: 0,
  lens: false,
};
const REQUIRED_GRAPHICS = BASE_GRAPHICS;
const SCENES = [
  { key: 'metal-room', caseName: 'metal-room', shot: 'metal-room' },
  { key: 'metal-room-close', caseName: 'metal-room', shot: 'metal-room-close' },
  { key: 'bay-metal', caseName: 'bay', shot: 'bay-metal' },
  { key: 'ladder-no-planet', caseName: 'reflection-ladder', shot: 'ladder-no-planet' },
  { key: 'ladder-checker-no-planet', caseName: 'reflection-ladder-checker', shot: 'ladder-checker-no-planet' },
];
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

async function takeReflectionSums(devTools, seeds) {
  // CDP の 1 回の評価が上限（180 秒）に掛からないように、CHUNK_PASSES ずつ足す。
  for (let first = 0; first < seeds.length; first += CHUNK_PASSES) {
    await devTools.evaluate(`window.renderLab.addReflectionPasses(${JSON.stringify(seeds.slice(first, first + CHUNK_PASSES))}, ${first})`);
    console.log(`${new Date().toISOString()} passes ${Math.min(first + CHUNK_PASSES, seeds.length)} / ${seeds.length}`);
  }
  const sizes = await devTools.evaluate(`window.renderLab.takeReflectionSums()
    .then((sums) => { window.__reflectionSums = sums; return sums.map((parity) => parity.map(({ width, height, rgba }) => [width, height, rgba.length])); })`);
  const result = [];
  for (let parity = 0; parity < 2; parity++) {
    const images = [];
    for (let kind = 0; kind < 2; kind++) {
      const [width, height, length] = sizes[parity][kind];
      images.push({ width, height, rgba: await receiveFloats(devTools, `window.__reflectionSums[${parity}][${kind}].rgba`, length) });
    }
    result.push(images);
  }
  await devTools.evaluate('delete window.__reflectionSums');
  return result;
}

async function readImage(devTools, name) {
  const [width, height, length] = await devTools.evaluate(`window.renderLab.readFloat(${JSON.stringify(name)})
    .then((image) => { window.__reflectionImage = image; return [image.width, image.height, image.rgba.length]; })`);
  const rgba = await receiveFloats(devTools, 'window.__reflectionImage.rgba', length);
  await devTools.evaluate('delete window.__reflectionImage');
  return { width, height, rgba };
}

async function receiveFloats(devTools, source, length) {
  const out = new Float32Array(length);
  const bytesPerChunk = 64 * WIDTH * 3 * 4;
  for (let start = 0; start < length * 4; start += bytesPerChunk) {
    const size = Math.min(bytesPerChunk, length * 4 - start);
    const base64 = await devTools.evaluate(`new Uint8Array(${source}.buffer, ${start}, ${size}).toBase64()`);
    const bytes = Buffer.from(base64, 'base64');
    out.set(new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + size)), start / 4);
  }
  return out;
}

// 撮影の段の始まりを時刻つきで出す。
function logStep(scene, step) {
  console.log(`${new Date().toISOString()} ${scene}: ${step}`);
}

function seedsOf() {
  const g = 1.324717957244746;
  const cells = [];
  const seen = new Set();
  for (let n = 0; cells.length < GRID * GRID; n++) {
    const x = Math.floor(((n / g) % 1) * GRID);
    const y = Math.floor(((n / g ** 2) % 1) * GRID);
    const key = y * GRID + x;
    if (seen.has(key)) continue;
    seen.add(key);
    cells.push([x, y]);
  }
  return cells;
}

function qImage(image, far, exposure) {
  const q = new Float32Array(image.rgba.length);
  for (let p = 0; p < PIXELS; p++) {
    const weight = image.rgba[p * 4 + 3];
    for (let c = 0; c < 3; c++) q[p * 4 + c] = exposure * (image.rgba[p * 4 + c] - far.rgba[p * 4 + c] * weight);
    q[p * 4 + 3] = weight;
  }
  return q;
}

function meanImage(first, second, count) {
  const out = new Float32Array(first.rgba.length);
  for (let i = 0; i < out.length; i++) out[i] = (first.rgba[i] + (second?.rgba[i] ?? 0)) / count;
  return { width: first.width, height: first.height, rgba: out };
}

function difference(a, b) {
  const out = new Float32Array(a.length);
  for (let p = 0; p < PIXELS; p++) {
    for (let c = 0; c < 3; c++) out[p * 4 + c] = a[p * 4 + c] - b[p * 4 + c];
    out[p * 4 + 3] = 1;
  }
  return out;
}

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

function colorPng(image, gain) {
  const rgb = new Uint8Array(PIXELS * 3);
  for (let p = 0; p < PIXELS; p++) for (let c = 0; c < 3; c++) {
    rgb[p * 3 + c] = Math.round(255 * srgb(Math.max(0, Math.min(1, image[p * 4 + c] * gain))));
  }
  return encodeRgbPng(WIDTH, HEIGHT, rgb);
}

function centeredPng(image, gain) {
  const rgb = new Uint8Array(PIXELS * 3);
  for (let p = 0; p < PIXELS; p++) for (let c = 0; c < 3; c++) {
    // 差の地図は符号を読むので、0.5 を中央の灰に置いたまま sRGB へ写さない。
    rgb[p * 3 + c] = Math.round(255 * Math.max(0, Math.min(1, 0.5 + gain * image[p * 4 + c])));
  }
  return encodeRgbPng(WIDTH, HEIGHT, rgb);
}

function srgb(value) {
  return value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
}

function powerOfTwoAtMost(value) {
  return 2 ** Math.floor(Math.log2(Math.max(value, 2 ** -30)));
}

function argumentOf(name) {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function graphicsOf(argument) {
  if (argument === undefined) return BASE_GRAPHICS;
  const parsed = JSON.parse(argument);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object'
      || Object.values(parsed).some((value) => typeof value !== 'boolean' && !Number.isFinite(value))) {
    throw new Error('--graphics must be a JSON object with boolean or numeric values');
  }
  return { ...BASE_GRAPHICS, ...parsed };
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
