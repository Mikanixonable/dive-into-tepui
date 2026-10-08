// 手順8-15の帯鎖を、走査解像度の構造誤差と1パス雑音に分けて撮る。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { encodeRgbPng } from './png.mjs';
import { HEIGHT, seedOf, shotsDir, WIDTH, withLab, writeFloats } from './screen-space-lab.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUTPUT = path.join(shotsDir, 'ssd-8-15-chain-metrics');
const RUNS = path.join(OUTPUT, 'runs');
const CHUNK_PASSES = 256;
const NOISE_PASSES = 32;
const NOISE_FIRST_PASS = 5000;
const INVARIANT_PASS = 7000;
const TIER = { scale: 0.25, sliceCount: 4, stepCount: 5, bandCount: 4, bandScale: 0.75 };
const SCAN_DISPLAY_QUANTILE = 0.999;
const STRUCTURE_DISPLAY_QUANTILE = 0.999;
const NOISE_DISPLAY_QUANTILE = 0.995;
const SCAN_WIDTH = Math.round(WIDTH * TIER.scale);
const SCAN_HEIGHT = Math.round(HEIGHT * TIER.scale);
const PIXELS = SCAN_WIDTH * SCAN_HEIGHT;
const SCENES = [
  { name: 'bay-earth-open', caseName: 'bay', caseFile: 'tools/render-lab/bay-cases.ts', shot: 'bay-earth-open', rois: { target: [125, 30, 31, 19] } },
  { name: 'cornell-box', caseName: 'cornell-box', caseFile: 'tools/render-lab/cornell-box-case.ts', shot: 'cornell-box', rois: { target: [30, 42, 28, 33] } },
  { name: 'bay-dark', caseName: 'bay', caseFile: 'tools/render-lab/bay-cases.ts', shot: 'bay-dark', rois: { target: [105, 30, 46, 43] } },
  // 各板の内側の床。core は蝶番から 0.75 m まで、wide は 1.5 m から 4 m まで、板の中心線の幅 ±0.3 m。
  // gap は隣り合う板の隙間の真後ろの床(半径 10.3〜11.5 m、隙間の中央から ±0.5 m)。
  // カメラの投影で床の4隅を走査画素へ落とし、外接箱を内側へ丸めて、板に掛かる行を除いた。
  {
    name: 'angled-bounce', caseName: 'angled-bounce', caseFile: 'tools/render-lab/angled-bounce-case.ts', shot: 'angled-bounce',
    rois: {
      'core-30': [38, 75, 11, 5], 'core-60': [80, 70, 8, 4], 'core-90': [116, 69, 8, 3],
      'core-120': [152, 70, 8, 4], 'core-150': [191, 76, 11, 4],
      'wide-30': [39, 84, 17, 25], 'wide-60': [80, 78, 12, 22], 'wide-90': [114, 77, 12, 20],
      'wide-120': [148, 78, 12, 22], 'wide-150': [184, 84, 17, 25],
      'gap-30-60': [57, 65, 14, 6], 'gap-60-90': [96, 63, 12, 4],
      'gap-90-120': [132, 63, 12, 4], 'gap-120-150': [169, 65, 14, 6],
    },
  },
];
const passesArgument = process.argv.find((arg) => arg.startsWith('--passes='));
const PASSES = passesArgument === undefined ? 1024 : Number(passesArgument.split('=')[1]);
if (![1024, 2048, 4096].includes(PASSES)) throw new Error('--passes must be 1024, 2048, or 4096');
const runArgument = process.argv.find((arg) => arg.startsWith('--run='));
if (runArgument === undefined) throw new Error('usage: node tools/render-lab-screen-space-chain-metrics.mjs --run=<label> [--scene=<name>] [--dry-run]');
const RUN_LABEL = runArgument.slice('--run='.length);
if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(RUN_LABEL)) throw new Error('--run must be a safe lowercase label (letters, digits, hyphens)');
const DRY_RUN = process.argv.includes('--dry-run');
const sceneArgument = process.argv.find((arg) => arg.startsWith('--scene='));
const scenes = sceneArgument === undefined ? SCENES : SCENES.filter(({ name }) => name === sceneArgument.split('=')[1]);
if (scenes.length === 0) throw new Error(`unknown scene: ${sceneArgument}`);
const RUN_DIR = path.join(RUNS, RUN_LABEL);
const RUN_RECORD = path.join(RUN_DIR, 'record.json');
const RUN_INDEX = path.join(RUN_DIR, 'index.html');
const COMMON_SIGNATURE = sourceSignature();
const sceneSourceSignatures = new Map(SCENES.map((scene) => [scene.name, sceneSignature(scene)]));
const cacheKeys = new Map(SCENES.map((scene) => [scene.name, cacheKeyOf(scene)]));

