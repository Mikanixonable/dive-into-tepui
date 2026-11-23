// 手順22.5 の評価: ラスタのずれの対の撮影(render-lab-screen-space-raster-pairs.mjs)を、対照 control の収束先からの移動と、ラスタ由来の
// 1 パスの揺れ(ちらつき)に分けて並べる。ちらつきの範囲 H は control のラスタ由来の揺れが閾値以上の画素で、見る場所を示す。
// 使い方: node tools/screen-space-raster-flicker-eval.mjs --control=<run> [--range-threshold=0.02] [--gradient-threshold=0.002] --out=<dir> <run>...
// 画素は走査の解像度の、面から輪郭(1 画素膨らませた)を除いた Ω。量は RGB の 3 成分の二乗平均。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { OUTPUT, SCAN_HEIGHT, SCAN_PIXELS, SCAN_WIDTH, maskPng, signedPng, unsignedPng } from './screen-space-chain-runs.mjs';
import { readFloats } from './screen-space-lab.mjs';

const argumentOf = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const control = argumentOf('control'), out = argumentOf('out');
const threshold = Number(argumentOf('range-threshold') ?? 0.02);
const gradientThreshold = Number(argumentOf('gradient-threshold') ?? 0.002);
const runs = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
if (control === undefined || out === undefined) {
  throw new Error('usage: node tools/screen-space-raster-flicker-eval.mjs --control=<run> [--range-threshold=0.02] [--gradient-threshold=0.002] --out=<dir> <run>...');
}
if (!runs.includes(control)) runs.unshift(control);
mkdirSync(out, { recursive: true });
const PAIRS = path.join(OUTPUT, 'pairs');
const sceneDirOf = (run, scene) => path.join(PAIRS, run, scene);
const read = (run, scene, name) => readFloats(path.join(sceneDirOf(run, scene), `${name}.rgba.f32`));
const readMask = (run, scene, name) => new Uint8Array(readFileSync(path.join(sceneDirOf(run, scene), `${name}.u8`)));
// 画素 p の RGB の二乗平均の平方根。
const magnitude = (values, p) => Math.sqrt((values[4 * p] ** 2 + values[4 * p + 1] ** 2 + values[4 * p + 2] ** 2) / 3);

function rmsOver(values, mask) {
  let sum = 0, count = 0;
  for (let p = 0; p < SCAN_PIXELS; p++) if (mask[p]) {
    sum += magnitude(values, p) ** 2;
    count++;
  }
  return count === 0 ? null : Math.sqrt(sum / count);
}

function quantileOver(values, mask, q) {
  const picked = [];
  for (let p = 0; p < SCAN_PIXELS; p++) if (mask[p]) picked.push(magnitude(values, p));
  if (picked.length === 0) return null;
  picked.sort((a, b) => a - b);
  return picked[Math.min(picked.length - 1, Math.floor(q * picked.length))];
}

// M の輝度を Ω の中の 3×3 の箱で均す(残りの雑音で傾きの向きが揺れないため)。
function smoothedLuminance(mean, omega) {
  const values = new Float32Array(SCAN_PIXELS);
  for (let y = 0; y < SCAN_HEIGHT; y++) for (let x = 0; x < SCAN_WIDTH; x++) {
    const p = y * SCAN_WIDTH + x;
    if (!omega[p]) continue;
    let sum = 0, count = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= SCAN_WIDTH || ny < 0 || ny >= SCAN_HEIGHT) continue;
      const neighbor = ny * SCAN_WIDTH + nx;
      if (!omega[neighbor]) continue;
      sum += (mean[4 * neighbor] + mean[4 * neighbor + 1] + mean[4 * neighbor + 2]) / 3;
      count++;
    }
    values[p] = sum / count;
  }
  return values;
}

