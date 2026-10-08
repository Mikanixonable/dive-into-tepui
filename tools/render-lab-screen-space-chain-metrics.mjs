// 手順8-15の帯鎖を、走査解像度の構造誤差と1パス雑音に分けて撮る。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { encodeRgbPng } from './png.mjs';
import { captureBandSumInvariant, invariantMapOf } from './screen-space-band-sum-invariant.mjs';
import { escapeHtml, OUTPUT, RUNS, SCAN_HEIGHT, SCAN_PIXELS as PIXELS, SCAN_SCALE, SCAN_WIDTH, signedPng, signedRgb } from './screen-space-chain-runs.mjs';
import { CHUNK_PASSES, SCENES, sceneSignatureOf, sourceSignatureOf } from './screen-space-chain-setup.mjs';
import { HEIGHT, readFloats, seedOf, shotsDir, WIDTH, withLab, writeFloats } from './screen-space-lab.mjs';

// 帯和の検査は、閾値に乗った画素の孤立した反転を通し、系統差(超過画素が多い・平均や最大が大きい)だけを止める。
const INVARIANT_MAX_EXCEEDED_PIXEL_FRACTION = 0.001;
const INVARIANT_MAX_MEAN_ABSOLUTE = 1e-4;
const INVARIANT_MAX_ABSOLUTE = 0.01;
const NOISE_PASSES = 32;
const NOISE_FIRST_PASS = 5000;
const INVARIANT_PASS = 7000;
const bandScaleArgument = process.argv.find((arg) => arg.startsWith('--band-scale='));
const bandScale = bandScaleArgument === undefined ? 0.75 : Number(bandScaleArgument.slice('--band-scale='.length));
if (!Number.isFinite(bandScale) || bandScale < 0) throw new Error('--band-scale must be finite and nonnegative');
const TIER = { scale: SCAN_SCALE, sliceCount: 4, stepCount: 5, bandCount: 4, bandScale };
const SCAN_DISPLAY_QUANTILE = 0.999;
const STRUCTURE_DISPLAY_QUANTILE = 0.999;
const NOISE_DISPLAY_QUANTILE = 0.995;
const passesArgument = process.argv.find((arg) => arg.startsWith('--passes='));
const PASSES = passesArgument === undefined ? 1024 : Number(passesArgument.split('=')[1]);
if (![1024, 2048, 4096].includes(PASSES)) throw new Error('--passes must be 1024, 2048, or 4096');
const runArgument = process.argv.find((arg) => arg.startsWith('--run='));
if (runArgument === undefined) throw new Error('usage: node tools/render-lab-screen-space-chain-metrics.mjs --run=<label> [--baseline=<label>] [--scene=<name>] [--occlusion-invariant] [--dry-run|--reindex]');
const RUN_LABEL = runArgument.slice('--run='.length);
if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(RUN_LABEL)) throw new Error('--run must be a safe lowercase label (letters, digits, hyphens)');
const baselineArgument = process.argv.find((arg) => arg.startsWith('--baseline='));
const BASELINE_LABEL = baselineArgument === undefined ? 'before-a' : baselineArgument.slice('--baseline='.length);
if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(BASELINE_LABEL)) throw new Error('--baseline must be a safe lowercase label');
const DRY_RUN = process.argv.includes('--dry-run');
const REINDEX = process.argv.includes('--reindex');
const OCCLUSION_INVARIANT = process.argv.includes('--occlusion-invariant');
const INVARIANT_FAILURES = path.join(OUTPUT, 'invariant-failures');
if (DRY_RUN && REINDEX) throw new Error('--dry-run and --reindex are exclusive');
const sceneArgument = process.argv.find((arg) => arg.startsWith('--scene='));
const scenes = sceneArgument === undefined ? SCENES : SCENES.filter(({ name }) => name === sceneArgument.split('=')[1]);
if (scenes.length === 0) throw new Error(`unknown scene: ${sceneArgument}`);
const RUN_DIR = path.join(RUNS, RUN_LABEL);
const RUN_RECORD = path.join(RUN_DIR, 'record.json');
const RUN_INDEX = path.join(RUN_DIR, 'index.html');
const COMMON_SIGNATURE = sourceSignatureOf(TIER);
const sceneSourceSignatures = new Map(SCENES.map((scene) => [scene.name, sceneSignatureOf(scene, COMMON_SIGNATURE)]));
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
  console.log(JSON.stringify({ run: RUN_LABEL, baseline: BASELINE_LABEL, scanSourceSignature: COMMON_SIGNATURE, passes: PASSES, chunkPasses: CHUNK_PASSES,
    scenes: scenes.map((scene) => ({ name: scene.name, sceneSourceSignature: sceneSourceSignatures.get(scene.name),
      cacheKey: cacheKeys.get(scene.name), validChunks: validChunkCount(scene), totalChunks: Math.ceil(PASSES / CHUNK_PASSES) })) }, null, 2));
  process.exit(0);
}

