// 手順8-15の帯鎖を、走査解像度の構造誤差と1パス雑音に分けて撮る。
// 帯ごとの標準偏差(輝点の探索)・画素ごとの最大偏差・帯ごとの1パス・seed 違いの1パスの補正項も同じ撮影で書く。
// 使い方: node tools/render-lab-screen-space-chain-metrics.mjs --run=<label> [--baseline=<label>] [--scene=<name>]
//   [--passes=1024|2048|4096] [--band-scale=<κ_o>] [--factors=kb=0.6,b.d=1,b.a=0.5,o.d=1] [--occlusion-invariant]
//   [--dry-run | --reindex | --cache-only]
// --factors は帯座標の因子の組(書式は screen-space-chain-factors.mjs)。--cache-only は撮影済みの run の収束の積算のキャッシュに
// 足りない和・二乗の和だけを撮り足して標準偏差の帯を書く(ほかの出力と記録は触らない)。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { encodeRgbPng } from './png.mjs';
import { captureBandSumInvariant, invariantMapOf } from './screen-space-band-sum-invariant.mjs';
import { BAND_COUNT, bandScaleOf, readBands, scaleOfBands, stdBandsOfCache, writeConvergedStdBands, writeOnePassBands } from './screen-space-chain-bands.mjs';
import { cachedMean, chunkComplete, chunkFile } from './screen-space-chain-cache.mjs';
import { accumulateMaxDeviation, deviationStatsOf, rgbaOfScalar, roiRms } from './screen-space-chain-deviation.mjs';
import { parseFactors, TIER_FACTORS_FIELD } from './screen-space-chain-factors.mjs';
import { ONE_PASS_CORRECTION_SEEDS, writeLandingIndex, writeRunIndex } from './screen-space-chain-index.mjs';
import { BASELINE_RUN, OUTPUT, RUNS, SCAN_HEIGHT, SCAN_PIXELS as PIXELS, SCAN_WIDTH, signedPng, signedRgb } from './screen-space-chain-runs.mjs';
import { CHUNK_PASSES, SCENES, sceneSignatureOf, sourceSignatureOf, tierOf } from './screen-space-chain-setup.mjs';
import { HEIGHT, readFloats, seedOf, unpackedBand, WIDTH, withLab, writeFloats } from './screen-space-lab.mjs';

// 帯和の検査は、閾値に乗った画素の孤立した反転を通し、系統差(超過画素が多い・平均や最大が大きい)だけを止める。
const INVARIANT_MAX_EXCEEDED_PIXEL_FRACTION = 0.001;
const INVARIANT_MAX_MEAN_ABSOLUTE = 1e-4;
const INVARIANT_MAX_ABSOLUTE = 0.01;
const NOISE_PASSES = 32;
const NOISE_FIRST_PASS = 5000;
const INVARIANT_PASS = 7000;
const SCAN_DISPLAY_QUANTILE = 0.999;
const STRUCTURE_DISPLAY_QUANTILE = 0.999;
const NOISE_DISPLAY_QUANTILE = 0.995;