// 均した輝度 Y の中心差分 [gx, gy, |g|]。上下左右が Ω に入らない画素は undefined。
function gradients(mean, omega) {
  const luminance = smoothedLuminance(mean, omega), result = Array(SCAN_PIXELS);
  for (let y = 1; y < SCAN_HEIGHT - 1; y++) for (let x = 1; x < SCAN_WIDTH - 1; x++) {
    const p = y * SCAN_WIDTH + x;
    if (!omega[p] || !omega[p - 1] || !omega[p + 1] || !omega[p - SCAN_WIDTH] || !omega[p + SCAN_WIDTH]) continue;
    const gx = (luminance[p + 1] - luminance[p - 1]) / 2, gy = (luminance[p + SCAN_WIDTH] - luminance[p - SCAN_WIDTH]) / 2;
    result[p] = [gx, gy, Math.hypot(gx, gy)];
  }
  return result;
}

// 逆転 r = max(0, −∇Y · ĝ_control): control の明るさが上がる向きに候補が下がる傾き(|g_control| が閾値未満の画素は 0)。光源へ近づくほど暗くなる所で、光が輪に見える。
function reversalOf(gradient, controlGradient) {
  const values = new Float32Array(4 * SCAN_PIXELS);
  let sum = 0, pixels = 0, max = 0;
  for (let p = 0; p < SCAN_PIXELS; p++) {
    if (gradient[p] === undefined || controlGradient[p] === undefined) continue;
    const [gx, gy] = gradient[p], [sx, sy, size] = controlGradient[p];
    if (size < gradientThreshold) continue;
    const reversal = Math.max(0, -(gx * sx + gy * sy) / size);
    values[4 * p] = values[4 * p + 1] = values[4 * p + 2] = reversal;
    sum += reversal;
    if (reversal >= gradientThreshold) pixels++;
    max = Math.max(max, reversal);
  }
  return { values, sum, pixels, max };
}

// 輪郭を 1 画素膨らませて面から除いた Ω。
function omegaOf(surface, contour) {
  const omega = Uint8Array.from(surface);
  for (let y = 0; y < SCAN_HEIGHT; y++) for (let x = 0; x < SCAN_WIDTH; x++) {
    if (!contour[y * SCAN_WIDTH + x]) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < SCAN_WIDTH && ny >= 0 && ny < SCAN_HEIGHT) omega[ny * SCAN_WIDTH + nx] = 0;
    }
  }
  return omega;
}

// Ω での M の正の部分の和と負の部分の和。
function energyOf(mean, omega) {
  let positive = 0, negative = 0;
  for (let p = 0; p < SCAN_PIXELS; p++) if (omega[p]) for (let c = 0; c < 3; c++) {
    const value = mean[4 * p + c];
    if (value > 0) positive += value;
    else negative += value;
  }
  return { positive, negative };
}

const difference = (a, b) => Float32Array.from(a, (value, i) => (i % 4 === 3 ? 1 : value - b[i]));
const ratio = (value, base) => (value === null || base === null || base === 0 ? null : value / base);