function existingRunRecord() {
  if (!existsSync(RUN_RECORD)) {
    if (existsSync(RUN_DIR)) {
      const entries = readdirSync(RUN_DIR, { withFileTypes: true });
      const hasUnexpectedFiles = entries.some((entry) => {
        if (!entry.isDirectory() || !SCENES.some((scene) => scene.name === entry.name)) return true;
        return readdirSync(path.join(RUN_DIR, entry.name)).some((file) => file !== 'rois-on-render.png');
      });
      if (hasUnexpectedFiles) throw new Error(`run directory has files but no record.json: ${RUN_DIR}`);
    }
    return null;
  }
  const record = JSON.parse(readFileSync(RUN_RECORD, 'utf8'));
  if (record.schema !== 2 || record.run !== RUN_LABEL) throw new Error(`unsupported or mismatched run record: ${RUN_RECORD}`);
  if (record.scanSourceSignature !== COMMON_SIGNATURE) {
    throw new Error(`run ${RUN_LABEL} has a different shared scan-source signature; choose a new --run label`);
  }
  if (JSON.stringify(record.conditions) !== JSON.stringify(captureConditions())) {
    throw new Error(`run ${RUN_LABEL} has different capture conditions; choose a new --run label`);
  }
  for (const stored of Object.values(record.scenes ?? {})) {
    if (sceneSourceSignatures.get(stored.scene) !== stored.sceneSourceSignature) {
      throw new Error(`run ${RUN_LABEL}/${stored.scene} has a different scene source signature; choose a new --run label`);
    }
  }
  return record;
}

const runRecord = existingRunRecord() ?? {
  schema: 2, run: RUN_LABEL, createdAt: new Date().toISOString(),
  scanSourceSignature: COMMON_SIGNATURE, conditions: captureConditions(), scenes: {},
};

function cacheDirOf(scene) {
  return path.join(OUTPUT, 'cache', scene.name, cacheKeys.get(scene.name));
}

function validChunkCount(scene) {
  const cache = cacheDirOf(scene);
  let count = 0;
  for (let first = 0; first < PASSES; first += CHUNK_PASSES) {
    const files = [0, 1, 2].map((texture) => chunkFile(cache, first, texture));
    if (files.every((file) => existsSync(file) && readFileSync(file).byteLength === PIXELS * 4 * 4)) count++;
  }
  return count;
}

if (DRY_RUN) {
  console.log(JSON.stringify({ run: RUN_LABEL, scanSourceSignature: COMMON_SIGNATURE, passes: PASSES, chunkPasses: CHUNK_PASSES,
    scenes: scenes.map((scene) => ({ name: scene.name, sceneSourceSignature: sceneSourceSignatures.get(scene.name),
      cacheKey: cacheKeys.get(scene.name), validChunks: validChunkCount(scene), totalChunks: Math.ceil(PASSES / CHUNK_PASSES) })) }, null, 2));
  process.exit(0);
}

function sourceSignature() {
  const hash = createHash('sha256').update('ssd-8-15-scan-source-v2');
  const files = [
    ...filesIn('src/render/pipeline/screen-space'),
    'src/render/pipeline/gbuffer.ts', 'src/render/pipeline/material-pass.ts',
    'src/render/pipeline/light-prepass.ts', 'src/render/pipeline/lit-layer.ts',
    'src/render/pipeline/render-pipeline.ts', 'src/render/pipeline/view-ray.ts',
    'src/render/pipeline/exposure.ts', 'src/render/graphics-settings.ts',
    'tools/render-lab/lab.ts', 'tools/render-lab/main.ts',
    'tools/render-lab/pass-accumulator.ts', 'tools/render-lab/lab-case.ts',
    'tools/screen-space-lab.mjs',
  ].sort();
  for (const relative of files) hash.update(relative).update(readFileSync(path.join(ROOT, relative)));
  hash.update(JSON.stringify({ width: WIDTH, height: HEIGHT, tier: TIER, chunkPasses: CHUNK_PASSES }));
  return hash.digest('hex').slice(0, 16);
}

function filesIn(folder) {
  const found = [];
  for (const item of readdirSync(path.join(ROOT, folder), { withFileTypes: true })) {
    const relative = path.join(folder, item.name);
    if (item.isDirectory()) found.push(...filesIn(relative));
    else if (item.name.endsWith('.ts')) found.push(relative);
  }
  return found;
}

function sceneSignature(scene) {
  const relative = scene.caseFile;
  return createHash('sha256').update(COMMON_SIGNATURE).update(JSON.stringify({ name: scene.name, caseName: scene.caseName, shot: scene.shot }))
    .update(relative).update(readFileSync(path.join(ROOT, relative)))
    .digest('hex').slice(0, 16);
}

function cacheKeyOf(scene) {
  return createHash('sha256').update('ssd-8-15-chunk-cache-v2').update(sceneSourceSignatures.get(scene.name))
    .update(`chunkPasses:${CHUNK_PASSES}`).update(JSON.stringify(TIER)).digest('hex').slice(0, 16);
}