const argumentOf = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const bandScale = argumentOf('band-scale') === undefined ? 0.75 : Number(argumentOf('band-scale'));
if (!Number.isFinite(bandScale) || bandScale < 0) throw new Error('--band-scale must be finite and nonnegative');
const FACTORS = argumentOf('factors') === undefined ? null : parseFactors(argumentOf('factors'), bandScale);
const TIER = tierOf(bandScale, FACTORS);
const PASSES = argumentOf('passes') === undefined ? 1024 : Number(argumentOf('passes'));
if (![1024, 2048, 4096].includes(PASSES)) throw new Error('--passes must be 1024, 2048, or 4096');
const RUN_LABEL = argumentOf('run');
if (RUN_LABEL === undefined) throw new Error('usage: node tools/render-lab-screen-space-chain-metrics.mjs --run=<label> [--baseline=<label>] [--scene=<name>] [--factors=...] [--occlusion-invariant] [--dry-run|--reindex|--cache-only]');
if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(RUN_LABEL)) throw new Error('--run must be a safe lowercase label (letters, digits, hyphens)');
const BASELINE_LABEL = argumentOf('baseline') ?? BASELINE_RUN;
if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(BASELINE_LABEL)) throw new Error('--baseline must be a safe lowercase label');
const DRY_RUN = process.argv.includes('--dry-run');
const REINDEX = process.argv.includes('--reindex');
const CACHE_ONLY = process.argv.includes('--cache-only');
const OCCLUSION_INVARIANT = process.argv.includes('--occlusion-invariant');
if ([DRY_RUN, REINDEX, CACHE_ONLY].filter(Boolean).length > 1) throw new Error('--dry-run, --reindex and --cache-only are exclusive');
const INVARIANT_FAILURES = path.join(OUTPUT, 'invariant-failures');
const scenes = argumentOf('scene') === undefined ? SCENES : SCENES.filter(({ name }) => name === argumentOf('scene'));
if (scenes.length === 0) throw new Error(`unknown scene: ${argumentOf('scene')}`);
const RUN_DIR = path.join(RUNS, RUN_LABEL);
const RUN_RECORD = path.join(RUN_DIR, 'record.json');
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

// 因子の欄は TIER に指定されたときだけ入るので、因子なしの run の鍵・署名・条件は因子の導入前と変わらない。
const runRecord = existingRunRecord() ?? {
  schema: 2, run: RUN_LABEL, createdAt: new Date().toISOString(),
  scanSourceSignature: COMMON_SIGNATURE, conditions: captureConditions(), scenes: {},
};

function cacheDirOf(scene) {
  return path.join(OUTPUT, 'cache', scene.name, cacheKeys.get(scene.name));
}

function validChunks(scene, kind) {
  let count = 0;
  for (let first = 0; first < PASSES; first += CHUNK_PASSES) if (chunkComplete(cacheDirOf(scene), first, kind)) count++;
  return count;
}