function cacheKeyOf(scene) {
  return createHash('sha256').update('ssd-8-15-chunk-cache-v2').update(sceneSourceSignatures.get(scene.name))
    .update(`chunkPasses:${CHUNK_PASSES}`).update(JSON.stringify(TIER)).digest('hex').slice(0, 16);
}

function captureConditions() {
  return { viewport: [WIDTH, HEIGHT], scanResolution: [SCAN_WIDTH, SCAN_HEIGHT], tier: TIER, passes: PASSES,
    chunkPasses: CHUNK_PASSES, invariantPass: INVARIANT_PASS,
    noisePasses: { first: NOISE_FIRST_PASS, count: NOISE_PASSES }, baselineLabel: BASELINE_LABEL };
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

// 帯和の不変条件を、白色雑音のパス INVARIANT_PASS で検査して差の地図を dir に書く。半精度の丸め幅を超える系統差があれば、
// 地図を INVARIANT_FAILURES に書いて投げる。label は遮蔽のみの検査を区別する地図の名前の添え字。
async function checkedBandSumInvariant(lab, scene, dir, label) {
  const { stats, difference } = await captureBandSumInvariant(lab, TIER, INVARIANT_PASS);
  const map = invariantMapOf(difference);
  const systematic = stats.roundingExceeded.pixelCount > PIXELS * INVARIANT_MAX_EXCEEDED_PIXEL_FRACTION
    || stats.meanAbsolute > INVARIANT_MAX_MEAN_ABSOLUTE || stats.maximumAbsolute > INVARIANT_MAX_ABSOLUTE;
  if (systematic) {
    mkdirSync(INVARIANT_FAILURES, { recursive: true });
    writeFileSync(path.join(INVARIANT_FAILURES, `${RUN_LABEL}-${scene.name}${label}.k${map.gain}.png`), map.png);
    throw new Error(`${scene.name}${label}: band sum differs from raw beyond half-float rounding: ${JSON.stringify(stats)}`);
  }
  const differenceMap = `band-sum-invariant-diff${label}.k${map.gain}.png`;
  writeFileSync(path.join(dir, differenceMap), map.png);
  return { ...stats, differenceMap };
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

// 帯和を signedPng の写像で描き、ROI の枠を1画素の白で重ねる。
function roisPng(bandSum, rois, scale) {
  const rgb = signedRgb(bandSum, 4, scale);
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
<h1>8-15 \u753b\u9762\u7a7a\u9593\u62e1\u6563 - ${escapeHtml(RUN_LABEL)}</h1><p>${PASSES} \u30d1\u30b9\u3002\u8d70\u67fb\u89e3\u50cf\u5ea6 ${SCAN_WIDTH}&times;${SCAN_HEIGHT}\u3002signed RGB \u306f\u7dda\u5f62\u5024\u3092\u7070\u8272\u4e2d\u5fc3\u3067\u8868\u793a\u3057\u3001\u5404\u5834\u9762\u3067 ${escapeHtml(BASELINE_LABEL)} \u306e\u56fa\u5b9a\u30b9\u30b1\u30fc\u30eb\u3092\u4f7f\u3044\u307e\u3059\u3002\u64ae\u5f71\u6761\u4ef6\u3068\u5168\u30b9\u30b1\u30fc\u30eb\u306f record.json \u306b\u8a18\u9332\u3057\u307e\u3059\u3002</p><nav>${navigation}</nav><main>${sections.join('\n')}</main></html>`);
}
function writeLandingIndex() {
  const labels = readdirSync(RUNS, { withFileTypes: true })
    .filter((item) => item.isDirectory() && existsSync(path.join(RUNS, item.name, 'record.json'))
      && existsSync(path.join(RUNS, item.name, 'index.html')))
    .map((item) => item.name).sort((a, b) => a === 'before-a' ? -1 : b === 'before-a' ? 1 : a.localeCompare(b));
  const links = labels.map((label) => `<li><a href="runs/${escapeHtml(label)}/index.html">${escapeHtml(label)}</a></li>`).join('\n');
  const legacy = existsSync(path.join(OUTPUT, 'archive', 'legacy-single-scene', 'index.html'))
    ? '<p><a href="archive/legacy-single-scene/index.html">整理前の単独撮影</a></p>' : '';
  const olderReference = existsSync(path.join(shotsDir, 'ssd-8-15-reference', 'index.html'))
    ? '<p><a href="../ssd-8-15-reference/index.html">初期の品質参照</a></p>' : '';
  const angledCase = existsSync(path.join(shotsDir, 'ssd-8-15-angled-v2', 'angled-bounce.png'))
    ? '<p><a href="../ssd-8-15-angled-v2/angled-bounce.png">角度付きケースの通常像</a></p>' : '';
  writeFileSync(path.join(OUTPUT, 'index.html'), `<!doctype html><html lang="ja"><meta charset="utf-8">
<title>8-15 帯鎖の撮影記録</title><h1>8-15 帯鎖の撮影記録</h1><p>候補aの実施前は before-a。以後の候補は別の記録に保存する。</p><ul>${links}</ul><h2>過去の診断</h2>${legacy}${olderReference}${angledCase}</html>`);
}

if (REINDEX) {
  if (!existsSync(RUN_RECORD)) throw new Error(`run has no record.json: ${RUN_DIR}`);
  for (const scene of Object.values(runRecord.scenes)) {
    writeFileSync(path.join(RUN_DIR, scene.scene, 'metrics.json'), JSON.stringify(scene, null, 2));
  }
  writeIndex();
  writeLandingIndex();
  process.exit(0);
}

mkdirSync(RUN_DIR, { recursive: true });
const invocationStartedAt = new Date().toISOString();
const invocationStart = performance.now();

function baselineSceneOf(scene) {
  if (RUN_LABEL === BASELINE_LABEL) return null;
  const baselineRecordPath = path.join(RUNS, BASELINE_LABEL, 'record.json');
  if (!existsSync(baselineRecordPath)) throw new Error(`${BASELINE_LABEL} baseline is required before run ${RUN_LABEL}`);
  const baselineRecord = JSON.parse(readFileSync(baselineRecordPath, 'utf8'));
  const baselineConditions = structuredClone(baselineRecord.conditions);
  const runConditions = captureConditions();
  baselineConditions.tier.bandScale = runConditions.tier.bandScale;
  if (JSON.stringify(baselineConditions) !== JSON.stringify(runConditions)) {
    throw new Error(`${BASELINE_LABEL} baseline conditions do not match run ${RUN_LABEL}`);
  }
  const baselineScene = baselineRecord.scenes?.[scene.name];
  if (!baselineScene) throw new Error(`${BASELINE_LABEL} baseline scene is missing: ${scene.name}`);
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
      let occlusionBandSum = null;
      if (OCCLUSION_INVARIANT && scene.hasOcclusionOnly !== false) {
        await lab.show({ caseName: scene.caseName, shot: scene.shot, mode: 1, set: 'tuning', key: scene.name });
        await lab.setUpsampleAlphaOne(false);
        occlusionBandSum = await checkedBandSumInvariant(lab, scene, dir, '-occlusion');
      }
      await lab.show({ caseName: scene.caseName, shot: scene.shot, mode: 2, set: 'tuning', key: scene.name });
      const exposure = await lab.exposureFactor();
      await lab.setUpsampleAlphaOne(false);
      const sumInvariant = await checkedBandSumInvariant(lab, scene, dir, '');
      const invariantMergedOne = await lab.readFloat('merged-0', 4);
      await lab.setWhiteNoisePass(null);
      await lab.setSeed(seedOf(0));
      await lab.render();
      const bandOne = await lab.readFloat('band-sum', 4);
      const mergedOne = await lab.readFloat('merged-0', 4);

      const alpha = alphaMap(mergedOne);
      const invariantAlpha = alphaMap(invariantMergedOne);
      let invariantAlphaMaximumDifference = 0;
      for (let p = 0; p < alpha.length; p++) {
        invariantAlphaMaximumDifference = Math.max(invariantAlphaMaximumDifference, Math.abs(invariantAlpha[p] - alpha[p]));
      }
      if (invariantAlphaMaximumDifference !== 0) {
        throw new Error(`${scene.name}: A changed between invariant and display seeds: ${invariantAlphaMaximumDifference}`);
      }
      const baselineFile = RUN_LABEL === BASELINE_LABEL
        ? path.join(dir, 'one-pass-a.f32')
        : path.join(RUNS, BASELINE_LABEL, scene.name, 'one-pass-a.f32');
      if (RUN_LABEL !== BASELINE_LABEL && !existsSync(baselineFile)) {
        throw new Error(`${scene.name}: ${BASELINE_LABEL} one-pass A file is missing`);
      }
      if (RUN_LABEL === BASELINE_LABEL && !existsSync(baselineFile)) writeFloats(baselineFile, alpha);
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
      const baselineScaleFile = path.join(RUNS, BASELINE_LABEL, scene.name, 'display-scales.json');
      let displayScales;
      if (RUN_LABEL === BASELINE_LABEL) {
        displayScales = existsSync(baselineScaleFile) ? JSON.parse(readFileSync(baselineScaleFile, 'utf8')) : {
          scan: { quantile: SCAN_DISPLAY_QUANTILE, scale: imageScale(scanImages.map(({ values }) => values), SCAN_DISPLAY_QUANTILE) },
          structure: { quantile: STRUCTURE_DISPLAY_QUANTILE, scale: imageScale([structure], STRUCTURE_DISPLAY_QUANTILE) },
          noise: { quantile: NOISE_DISPLAY_QUANTILE, scale: null },
        };
      } else {
        if (!existsSync(baselineScaleFile)) throw new Error(`${scene.name}: ${BASELINE_LABEL} display scales are missing`);
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
      if (RUN_LABEL === BASELINE_LABEL && displayScales.noise.scale === null) {
        displayScales.noise.scale = imageScale([noise], NOISE_DISPLAY_QUANTILE, true);
      }
      if (!Number.isFinite(displayScales.scan.scale) || !Number.isFinite(displayScales.structure.scale)
        || !Number.isFinite(displayScales.noise.scale) || displayScales.scan.scale <= 0
        || displayScales.structure.scale <= 0 || displayScales.noise.scale <= 0) {
        throw new Error(`${scene.name}: invalid ${BASELINE_LABEL} display scales`);
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
        writeFileSync(path.join(dir, image.png), signedPng(image.values, 4, displayScales.scan.scale));
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
      writeFileSync(path.join(dir, `structure-${PASSES}.png`), signedPng(structure, 4, displayScales.structure.scale));
      writeFileSync(path.join(dir, `structure-half-difference-${PASSES}.png`),
        signedPng(structureHalfDifference, 4, displayScales.structure.scale));
      writeFileSync(path.join(dir, `noise-rms-${PASSES}.png`), magnitudePng(noise, displayScales.noise.scale));
      writeFileSync(path.join(dir, 'rois.png'), roisPng(full.bandSum, scene.rois, displayScales.scan.scale));

      const outputs = [
        'metrics.json', 'one-pass-a.f32', 'display-scales.json', `structure-${PASSES}.rgba.f32`,
        `structure-half-difference-${PASSES}.rgba.f32`, `band-sum-${PASSES}.rgba.f32`, `merged-${PASSES}.rgba.f32`,
        `noise-rms-${PASSES}.rgba.f32`, `structure-${PASSES}.png`, `structure-half-difference-${PASSES}.png`,
        `noise-rms-${PASSES}.png`, 'rois.png', 'one-pass-correction.png', 'one-pass-diffuse-clay.png',
        `mean-${PASSES}-correction.png`, `mean-${PASSES}-diffuse-clay.png`,
        `bypass-mean-${PASSES}-correction.png`, `bypass-mean-${PASSES}-diffuse-clay.png`,
        ...scanImages.flatMap((image) => [image.f32, image.png]),
        sumInvariant.differenceMap, ...(occlusionBandSum === null ? [] : [occlusionBandSum.differenceMap]),
      ];
      if (existsSync(path.join(dir, 'rois-on-render.png'))) outputs.push('rois-on-render.png');
      const result = {
        scene: scene.name, run: RUN_LABEL, caseName: scene.caseName, shot: scene.shot,
        scanSourceSignature: COMMON_SIGNATURE, sceneSourceSignature: sceneSourceSignatures.get(scene.name),
        cacheKey: cacheKeys.get(scene.name), cache: { path: path.relative(OUTPUT, cache).replaceAll('\\', '/'),
          hits: cacheHits, misses: cacheMisses, totalChunks: Math.ceil(PASSES / CHUNK_PASSES) },
        captureCommand: `node tools/render-lab-screen-space-chain-metrics.mjs --run=${RUN_LABEL} --scene=${scene.name} --passes=${PASSES}`
          + (BASELINE_LABEL === 'before-a' ? '' : ` --baseline=${BASELINE_LABEL}`),
        captureStartedAt: sceneStartedAt, captureWallTimeMs: performance.now() - sceneStarted,
        conditions: captureConditions(), exposure, blueNoiseSeed: seedOf(0),
        whiteNoise: { onePassInvariantPass: INVARIANT_PASS, convergedPassIndices: [0, PASSES - 1],
          noisePassIndices: [NOISE_FIRST_PASS, NOISE_FIRST_PASS + NOISE_PASSES - 1] },
        onePassBandSum: sumInvariant, occlusionOnlyBandSum: occlusionBandSum,
        onePassInvariantAlphaMaximumDifference: invariantAlphaMaximumDifference,
        onePassAlphaMaximumDifference: alphaMaximumDifference,
        onePassAlphaDifferentPixels: alphaDifferentPixels,
        onePassAlphaMeanAbsoluteDifference: alphaDifferenceSum / alpha.length,
        alphaChangeFromRgb, alphaVariationAcrossNoisePasses: onePassAlphaMaximumDifference,
        displayScales, rois, scanImages: scanImages.map(({ id, label, png, f32 }) => ({ id, label, png, f32 })), outputs,
      };
      writeFileSync(path.join(dir, 'metrics.json'), JSON.stringify(result, null, 2));
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
writeLandingIndex();
