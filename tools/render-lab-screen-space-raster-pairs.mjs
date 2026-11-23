// 帯鎖の合流 M を、同じシード・同じ走査の代表でラスタのずれだけを独立に変えた 2 枚 A・B の対で積み、収束先と、ラスタ由来・
// シード由来の 1 パスの揺れを画素ごとに分けて撮る(手順22.5 の評価)。ラスタ由来の分散は E[(A − B)²] ÷ 2 で、対の中ではシードの揺れが打ち消し合う。
// 使い方: node tools/render-lab-screen-space-raster-pairs.mjs --run=<label> [--scene=<name>] [--pairs=1024]
//   [--band-count=8] [--band-scale=0.451]
// 出力は OUTPUT/pairs/<run>/<ケース>/ に、走査の解像度の rgba の float32(α は 1):
//   mean(A・B 全 2N 枚の平均)・mean-first / mean-second(前半・後半の対の平均。収束の残りの雑音の見積もり。偶奇で分けると
//   A のずれの Halton の基数 2 の成分の符号で分かれてしまう)・
//   raster-rms・total-rms・seed-rms(√max(0, total² − raster²))と、contour-mask.u8・surface-mask.u8。
// 対は CHUNK_PASSES 対ずつ cache/ へ書くので、落ちても続きから撮れる。ソースの署名か条件が記録と違えば止まる(run 名を変える)。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { contourMaskOf, maskPng, OUTPUT, SCAN_HEIGHT, SCAN_PIXELS, SCAN_WIDTH } from './screen-space-chain-runs.mjs';
import { CHUNK_PASSES, SCENES, sceneSignatureOf, sourceSignatureOf, tierOf } from './screen-space-chain-setup.mjs';
import { HEIGHT, readFloats, WIDTH, withLab, writeFloats } from './screen-space-lab.mjs';

const argumentOf = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const RUN_LABEL = argumentOf('run');
if (RUN_LABEL === undefined || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(RUN_LABEL)) {
  throw new Error('usage: node tools/render-lab-screen-space-raster-pairs.mjs --run=<label> [--scene=<name>] [--pairs=1024] [--band-count=8] [--band-scale=0.451]');
}
const PAIRS = Number(argumentOf('pairs') ?? 1024);
// 前半・後半を塊の境で分けるので、塊 2 つの倍数。
if (!Number.isInteger(PAIRS) || PAIRS <= 0 || PAIRS % (2 * CHUNK_PASSES) !== 0) throw new Error(`--pairs must be a multiple of ${2 * CHUNK_PASSES}`);
const TIER = tierOf(Number(argumentOf('band-scale') ?? 0.451), Number(argumentOf('band-count') ?? 8));
const scenes = argumentOf('scene') === undefined ? SCENES : SCENES.filter(({ name }) => name === argumentOf('scene'));
if (scenes.length === 0) throw new Error(`unknown scene: ${argumentOf('scene')}`);

const RUN_DIR = path.join(OUTPUT, 'pairs', RUN_LABEL);
const RECORD = path.join(RUN_DIR, 'record.json');
const SOURCE_SIGNATURE = sourceSignatureOf(TIER);
const CONDITIONS = { viewport: [WIDTH, HEIGHT], scanResolution: [SCAN_WIDTH, SCAN_HEIGHT], tier: TIER, pairs: PAIRS, chunkPairs: CHUNK_PASSES,
  sampling: 'production-seed-scan-representative-independent-raster-pairs' };
const record = existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, 'utf8'))
  : { run: RUN_LABEL, sourceSignature: SOURCE_SIGNATURE, conditions: CONDITIONS, scenes: {} };
if (record.sourceSignature !== SOURCE_SIGNATURE || JSON.stringify(record.conditions) !== JSON.stringify(CONDITIONS)) {
  throw new Error(`run ${RUN_LABEL} has a different source signature or conditions; choose a new --run label`);
}

// 対の塊 first の和のファイル。kind は sum(A + B)・square(A² + B²)・difference((A − B)²)。
const chunkFileOf = (cache, first, kind) => path.join(cache, `${kind}-${String(first).padStart(4, '0')}.f32`);
const CHUNK_KINDS = ['sum', 'square', 'difference'];
const chunkComplete = (cache, first) => CHUNK_KINDS.every((kind) => existsSync(chunkFileOf(cache, first, kind)));