if (DRY_RUN) {
  console.log(JSON.stringify({ run: RUN_LABEL, baseline: BASELINE_LABEL, scanSourceSignature: COMMON_SIGNATURE, passes: PASSES, chunkPasses: CHUNK_PASSES,
    scenes: scenes.map((scene) => ({ name: scene.name, sceneSourceSignature: sceneSourceSignatures.get(scene.name),
      cacheKey: cacheKeys.get(scene.name), validChunks: validChunks(scene, 'sum'), validSquaresChunks: validChunks(scene, 'sumsq'),
      totalChunks: Math.ceil(PASSES / CHUNK_PASSES) })) }, null, 2));
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

// 候補どうしで違ってよい条件(κ と因子の組)を除いた条件。
function sharedConditionsOf(conditions) {
  const shared = structuredClone(conditions);
  delete shared.tier.bandScale;
  delete shared.tier[TIER_FACTORS_FIELD];
  return shared;
}

function rgbDifference(a, b) {
  const result = new Float32Array(a.length);
  for (let i = 0; i < result.length; i += 4) {
    for (let c = 0; c < 3; c++) result[i + c] = a[i + c] - b[i + c];
    result[i + 3] = 1;
  }
  return result;
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

const alphaMap = (merged) => Float32Array.from({ length: PIXELS }, (_, p) => merged[p * 4 + 3]);

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

function writeIndexes() {
  writeRunIndex(RUN_DIR, runRecord, PASSES, BASELINE_LABEL);
  writeLandingIndex();
}

if (REINDEX) {
  if (!existsSync(RUN_RECORD)) throw new Error(`run has no record.json: ${RUN_DIR}`);
  for (const scene of Object.values(runRecord.scenes)) {
    writeFileSync(path.join(RUN_DIR, scene.scene, 'metrics.json'), JSON.stringify(scene, null, 2));
  }
  writeIndexes();
  process.exit(0);
}
if (CACHE_ONLY && !existsSync(RUN_RECORD)) throw new Error(`--cache-only needs an existing run: ${RUN_DIR}`);

if (!CACHE_ONLY) mkdirSync(RUN_DIR, { recursive: true });
const invocationStartedAt = new Date().toISOString();
const invocationStart = performance.now();

function baselineSceneOf(scene) {
  if (RUN_LABEL === BASELINE_LABEL) return null;
  const baselineRecordPath = path.join(RUNS, BASELINE_LABEL, 'record.json');
  if (!existsSync(baselineRecordPath)) throw new Error(`${BASELINE_LABEL} baseline is required before run ${RUN_LABEL}`);
  const baselineRecord = JSON.parse(readFileSync(baselineRecordPath, 'utf8'));
  if (JSON.stringify(sharedConditionsOf(baselineRecord.conditions)) !== JSON.stringify(sharedConditionsOf(captureConditions()))) {
    throw new Error(`${BASELINE_LABEL} baseline conditions do not match run ${RUN_LABEL}`);
  }
  const baselineScene = baselineRecord.scenes?.[scene.name];
  if (!baselineScene) throw new Error(`${BASELINE_LABEL} baseline scene is missing: ${scene.name}`);
  return baselineScene;
}

// 収束の積算のキャッシュに足りないチャンクを撮って埋め、{ hits, misses } を返す。和か二乗の和の片方だけが無いチャンクは、
// 無い方のファイルだけを書く(既にある和は書き換えない)。
async function fillCache(lab, scene, cache) {
  const hits = [], misses = [];
  for (let first = 0; first < PASSES; first += CHUNK_PASSES) {
    const needSums = !chunkComplete(cache, first), needSquares = !chunkComplete(cache, first, 'sumsq');
    if (!needSums && !needSquares) {
      hits.push(first);
      continue;
    }
    misses.push(first);
    await lab.accumulateWhitePasses(first, CHUNK_PASSES);
    const taken = await lab.takePassSums(needSquares);
    const writeSums = (kind, halves) => {
      for (let texture = 0; texture < 3; texture++) {
        const even = halves[0][texture], odd = halves[1][texture];
        writeFloats(chunkFile(cache, first, texture, kind), Float32Array.from(even, (value, i) => value + odd[i]));
      }
    };
    if (needSums) writeSums('sum', taken.sums);
    if (needSquares) writeSums('sumsq', taken.squares);
    console.log(`${scene.name}: cached scan passes ${first}–${first + CHUNK_PASSES - 1}`);
  }
  return { hits, misses };
}

// 1パスの A の検査(帯和検査・基準・帯 RGB の変更に対する不変)。mergedOne は seed 0 の1パス。
async function alphaChecks(lab, scene, dir, mergedOne, invariantMergedOne) {
  const alpha = alphaMap(mergedOne);
  const invariantAlpha = alphaMap(invariantMergedOne);
  let invariantAlphaMaximumDifference = 0;
  for (let p = 0; p < alpha.length; p++) {
    invariantAlphaMaximumDifference = Math.max(invariantAlphaMaximumDifference, Math.abs(invariantAlpha[p] - alpha[p]));
  }
  if (invariantAlphaMaximumDifference !== 0) {
    throw new Error(`${scene.name}: A changed between invariant and display seeds: ${invariantAlphaMaximumDifference}`);
  }
  const baselineFile = path.join(RUN_LABEL === BASELINE_LABEL ? dir : path.join(RUNS, BASELINE_LABEL, scene.name), 'one-pass-a.f32');
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
  return { invariantAlphaMaximumDifference, alphaMaximumDifference, alphaDifferentPixels,
    alphaMeanAbsoluteDifference: alphaDifferenceSum / alpha.length, alphaChangeFromRgb };
}

// 独立な NOISE_PASSES 個の1パスと収束した合流 convergedMerged の差。画素ごとの RMS(noise)と最大偏差(maxima)、A の変動。
async function measureNoise(lab, convergedMerged) {
  const noiseSquares = new Float64Array(PIXELS * 4);
  const maxima = new Float32Array(PIXELS);
  let alphaVariation = 0;
  await lab.setStageRange('all');
  for (let pass = NOISE_FIRST_PASS; pass < NOISE_FIRST_PASS + NOISE_PASSES; pass++) {
    await lab.setWhiteNoisePass(pass);
    await lab.render();
    const one = await lab.readFloat('merged-0', 4);
    for (let i = 0; i < one.length; i += 4) {
      for (let c = 0; c < 3; c++) noiseSquares[i + c] += (one[i + c] - convergedMerged[i + c]) ** 2;
      alphaVariation = Math.max(alphaVariation, Math.abs(one[i + 3] - convergedMerged[i + 3]));
    }
    accumulateMaxDeviation(maxima, one, convergedMerged);
  }
  const noise = Float32Array.from(noiseSquares, (sum, i) => i % 4 === 3 ? 1 : Math.sqrt(sum / NOISE_PASSES));
  return { noise, maxima, alphaVariation };
}

// 表示の尺度。基準の run は、記録があればそれを使い、無い(または新しい欄が無い)ものを撮影した値から決める。
// 候補は基準の記録を使う。scale が null の欄は基準の撮影で埋める。
function displayScalesOf(scene, scanImages, structure) {
  const baselineScaleFile = path.join(RUNS, BASELINE_LABEL, scene.name, 'display-scales.json');
  const exists = existsSync(baselineScaleFile);
  if (RUN_LABEL !== BASELINE_LABEL && !exists) throw new Error(`${scene.name}: ${BASELINE_LABEL} display scales are missing`);
  const scales = exists ? JSON.parse(readFileSync(baselineScaleFile, 'utf8')) : {
    scan: { quantile: SCAN_DISPLAY_QUANTILE, scale: imageScale(scanImages.map(({ values }) => values), SCAN_DISPLAY_QUANTILE) },
    structure: { quantile: STRUCTURE_DISPLAY_QUANTILE, scale: imageScale([structure], STRUCTURE_DISPLAY_QUANTILE) },
    noise: { quantile: NOISE_DISPLAY_QUANTILE, scale: null },
  };
  if (scales.maxDeviation === undefined) {
    if (RUN_LABEL !== BASELINE_LABEL) throw new Error(`${scene.name}: ${BASELINE_LABEL} display scales lack maxDeviation; recapture ${BASELINE_LABEL}`);
    scales.maxDeviation = { quantile: NOISE_DISPLAY_QUANTILE, scale: null };
  }
  return scales;
}

function checkedScales(scene, scales) {
  for (const { scale } of [scales.scan, scales.structure, scales.noise, scales.maxDeviation]) {
    if (!Number.isFinite(scale) || scale <= 0) throw new Error(`${scene.name}: invalid ${BASELINE_LABEL} display scales`);
  }
}

// 1パス(白色雑音なし、ブルーノイズ)の補正項を、seed 0 と ONE_PASS_CORRECTION_SEEDS の seed で撮って dir へ。
// 終わると seed 0 で描き直した状態になる。
async function captureOnePassCorrections(lab, dir) {
  await lab.setWhiteNoisePass(null);
  await lab.setTier(TIER);
  await lab.setStageRange('all');
  await lab.setUpsampleAlphaOne(false);
  for (const k of [0, ...ONE_PASS_CORRECTION_SEEDS]) {
    await lab.setSeed(seedOf(k));
    await lab.render();
    const name = k === 0 ? 'one-pass-correction.png' : `one-pass-correction-seed${k}.png`;
    writeFileSync(path.join(dir, name), await lab.signedCorrectionPng({ width: WIDTH, height: HEIGHT, rgba: await lab.readFloat('correction', 4) }));
    if (k === 0) writeFileSync(path.join(dir, 'one-pass-diffuse-clay.png'), await clayPng(lab));
  }
  await lab.setSeed(seedOf(0));
  await lab.render();
}

// 収束した4帯の平均 mean から、収束平均・帯合計迂回の補正項とクレイを dir へ。
async function captureConvergedCorrections(lab, dir, mean, bandSum) {
  const correctionPng = async () => lab.signedCorrectionPng({ width: WIDTH, height: HEIGHT, rgba: await lab.readFloat('correction', 4) });
  await mergedOf(lab, mean);
  await lab.setUpsampleAlphaOne(true);
  await lab.render();
  writeFileSync(path.join(dir, `mean-${PASSES}-correction.png`), await correctionPng());
  writeFileSync(path.join(dir, `mean-${PASSES}-diffuse-clay.png`), await clayPng(lab));
  await lab.setTier({ ...TIER, bandCount: 1 });
  await lab.render();
  await lab.writePackedBands(0, bandSum);
  await lab.setStageRange('chain');
  await lab.setUpsampleAlphaOne(true);
  await lab.render();
  writeFileSync(path.join(dir, `bypass-mean-${PASSES}-correction.png`), await correctionPng());
  writeFileSync(path.join(dir, `bypass-mean-${PASSES}-diffuse-clay.png`), await clayPng(lab));
  await lab.setUpsampleAlphaOne(false);
  await lab.setStageRange('all');
}

async function captureScene(lab, scene, dir, cache) {
  baselineSceneOf(scene);
  const sceneStartedAt = new Date().toISOString();
  const sceneStarted = performance.now();
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
  const onePassBands = await readBands(lab);
  const alphaResult = await alphaChecks(lab, scene, dir, mergedOne, invariantMergedOne);

  const { hits: cacheHits, misses: cacheMisses } = await fillCache(lab, scene, cache);
  const mean = cachedMean(cache, 0, PASSES);
  for (const [index, packed] of mean.entries()) writeFloats(path.join(cache, `mean-${PASSES}-packed-${index}.f32`), packed);
  const stdBands = stdBandsOfCache(cache, PASSES);
  const full = await mergedOf(lab, mean);
  const structure = rgbDifference(full.bandSum, full.merged);
  const firstHalf = await mergedOf(lab, cachedMean(cache, 0, PASSES / 2));
  const secondHalf = await mergedOf(lab, cachedMean(cache, PASSES / 2, PASSES));
  const structureHalfDifference = rgbDifference(
    rgbDifference(firstHalf.bandSum, firstHalf.merged),
    rgbDifference(secondHalf.bandSum, secondHalf.merged));

  const scanImages = [
    { id: 'one-pass-band-sum', label: '1パス・4帯合計 (seed 0)', values: bandOne },
    { id: 'one-pass-merged', label: '1パス・合流結果 (seed 0)', values: mergedOne },
    { id: 'converged-band-sum', label: `${PASSES}パス・4帯合計`, values: full.bandSum },
    { id: 'converged-merged', label: `${PASSES}パス・合流結果`, values: full.merged },
  ];
  const displayScales = displayScalesOf(scene, scanImages, structure);
  const { noise, maxima, alphaVariation } = await measureNoise(lab, full.merged);
  if (alphaVariation !== 0) throw new Error(`${scene.name}: A varied across one-pass seeds`);
  const maxDeviation = rgbaOfScalar(maxima);
  if (RUN_LABEL === BASELINE_LABEL) {
    displayScales.noise.scale ??= imageScale([noise], NOISE_DISPLAY_QUANTILE, true);
    displayScales.maxDeviation.scale ??= imageScale([maxDeviation], displayScales.maxDeviation.quantile, true);
  }
  checkedScales(scene, displayScales);

  const bandScaleHere = RUN_LABEL === BASELINE_RUN
    ? scaleOfBands(Array.from({ length: BAND_COUNT }, (_, band) => unpackedBand(mean, band))) : bandScaleOf(scene.name);
  writeOnePassBands(RUN_LABEL, scene.name, onePassBands, bandScaleHere, bandOne);
  writeFloats(path.join(dir, `structure-${PASSES}.rgba.f32`), structure);
  writeFloats(path.join(dir, `structure-half-difference-${PASSES}.rgba.f32`), structureHalfDifference);
  writeFloats(path.join(dir, `band-sum-${PASSES}.rgba.f32`), full.bandSum);
  writeFloats(path.join(dir, `merged-${PASSES}.rgba.f32`), full.merged);
  writeFloats(path.join(dir, `noise-rms-${PASSES}.rgba.f32`), noise);
  writeFloats(path.join(dir, `max-deviation-${PASSES}.rgba.f32`), maxDeviation);
  for (const image of scanImages) {
    image.f32 = `scan-${image.id}.rgba.f32`;
    image.png = `scan-${image.id}.signed.png`;
    writeFloats(path.join(dir, image.f32), image.values);
    writeFileSync(path.join(dir, image.png), signedPng(image.values, 4, displayScales.scan.scale));
  }

  await captureOnePassCorrections(lab, dir);
  await captureConvergedCorrections(lab, dir, mean, full.bandSum);

  const rois = Object.fromEntries(Object.entries(scene.rois).map(([name, rect]) => {
    const structureRms = roiRms(structure, 4, rect);
    const residualRms = roiRms(structureHalfDifference, 4, rect) / 2;
    return [name, { rect, structureRms, residualRms,
      residualToStructureRatio: residualRms / Math.max(structureRms, 1e-12),
      noiseRms: roiRms(noise, 4, rect), signalRms: roiRms(full.bandSum, 4, rect),
      maxDeviation: deviationStatsOf(noise, maxima, rect), bandStdRms: stdBands.map((band) => roiRms(band, 3, rect)) }];
  }));
  writeFileSync(path.join(dir, 'display-scales.json'), JSON.stringify(displayScales, null, 2));
  writeFileSync(path.join(dir, `structure-${PASSES}.png`), signedPng(structure, 4, displayScales.structure.scale));
  writeFileSync(path.join(dir, `structure-half-difference-${PASSES}.png`), signedPng(structureHalfDifference, 4, displayScales.structure.scale));
  writeFileSync(path.join(dir, `noise-rms-${PASSES}.png`), magnitudePng(noise, displayScales.noise.scale));
  writeFileSync(path.join(dir, `max-deviation-${PASSES}.png`), magnitudePng(maxDeviation, displayScales.maxDeviation.scale));
  writeFileSync(path.join(dir, 'rois.png'), roisPng(full.bandSum, scene.rois, displayScales.scan.scale));

  const outputs = [
    'metrics.json', 'one-pass-a.f32', 'display-scales.json', `structure-${PASSES}.rgba.f32`,
    `structure-half-difference-${PASSES}.rgba.f32`, `band-sum-${PASSES}.rgba.f32`, `merged-${PASSES}.rgba.f32`,
    `noise-rms-${PASSES}.rgba.f32`, `max-deviation-${PASSES}.rgba.f32`, `structure-${PASSES}.png`,
    `structure-half-difference-${PASSES}.png`, `noise-rms-${PASSES}.png`, `max-deviation-${PASSES}.png`, 'rois.png',
    'one-pass-correction.png', ...ONE_PASS_CORRECTION_SEEDS.map((seed) => `one-pass-correction-seed${seed}.png`),
    'one-pass-diffuse-clay.png', `mean-${PASSES}-correction.png`, `mean-${PASSES}-diffuse-clay.png`,
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
      + (BASELINE_LABEL === BASELINE_RUN ? '' : ` --baseline=${BASELINE_LABEL}`)
      + (argumentOf('band-scale') === undefined ? '' : ` --band-scale=${bandScale}`)
      + (argumentOf('factors') === undefined ? '' : ` --factors=${argumentOf('factors')}`),
    captureStartedAt: sceneStartedAt, captureWallTimeMs: performance.now() - sceneStarted,
    conditions: captureConditions(), exposure, blueNoiseSeed: seedOf(0),
    whiteNoise: { onePassInvariantPass: INVARIANT_PASS, convergedPassIndices: [0, PASSES - 1],
      noisePassIndices: [NOISE_FIRST_PASS, NOISE_FIRST_PASS + NOISE_PASSES - 1] },
    onePassBandSum: sumInvariant, occlusionOnlyBandSum: occlusionBandSum,
    onePassInvariantAlphaMaximumDifference: alphaResult.invariantAlphaMaximumDifference,
    onePassAlphaMaximumDifference: alphaResult.alphaMaximumDifference,
    onePassAlphaDifferentPixels: alphaResult.alphaDifferentPixels,
    onePassAlphaMeanAbsoluteDifference: alphaResult.alphaMeanAbsoluteDifference,
    alphaChangeFromRgb: alphaResult.alphaChangeFromRgb, alphaVariationAcrossNoisePasses: alphaVariation,
    displayScales, rois, scanImages: scanImages.map(({ id, label, png, f32 }) => ({ id, label, png, f32 })), outputs,
  };
  writeFileSync(path.join(dir, 'metrics.json'), JSON.stringify(result, null, 2));
  runRecord.scenes[scene.name] = result;
  recordSnapshot();
  writeConvergedStdBands(RUN_LABEL, scene.name);
  console.log(`${scene.name}: ${cacheHits.length} cache hits, ${cacheMisses.length} misses; ${result.captureWallTimeMs.toFixed(0)} ms`);
}

// --cache-only: 記録済みの run のキャッシュの不足を埋める。
async function fillCacheOnly(lab, scene, cache) {
  await lab.show({ caseName: scene.caseName, shot: scene.shot, mode: 2, set: 'tuning', key: scene.name });
  await lab.setUpsampleAlphaOne(false);
  await lab.setTier(TIER);
  await lab.setWhiteNoisePass(null);
  await lab.setSeed(seedOf(0));
  await lab.render();
  const { hits, misses } = await fillCache(lab, scene, cache);
  console.log(`${scene.name}: ${hits.length} cache hits, ${misses.length} misses`);
}

for (const scene of scenes) {
  const dir = path.join(RUN_DIR, scene.name);
  const cache = cacheDirOf(scene);
  if (!CACHE_ONLY) mkdirSync(dir, { recursive: true });
  mkdirSync(cache, { recursive: true });
  let completed = false;
  try {
    await withLab(async (lab) => {
      if (CACHE_ONLY) await fillCacheOnly(lab, scene, cache);
      else await captureScene(lab, scene, dir, cache);
      completed = true;
    });
  } catch (error) {
    if (error?.code !== 'EPERM' || !completed) throw error;
    console.warn(`${scene.name}: outputs and record saved; Chrome profile cleanup returned EPERM`);
  }
  if (CACHE_ONLY && writeConvergedStdBands(RUN_LABEL, scene.name) === null) console.warn(`${scene.name}: standard deviation bands were not written`);
}

if (!CACHE_ONLY) {
  runRecord.lastInvocation = {
    command: `node tools/render-lab-screen-space-chain-metrics.mjs ${process.argv.slice(2).join(' ')}`,
    startedAt: invocationStartedAt, finishedAt: new Date().toISOString(),
    wallTimeMs: performance.now() - invocationStart, scenes: scenes.map(({ name }) => name),
  };
  recordSnapshot();
  writeIndexes();
}