function captureConditions() {
  return { viewport: [WIDTH, HEIGHT], scanResolution: [SCAN_WIDTH, SCAN_HEIGHT], tier: TIER, passes: PASSES,
    chunkPasses: CHUNK_PASSES, invariantPass: INVARIANT_PASS,
    noisePasses: { first: NOISE_FIRST_PASS, count: NOISE_PASSES }, baselineLabel: 'before-a' };
}

function readFloats(file) {
  const bytes = readFileSync(file);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function rgbDifference(a, b) {
  const result = new Float32Array(a.length);
  for (let i = 0; i < result.length; i += 4) {
    for (let c = 0; c < 3; c++) result[i + c] = a[i + c] - b[i + c];
    result[i + 3] = 1;
  }
  return result;
}

function rms(values, roi) {
  const [left, top, width, height] = roi;
  let squares = 0;
  for (let y = top; y < top + height; y++) for (let x = left; x < left + width; x++) {
    const p = (y * SCAN_WIDTH + x) * 4;
    for (let c = 0; c < 3; c++) squares += values[p + c] ** 2;
  }
  return Math.sqrt(squares / (width * height * 3));
}

function invariantDifference(raw, bandSum) {
  let sum = 0, maximum = 0;
  for (let i = 0; i < raw.length; i += 4) for (let c = 0; c < 3; c++) {
    const delta = Math.abs(raw[i + c] - bandSum[i + c]);
    sum += delta;
    maximum = Math.max(maximum, delta);
  }
  return { meanAbsolute: sum / (PIXELS * 3), maximumAbsolute: maximum };
}

function alphaMap(merged) {
  return Float32Array.from({ length: PIXELS }, (_, p) => merged[p * 4 + 3]);
}

function chunkFile(cache, first, texture) {
  return path.join(cache, `sum-${String(first).padStart(4, '0')}-packed-${texture}.f32`);
}

function cachedMean(cache, first, end) {
  const sums = Array.from({ length: 3 }, () => new Float64Array(PIXELS * 4));
  for (let pass = first; pass < end; pass += CHUNK_PASSES) {
    for (let texture = 0; texture < 3; texture++) {
      const values = readFloats(chunkFile(cache, pass, texture));
      if (values.length !== PIXELS * 4) throw new Error(`invalid cached scan chunk ${pass}/${texture}`);
      const sum = sums[texture];
      for (let i = 0; i < sum.length; i++) sum[i] += values[i];
    }
  }
  return sums.map((values) => Float32Array.from(values, (value) => value / (end - first)));
}

async function mergedOf(lab, packed) {
  for (const [index, rgba] of packed.entries()) await lab.writePackedBands(index, rgba);
  await lab.setStageRange('chain');
  await lab.render();
  return { bandSum: await lab.readFloat('band-sum', 4), merged: await lab.readFloat('merged-0', 4) };
}

async function clayPng(lab) {
  const rgba = await lab.readFloat('diffuse', 4);
  for (let i = 0; i < rgba.length; i += 4) {
    for (let c = 0; c < 3; c++) rgba[i + c] = Math.max(0, rgba[i + c]);
    rgba[i + 3] = 1;
  }
  const display = await lab.composite({ width: WIDTH, height: HEIGHT, rgba });
  const rgb = new Uint8Array(WIDTH * HEIGHT * 3);
  for (let p = 0; p < WIDTH * HEIGHT; p++) for (let c = 0; c < 3; c++) {
    rgb[p * 3 + c] = Math.round(255 * Math.max(0, Math.min(1, display.rgba[p * 4 + c])));
  }
  return encodeRgbPng(WIDTH, HEIGHT, rgb);
}

function signedRgb(values, scale) {
  const rgb = new Uint8Array(PIXELS * 3);
  for (let p = 0; p < PIXELS; p++) for (let c = 0; c < 3; c++) {
    rgb[p * 3 + c] = Math.round(127.5 + 127.5 * Math.max(-1, Math.min(1, values[p * 4 + c] / scale)));
  }
  return rgb;
}

function signedPng(values, scale) {
  return encodeRgbPng(SCAN_WIDTH, SCAN_HEIGHT, signedRgb(values, scale));
}

// 帯和を signedPng の写像で描き、ROI の枠を1画素の白で重ねる。
function roisPng(bandSum, rois, scale) {
  const rgb = signedRgb(bandSum, scale);
  const mark = (x, y) => rgb.fill(255, (y * SCAN_WIDTH + x) * 3, (y * SCAN_WIDTH + x) * 3 + 3);
  for (const [left, top, width, height] of Object.values(rois)) {
    for (let x = left; x < left + width; x++) { mark(x, top); mark(x, top + height - 1); }
    for (let y = top; y < top + height; y++) { mark(left, y); mark(left + width - 1, y); }
  }
  return encodeRgbPng(SCAN_WIDTH, SCAN_HEIGHT, rgb);
}

function magnitudePng(values, scale) {
  const rgb = new Uint8Array(PIXELS * 3);
  for (let p = 0; p < PIXELS; p++) {
    const i = p * 4;
    const magnitude = Math.sqrt((values[i] ** 2 + values[i + 1] ** 2 + values[i + 2] ** 2) / 3);
    const code = Math.round(255 * Math.max(0, Math.min(1, magnitude / scale)));
    for (let c = 0; c < 3; c++) rgb[p * 3 + c] = code;
  }
  return encodeRgbPng(SCAN_WIDTH, SCAN_HEIGHT, rgb);
}

function imageScale(images, quantile, magnitude = false) {
  const values = [];
  for (const rgb of images) for (let i = 0; i < rgb.length; i += 4) {
    if (magnitude) values.push(Math.hypot(rgb[i], rgb[i + 1], rgb[i + 2]) / Math.sqrt(3));
    else for (let c = 0; c < 3; c++) values.push(Math.abs(rgb[i + c]));
  }
  values.sort((a, b) => a - b);
  return Math.max(values[Math.floor(quantile * (values.length - 1))], 1e-12);
}

function recordSnapshot() {
  runRecord.updatedAt = new Date().toISOString();
  writeFileSync(RUN_RECORD, JSON.stringify(runRecord, null, 2));
}

function writeIndex() {
  const scenes = Object.values(runRecord.scenes);
  const navigation = scenes.map((scene) => `<a href="#${escapeHtml(scene.scene)}">${escapeHtml(scene.scene)}</a>`).join(' | ');
  const sections = scenes.map((scene) => {
    const dir = path.join(RUN_DIR, scene.scene);
    const entries = [
      ...scene.scanImages.map((item) => [item.png, `${item.label}（${item.id.startsWith('one-pass') ? 1 : PASSES}\u30d1\u30b9\u3001\u7dda\u5f62 signed RGB\u3001\u4e2d\u592e\u7070\u8272\u304c\u30bc\u30ed\u3001\u8868\u793a\u5e45 \u00b1${scene.displayScales.scan.scale}\u3001q=${scene.displayScales.scan.quantile}）`]),
      ['rois.png', `${PASSES}\u30d1\u30b9\u5e73\u5747\u30fbROI\u4f4d\u7f6e`],
      [`structure-${PASSES}.png`, `\u69cb\u9020\u5dee\u5206\u3001\u8868\u793a\u5e45 \u00b1${scene.displayScales.structure.scale}`],
      [`structure-half-difference-${PASSES}.png`, `\u69cb\u9020\u5dee\u5206\u306e\u534a\u5dee\u5206\u3001\u540c\u3058\u8868\u793a\u5e45 \u00b1${scene.displayScales.structure.scale}`],
      [`noise-rms-${PASSES}.png`, `1\u30d1\u30b9\u306e\u30ce\u30a4\u30ba RMS\u3001\u8868\u793a\u5e45 ${scene.displayScales.noise.scale}`],
      ['one-pass-correction.png', '1\u30d1\u30b9\u306e\u30d5\u30eb\u89e3\u50cf\u5ea6\u88dc\u6b63'],
      [`mean-${PASSES}-correction.png`, `${PASSES}\u30d1\u30b9\u5e73\u5747\u306e\u30d5\u30eb\u89e3\u50cf\u5ea6\u88dc\u6b63`],
      [`bypass-mean-${PASSES}-correction.png`, `${PASSES}\u30d1\u30b9\u5e73\u5747\u30fb\u5e2f\u5408\u8a08\u8ff4\u907f\u306e\u88dc\u6b63`],
      ['one-pass-diffuse-clay.png', '1\u30d1\u30b9\u306e\u62e1\u6563\u5149\u30af\u30ec\u30a4\u8868\u793a'],
      [`mean-${PASSES}-diffuse-clay.png`, `${PASSES}\u30d1\u30b9\u5e73\u5747\u306e\u62e1\u6563\u5149\u30af\u30ec\u30a4\u8868\u793a`],
      [`bypass-mean-${PASSES}-diffuse-clay.png`, `${PASSES}\u30d1\u30b9\u5e73\u5747\u30fb\u5e2f\u5408\u8a08\u8ff4\u907f\u306e\u30af\u30ec\u30a4\u8868\u793a`],
    ];
    if (existsSync(path.join(dir, 'rois-on-render.png'))) entries.unshift(['rois-on-render.png', '\u30d5\u30eb\u89e3\u50cf\u5ea6 ROI \u30aa\u30fc\u30d0\u30fc\u30ec\u30a4']);
    const cards = entries.filter(([file]) => scene.outputs.includes(file) || (file === 'rois-on-render.png' && existsSync(path.join(dir, file))))
      .map(([file, label]) => `<figure><a href="${scene.scene}/${file}"><img src="${scene.scene}/${file}" alt=""></a><figcaption>${escapeHtml(label)}</figcaption></figure>`).join('\n');
    return `<section id="${escapeHtml(scene.scene)}"><h2>${escapeHtml(scene.scene)}</h2><p>${PASSES} \u30d1\u30b9\u53ce\u675f\u753b\u50cf\u3001\u8d70\u67fb\u753b\u50cf\u306e\u8868\u793a\u5e45 \u00b1${scene.displayScales.scan.scale} (q=${scene.displayScales.scan.quantile})\u3001\u69cb\u9020\u5dee\u5206\u306e\u8868\u793a\u5e45 \u00b1${scene.displayScales.structure.scale} (q=${scene.displayScales.structure.quantile})\u3002</p><div class="gallery">${cards}</div></section>`;
  });
  writeFileSync(RUN_INDEX, `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>8-15 \u753b\u9762\u7a7a\u9593\u62e1\u6563 - ${escapeHtml(RUN_LABEL)}</title>
<style>:root{--page:#17191d;--panel:#222;--text:#eee;--line:#555;--space:24px;--gap:18px}body{margin:var(--space);background:var(--page);color:var(--text);font:14px system-ui}h1{font-size:24px}nav{position:sticky;top:0;padding:12px;background:var(--page);z-index:1}section{scroll-margin-top:64px;margin:28px 0}section h2{border-bottom:1px solid var(--line);padding-bottom:8px}.gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:var(--gap)}figure{margin:0}img{display:block;width:100%;background:var(--panel);image-rendering:auto}figcaption{padding:7px}a{color:inherit}</style>
<h1>8-15 \u753b\u9762\u7a7a\u9593\u62e1\u6563 - ${escapeHtml(RUN_LABEL)}</h1><p>${PASSES} \u30d1\u30b9\u3002\u8d70\u67fb\u89e3\u50cf\u5ea6 ${SCAN_WIDTH}&times;${SCAN_HEIGHT}\u3002signed RGB \u306f\u7dda\u5f62\u5024\u3092\u7070\u8272\u4e2d\u5fc3\u3067\u8868\u793a\u3057\u3001\u5404\u5834\u9762\u3067 before-a \u306e\u56fa\u5b9a\u30b9\u30b1\u30fc\u30eb\u3092\u4f7f\u3044\u307e\u3059\u3002\u64ae\u5f71\u6761\u4ef6\u3068\u5168\u30b9\u30b1\u30fc\u30eb\u306f record.json \u306b\u8a18\u9332\u3057\u307e\u3059\u3002</p><nav>${navigation}</nav><main>${sections.join('\n')}</main></html>`);
}
function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

mkdirSync(RUN_DIR, { recursive: true });
const invocationStartedAt = new Date().toISOString();
const invocationStart = performance.now();

function baselineSceneOf(scene) {
  if (RUN_LABEL === 'before-a') return null;
  const baselineRecordPath = path.join(RUNS, 'before-a', 'record.json');
  if (!existsSync(baselineRecordPath)) throw new Error(`before-a baseline is required before run ${RUN_LABEL}`);
  const baselineRecord = JSON.parse(readFileSync(baselineRecordPath, 'utf8'));
  if (JSON.stringify(baselineRecord.conditions) !== JSON.stringify(captureConditions())) {
    throw new Error(`before-a baseline conditions do not match run ${RUN_LABEL}`);
  }
  const baselineScene = baselineRecord.scenes?.[scene.name];
  if (!baselineScene) throw new Error(`before-a baseline scene is missing: ${scene.name}`);
  return baselineScene;
}

for (const scene of scenes) {
  const dir = path.join(RUN_DIR, scene.name);
  const cache = cacheDirOf(scene);
  mkdirSync(dir, { recursive: true });
  mkdirSync(cache, { recursive: true });
  const baselineScene = baselineSceneOf(scene);
  const sceneStartedAt = new Date().toISOString();
  const sceneStarted = performance.now();
  let completed = false;
  try {
    await withLab(async (lab) => {
      await lab.show({ caseName: scene.caseName, shot: scene.shot, mode: 2, set: 'tuning', key: scene.name });
      const exposure = await lab.exposureFactor();
      await lab.setUpsampleAlphaOne(false);
      await lab.setTier({ ...TIER, bandCount: 1 });
      await lab.setWhiteNoisePass(INVARIANT_PASS);
      await lab.render();
      const rawOne = await lab.readFloat('band-sum', 4);
      const rawMergedInvariant = await lab.readFloat('merged-0', 4);
      await lab.setTier(TIER);
      await lab.render();
      const invariantBandOne = await lab.readFloat('band-sum', 4);
      const invariantMergedOne = await lab.readFloat('merged-0', 4);
      const sumInvariant = invariantDifference(rawOne, invariantBandOne);
      if (sumInvariant.meanAbsolute > 1e-4 || sumInvariant.maximumAbsolute > 0.01) {
        throw new Error(`${scene.name}: one-pass band sum changed: ${JSON.stringify(sumInvariant)}`);
      }
      const invariantAlphaRaw = alphaMap(rawMergedInvariant);
      const invariantAlphaBands = alphaMap(invariantMergedOne);
      let invariantAlphaMaximumDifference = 0;
      for (let p = 0; p < invariantAlphaRaw.length; p++) {
        invariantAlphaMaximumDifference = Math.max(invariantAlphaMaximumDifference, Math.abs(invariantAlphaRaw[p] - invariantAlphaBands[p]));
      }
      if (invariantAlphaMaximumDifference > 0.001) {
        throw new Error(`${scene.name}: invariant-pass A changed across band counts: ${invariantAlphaMaximumDifference}`);
      }

      await lab.setWhiteNoisePass(null);
      await lab.setSeed(seedOf(0));
      await lab.render();
      const bandOne = await lab.readFloat('band-sum', 4);
      const mergedOne = await lab.readFloat('merged-0', 4);

      const alpha = alphaMap(mergedOne);
      const baselineFile = RUN_LABEL === 'before-a'
        ? path.join(dir, 'one-pass-a.f32')
        : path.join(RUNS, 'before-a', scene.name, 'one-pass-a.f32');
      if (RUN_LABEL !== 'before-a' && !existsSync(baselineFile)) {
        throw new Error(`${scene.name}: before-a one-pass A file is missing`);
      }
      if (RUN_LABEL === 'before-a' && !existsSync(baselineFile)) writeFloats(baselineFile, alpha);
      const baselineAlpha = readFloats(baselineFile);
      if (baselineAlpha.length !== alpha.length) throw new Error(`${scene.name}: A baseline size changed`);
      let alphaMaximumDifference = 0, alphaDifferentPixels = 0, alphaDifferenceSum = 0;
      for (let i = 0; i < alpha.length; i++) {
        const delta = Math.abs(alpha[i] - baselineAlpha[i]);
        alphaMaximumDifference = Math.max(alphaMaximumDifference, delta);
        alphaDifferenceSum += delta;
        if (delta !== 0) alphaDifferentPixels++;
      }
      if (alphaMaximumDifference > 0.001) {
        throw new Error(`${scene.name}: one-pass A changed: max ${alphaMaximumDifference}, ${alphaDifferentPixels} pixels`);
      }
      writeFloats(path.join(dir, 'one-pass-a.f32'), alpha);

      const zeros = Array.from({ length: 3 }, () => new Float32Array(PIXELS * 4));
      const zeroRgb = await mergedOf(lab, zeros);
      let alphaChangeFromRgb = 0;
      for (let p = 0; p < PIXELS; p++) {
        alphaChangeFromRgb = Math.max(alphaChangeFromRgb, Math.abs(zeroRgb.merged[p * 4 + 3] - alpha[p]));
      }
      if (alphaChangeFromRgb !== 0) throw new Error(`${scene.name}: changing only band RGB changed A by ${alphaChangeFromRgb}`);

      const cacheHits = [], cacheMisses = [];
      for (let first = 0; first < PASSES; first += CHUNK_PASSES) {
        const files = [0, 1, 2].map((texture) => chunkFile(cache, first, texture));
        if (files.every((file) => existsSync(file) && readFileSync(file).byteLength === PIXELS * 4 * 4)) {
          cacheHits.push(first);
          continue;
        }
        cacheMisses.push(first);
        await lab.accumulateWhitePasses(first, CHUNK_PASSES);
        const taken = await lab.takePassSums(false);
        for (let texture = 0; texture < 3; texture++) {
          const even = taken.sums[0][texture], odd = taken.sums[1][texture];
          const sum = Float32Array.from(even, (value, i) => value + odd[i]);
          writeFloats(files[texture], sum);
        }
        console.log(`${scene.name}: cached scan passes ${first}–${first + CHUNK_PASSES - 1}`);
      }
      const mean = cachedMean(cache, 0, PASSES);
      for (const [index, packed] of mean.entries()) writeFloats(path.join(cache, `mean-${PASSES}-packed-${index}.f32`), packed);
      const full = await mergedOf(lab, mean);
      const structure = rgbDifference(full.bandSum, full.merged);
      const firstHalf = await mergedOf(lab, cachedMean(cache, 0, PASSES / 2));
      const secondHalf = await mergedOf(lab, cachedMean(cache, PASSES / 2, PASSES));
      const structureHalfDifference = rgbDifference(
        rgbDifference(firstHalf.bandSum, firstHalf.merged),
        rgbDifference(secondHalf.bandSum, secondHalf.merged));

      const scanImages = [
        { id: 'one-pass-band-sum', label: '1\u30d1\u30b9\u30fb4\u5e2f\u5408\u8a08 (seed 0)', values: bandOne },
        { id: 'one-pass-merged', label: '1\u30d1\u30b9\u30fb\u5408\u6d41\u7d50\u679c (seed 0)', values: mergedOne },
        { id: 'converged-band-sum', label: `${PASSES}\u30d1\u30b9\u30fb4\u5e2f\u5408\u8a08`, values: full.bandSum },
        { id: 'converged-merged', label: `${PASSES}\u30d1\u30b9\u30fb\u5408\u6d41\u7d50\u679c`, values: full.merged },
      ];
      const baselineScaleFile = path.join(RUNS, 'before-a', scene.name, 'display-scales.json');
      let displayScales;
      if (RUN_LABEL === 'before-a') {
        displayScales = existsSync(baselineScaleFile) ? JSON.parse(readFileSync(baselineScaleFile, 'utf8')) : {
          scan: { quantile: SCAN_DISPLAY_QUANTILE, scale: imageScale(scanImages.map(({ values }) => values), SCAN_DISPLAY_QUANTILE) },
          structure: { quantile: STRUCTURE_DISPLAY_QUANTILE, scale: imageScale([structure], STRUCTURE_DISPLAY_QUANTILE) },
          noise: { quantile: NOISE_DISPLAY_QUANTILE, scale: null },
        };
      } else {
        if (!existsSync(baselineScaleFile)) throw new Error(`${scene.name}: before-a display scales are missing`);
        displayScales = JSON.parse(readFileSync(baselineScaleFile, 'utf8'));
      }

      const noiseSquares = new Float64Array(PIXELS * 4);
      let onePassAlphaMaximumDifference = 0;
      await lab.setStageRange('all');
      for (let pass = NOISE_FIRST_PASS; pass < NOISE_FIRST_PASS + NOISE_PASSES; pass++) {
        await lab.setWhiteNoisePass(pass);
        await lab.render();
        const one = await lab.readFloat('merged-0', 4);
        for (let i = 0; i < one.length; i += 4) {
          for (let c = 0; c < 3; c++) noiseSquares[i + c] += (one[i + c] - full.merged[i + c]) ** 2;
          onePassAlphaMaximumDifference = Math.max(onePassAlphaMaximumDifference, Math.abs(one[i + 3] - full.merged[i + 3]));
        }
      }
      const noise = Float32Array.from(noiseSquares, (sum, i) => i % 4 === 3 ? 1 : Math.sqrt(sum / NOISE_PASSES));
      if (onePassAlphaMaximumDifference !== 0) throw new Error(`${scene.name}: A varied across one-pass seeds`);
      if (RUN_LABEL === 'before-a' && displayScales.noise.scale === null) {
        displayScales.noise.scale = imageScale([noise], NOISE_DISPLAY_QUANTILE, true);
      }
      if (!Number.isFinite(displayScales.scan.scale) || !Number.isFinite(displayScales.structure.scale)
        || !Number.isFinite(displayScales.noise.scale) || displayScales.scan.scale <= 0
        || displayScales.structure.scale <= 0 || displayScales.noise.scale <= 0) {
        throw new Error(`${scene.name}: invalid before-a display scales`);
      }

      writeFloats(path.join(dir, `structure-${PASSES}.rgba.f32`), structure);
      writeFloats(path.join(dir, `structure-half-difference-${PASSES}.rgba.f32`), structureHalfDifference);
      writeFloats(path.join(dir, `band-sum-${PASSES}.rgba.f32`), full.bandSum);
      writeFloats(path.join(dir, `merged-${PASSES}.rgba.f32`), full.merged);
      writeFloats(path.join(dir, `noise-rms-${PASSES}.rgba.f32`), noise);
      for (const image of scanImages) {
        image.f32 = `scan-${image.id}.rgba.f32`;
        image.png = `scan-${image.id}.signed.png`;
        writeFloats(path.join(dir, image.f32), image.values);
        writeFileSync(path.join(dir, image.png), signedPng(image.values, displayScales.scan.scale));
      }

      await lab.setWhiteNoisePass(null);
      await lab.setSeed(seedOf(0));
      await lab.setTier(TIER);
      await lab.setStageRange('all');
      await lab.setUpsampleAlphaOne(false);
      await lab.render();
      const oneCorrection = await lab.readFloat('correction', 4);
      writeFileSync(path.join(dir, 'one-pass-correction.png'), await lab.signedCorrectionPng(
        { width: WIDTH, height: HEIGHT, rgba: oneCorrection }));
      writeFileSync(path.join(dir, 'one-pass-diffuse-clay.png'), await clayPng(lab));
      await mergedOf(lab, mean);
      await lab.setUpsampleAlphaOne(true);
      await lab.render();
      const convergedCorrection = await lab.readFloat('correction', 4);
      writeFileSync(path.join(dir, `mean-${PASSES}-correction.png`), await lab.signedCorrectionPng(
        { width: WIDTH, height: HEIGHT, rgba: convergedCorrection }));
      writeFileSync(path.join(dir, `mean-${PASSES}-diffuse-clay.png`), await clayPng(lab));
      await lab.setTier({ ...TIER, bandCount: 1 });
      await lab.render();
      await lab.writePackedBands(0, full.bandSum);
      await lab.setStageRange('chain');
      await lab.setUpsampleAlphaOne(true);
      await lab.render();
      const bypassCorrection = await lab.readFloat('correction', 4);
      writeFileSync(path.join(dir, `bypass-mean-${PASSES}-correction.png`), await lab.signedCorrectionPng(
        { width: WIDTH, height: HEIGHT, rgba: bypassCorrection }));
      writeFileSync(path.join(dir, `bypass-mean-${PASSES}-diffuse-clay.png`), await clayPng(lab));
      await lab.setUpsampleAlphaOne(false);
      await lab.setStageRange('all');

      const rois = Object.fromEntries(Object.entries(scene.rois).map(([name, rect]) => {
        const structureRms = rms(structure, rect);
        const residualRms = rms(structureHalfDifference, rect) / 2;
        return [name, { rect, structureRms, residualRms,
          residualToStructureRatio: residualRms / Math.max(structureRms, 1e-12),
          noiseRms: rms(noise, rect), signalRms: rms(full.bandSum, rect) }];
      }));
      writeFileSync(path.join(dir, 'display-scales.json'), JSON.stringify(displayScales, null, 2));
      writeFileSync(path.join(dir, `structure-${PASSES}.png`), signedPng(structure, displayScales.structure.scale));
      writeFileSync(path.join(dir, `structure-half-difference-${PASSES}.png`),
        signedPng(structureHalfDifference, displayScales.structure.scale));
      writeFileSync(path.join(dir, `noise-rms-${PASSES}.png`), magnitudePng(noise, displayScales.noise.scale));
      writeFileSync(path.join(dir, 'rois.png'), roisPng(full.bandSum, scene.rois, displayScales.scan.scale));

      const outputs = [
        'one-pass-a.f32', 'display-scales.json', `structure-${PASSES}.rgba.f32`,
        `structure-half-difference-${PASSES}.rgba.f32`, `band-sum-${PASSES}.rgba.f32`, `merged-${PASSES}.rgba.f32`,
        `noise-rms-${PASSES}.rgba.f32`, `structure-${PASSES}.png`, `structure-half-difference-${PASSES}.png`,
        `noise-rms-${PASSES}.png`, 'rois.png', 'one-pass-correction.png', 'one-pass-diffuse-clay.png',
        `mean-${PASSES}-correction.png`, `mean-${PASSES}-diffuse-clay.png`,
        `bypass-mean-${PASSES}-correction.png`, `bypass-mean-${PASSES}-diffuse-clay.png`,
        ...scanImages.flatMap((image) => [image.f32, image.png]),
      ];
      if (existsSync(path.join(dir, 'rois-on-render.png'))) outputs.push('rois-on-render.png');
      const result = {
        scene: scene.name, run: RUN_LABEL, caseName: scene.caseName, shot: scene.shot,
        scanSourceSignature: COMMON_SIGNATURE, sceneSourceSignature: sceneSourceSignatures.get(scene.name),
        cacheKey: cacheKeys.get(scene.name), cache: { path: path.relative(OUTPUT, cache).replaceAll('\\', '/'),
          hits: cacheHits, misses: cacheMisses, totalChunks: Math.ceil(PASSES / CHUNK_PASSES) },
        captureCommand: `node tools/render-lab-screen-space-chain-metrics.mjs --run=${RUN_LABEL} --scene=${scene.name} --passes=${PASSES}`,
        captureStartedAt: sceneStartedAt, captureWallTimeMs: performance.now() - sceneStarted,
        conditions: captureConditions(), exposure, blueNoiseSeed: seedOf(0),
        whiteNoise: { onePassInvariantPass: INVARIANT_PASS, convergedPassIndices: [0, PASSES - 1],
          noisePassIndices: [NOISE_FIRST_PASS, NOISE_FIRST_PASS + NOISE_PASSES - 1] },
        onePassBandSum: sumInvariant,
        onePassInvariantAlphaMaximumDifference: invariantAlphaMaximumDifference,
        onePassAlphaMaximumDifference: alphaMaximumDifference,
        onePassAlphaDifferentPixels: alphaDifferentPixels,
        onePassAlphaMeanAbsoluteDifference: alphaDifferenceSum / alpha.length,
        alphaChangeFromRgb, alphaVariationAcrossNoisePasses: onePassAlphaMaximumDifference,
        displayScales, rois, scanImages: scanImages.map(({ id, label, png, f32 }) => ({ id, label, png, f32 })), outputs,
      };
      runRecord.scenes[scene.name] = result;
      recordSnapshot();
      completed = true;
      console.log(`${scene.name}: ${cacheHits.length} cache hits, ${cacheMisses.length} misses; ${result.captureWallTimeMs.toFixed(0)} ms`);
    });
  } catch (error) {
    if (error?.code !== 'EPERM' || !completed) throw error;
    console.warn(`${scene.name}: outputs and record saved; Chrome profile cleanup returned EPERM`);
  }
}

runRecord.lastInvocation = {
  command: `node tools/render-lab-screen-space-chain-metrics.mjs ${process.argv.slice(2).join(' ')}`,
  startedAt: invocationStartedAt, finishedAt: new Date().toISOString(),
  wallTimeMs: performance.now() - invocationStart, scenes: scenes.map(({ name }) => name),
};
recordSnapshot();
writeIndex();