async function fillCache(lab, cache) {
  for (let first = 0; first < PAIRS; first += CHUNK_PASSES) {
    if (chunkComplete(cache, first)) continue;
    await lab.accumulateRasterPairs(first, CHUNK_PASSES, PAIRS);
    const { sums, squares } = await lab.takeRasterPairSums();
    const add = (...images) => Float32Array.from(images[0], (_, i) => images.reduce((sum, image) => sum + image[i], 0));
    writeFloats(chunkFileOf(cache, first, 'sum'), add(sums[0][0], sums[0][1], sums[1][0], sums[1][1]));
    writeFloats(chunkFileOf(cache, first, 'square'), add(squares[0][0], squares[0][1], squares[1][0], squares[1][1]));
    writeFloats(chunkFileOf(cache, first, 'difference'), add(squares[0][2], squares[1][2]));
    console.log(`${RUN_LABEL}: cached pairs ${first}–${first + CHUNK_PASSES - 1}`);
  }
}

// 対 begin〜end − 1 の塊の kind の和(Float64)。
function cachedSum(cache, kind, begin = 0, end = PAIRS) {
  const sum = new Float64Array(SCAN_PIXELS * 4);
  for (let first = begin; first < end; first += CHUNK_PASSES) {
    const values = readFloats(chunkFileOf(cache, first, kind));
    for (let i = 0; i < sum.length; i++) sum[i] += values[i];
  }
  return sum;
}

function writeOutputs(dir, cache) {
  const rgba = (value) => Float32Array.from({ length: SCAN_PIXELS * 4 }, (_, i) => i % 4 === 3 ? 1 : value(i));
  const first = cachedSum(cache, 'sum', 0, PAIRS / 2), second = cachedSum(cache, 'sum', PAIRS / 2);
  const square = cachedSum(cache, 'square'), difference = cachedSum(cache, 'difference');
  // 前半・後半それぞれ PAIRS / 2 対 = PAIRS 枚。
  const mean = rgba((i) => (first[i] + second[i]) / (2 * PAIRS));
  const raster = rgba((i) => Math.sqrt(difference[i] / PAIRS / 2));
  const total = rgba((i) => Math.sqrt(Math.max(0, square[i] / (2 * PAIRS) - mean[i] ** 2)));
  const outputs = {
    mean, 'mean-first': rgba((i) => first[i] / PAIRS), 'mean-second': rgba((i) => second[i] / PAIRS),
    'raster-rms': raster, 'total-rms': total, 'seed-rms': rgba((i) => Math.sqrt(Math.max(0, total[i] ** 2 - raster[i] ** 2))),
  };
  for (const [name, values] of Object.entries(outputs)) writeFloats(path.join(dir, `${name}.rgba.f32`), values);
}

for (const scene of scenes) {
  const dir = path.join(RUN_DIR, scene.name), cache = path.join(dir, 'cache');
  const sceneSignature = sceneSignatureOf(scene, SOURCE_SIGNATURE);
  const stored = record.scenes[scene.name];
  if (stored !== undefined && stored.sceneSignature !== sceneSignature) {
    throw new Error(`run ${RUN_LABEL}/${scene.name} has a different scene signature; choose a new --run label`);
  }
  mkdirSync(cache, { recursive: true });
  const started = performance.now();
  await withLab(async (lab) => {
    await lab.show({ caseName: scene.caseName, shot: scene.shot, mode: 2, set: 'tuning', key: scene.name });
    await lab.setUpsampleAlphaOne(false);
    await lab.setTier(TIER);
    await lab.renderProductionCorrectionPhase(0, true);
    const scanSurface = await lab.readFloat('scan-surface-0', 4);
    const contourMask = contourMaskOf(scanSurface);
    writeFileSync(path.join(dir, 'surface-mask.u8'), Uint8Array.from({ length: SCAN_PIXELS }, (_, p) => scanSurface[p * 4 + 2] > 0 ? 1 : 0));
    writeFileSync(path.join(dir, 'contour-mask.u8'), contourMask);
    writeFileSync(path.join(dir, 'contour-mask.png'), maskPng(contourMask));
    await fillCache(lab, cache);
  });
  writeOutputs(dir, cache);
  record.scenes[scene.name] = { sceneSignature, git: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(),
    capturedAt: new Date().toISOString(), wallTimeMs: performance.now() - started };
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(RECORD, JSON.stringify(record, null, 2));
  console.log(`${RUN_LABEL}/${scene.name}: ${((performance.now() - started) / 1000).toFixed(0)} s`);
}