const scenes = Object.keys(JSON.parse(readFileSync(path.join(PAIRS, control, 'record.json'), 'utf8')).scenes);
const evaluation = { control, threshold, gradientThreshold, scenes: {} };
const rows = [];
for (const scene of scenes) {
  const present = runs.filter((run) => existsSync(path.join(sceneDirOf(run, scene), 'mean.rgba.f32')));
  const omega = omegaOf(readMask(control, scene, 'surface-mask'), readMask(control, scene, 'contour-mask'));
  const controlRaster = read(control, scene, 'raster-rms');
  const range = Uint8Array.from(omega, (inside, p) => (inside && magnitude(controlRaster, p) >= threshold ? 1 : 0));
  const outsideRange = Uint8Array.from(omega, (inside, p) => (inside && !range[p] ? 1 : 0));
  writeFileSync(path.join(out, `${scene}-range.png`), maskPng(range));
  const controlMean = read(control, scene, 'mean'), controlFirst = read(control, scene, 'mean-first'), controlSecond = read(control, scene, 'mean-second');
  const controlGradient = gradients(controlMean, omega);
  const controlEnergy = energyOf(controlMean, omega);
  const base = {};
  const images = [];
  for (const run of present) {
    const mean = read(run, scene, 'mean'), raster = read(run, scene, 'raster-rms'), seed = read(run, scene, 'seed-rms');
    const shift = difference(mean, controlMean);
    const firstShift = difference(read(run, scene, 'mean-first'), controlFirst), secondShift = difference(read(run, scene, 'mean-second'), controlSecond);
    const floor = Float32Array.from(firstShift, (value, i) => (i % 4 === 3 ? 1 : (value - secondShift[i]) / 2));
    const energy = energyOf(mean, omega);
    const reversal = reversalOf(gradients(mean, omega), controlGradient);
    const row = { scene, run, rangePixels: range.reduce((a, b) => a + b, 0),
      shiftRms: rmsOver(shift, omega), shiftInside: rmsOver(shift, range), shiftOutside: rmsOver(shift, outsideRange), shiftFloor: rmsOver(floor, omega),
      positiveRatio: energy.positive / controlEnergy.positive, negativeRatio: energy.negative / controlEnergy.negative,
      rasterInside: rmsOver(raster, range), rasterInsideQ99: quantileOver(raster, range, 0.99), rasterInsideMax: quantileOver(raster, range, 1),
      rasterAll: rmsOver(raster, omega), seedAll: rmsOver(seed, omega),
      reversalSum: reversal.sum, reversalPixels: reversal.pixels, reversalMax: reversal.max };
    if (run === control) Object.assign(base, row);
    rows.push(row);
    images.push({ run, mean, shift, raster, seed, reversal: reversal.values });
  }
  for (const row of rows.filter((item) => item.scene === scene)) {
    for (const key of ['rasterInside', 'rasterInsideQ99', 'rasterInsideMax', 'rasterAll', 'seedAll']) row[`${key}Ratio`] = ratio(row[key], base[key]);
  }
  // 表示の尺度は場面ごとに全 run で共通(収束先は control の 99.9% 分位、移動・揺れは全 run の 99.9% 分位)。
  const all = Uint8Array.from(omega);
  const scale = {
    mean: quantileOver(controlMean, all, 0.999),
    shift: Math.max(...images.map(({ shift }) => quantileOver(shift, all, 0.999))) || 1e-6,
    noise: Math.max(...images.map(({ raster, seed }) => Math.max(quantileOver(raster, all, 0.999), quantileOver(seed, all, 0.999)))),
    reversal: Math.max(...images.map(({ reversal }) => quantileOver(reversal, all, 0.999))) || 1e-6,
  };
  for (const { run, mean, shift, raster, seed, reversal } of images) {
    writeFileSync(path.join(out, `${scene}-${run}-mean.png`), signedPng(mean, 4, scale.mean));
    writeFileSync(path.join(out, `${scene}-${run}-shift.png`), signedPng(shift, 4, scale.shift));
    writeFileSync(path.join(out, `${scene}-${run}-raster.png`), unsignedPng(raster, 4, scale.noise));
    writeFileSync(path.join(out, `${scene}-${run}-seed.png`), unsignedPng(seed, 4, scale.noise));
    writeFileSync(path.join(out, `${scene}-${run}-reversal.png`), unsignedPng(reversal, 4, scale.reversal));
  }
  evaluation.scenes[scene] = { rangePixels: range.reduce((a, b) => a + b, 0), omegaPixels: omega.reduce((a, b) => a + b, 0), scale };
}
evaluation.rows = rows;
writeFileSync(path.join(out, 'eval.json'), JSON.stringify(evaluation, null, 2));
const digits = (value) => (value === null ? '—' : value.toPrecision(3));
for (const row of rows) {
  console.log([row.scene, row.run, `H=${row.rangePixels}`, `shift=${digits(row.shiftRms)}(floor ${digits(row.shiftFloor)}, in ${digits(row.shiftInside)}, out ${digits(row.shiftOutside)})`,
    `pos=${digits(row.positiveRatio)} neg=${digits(row.negativeRatio)}`,
    `rasterH=${digits(row.rasterInside)}(×${digits(row.rasterInsideRatio)}) q99=${digits(row.rasterInsideQ99)} max=${digits(row.rasterInsideMax)}`,
    `rasterΩ=${digits(row.rasterAll)}(×${digits(row.rasterAllRatio)}) seedΩ=${digits(row.seedAll)}(×${digits(row.seedAllRatio)})`,
    `rev=${digits(row.reversalSum)}(${row.reversalPixels} px, max ${digits(row.reversalMax)})`].join('  '));
}
