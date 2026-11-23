import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PIXELS, ONE_PASS, powerOfTwoAtMost } from './reflection-chain-common.mjs';
import { band, curvatureOf, metricGroups } from './reflection-read-level-metrics.mjs';
import { encodeRgbPng } from './png.mjs';
import { HEIGHT, WIDTH } from './screen-space-lab.mjs';
import { noiseBands, noiseMaps, rawLeak, rawLeakOverall } from './reflection-read-level-noise.mjs';

const [run, selectedScene] = process.argv.slice(2);
if (!run) throw new Error('usage: node tools/reflection-noise-origin.mjs <run> [scene]');
const root = path.join(path.resolve(import.meta.dirname, '..'), '.render-lab-shots', 'ssr-read-levels', 'runs', run);
const scenes = selectedScene ? [selectedScene] : readdirSync(root).filter((name) => existsSync(path.join(root, name, 'meta.json')));
for (const scene of scenes) analyze(path.join(root, scene));
writeNoiseMarkdown(root, scenes);

function floats(file, count) {
  const bytes = readFileSync(file);
  if (bytes.byteLength !== count * 4) throw new Error(`${file}: unexpected float count`);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function residual(sample, mean) {
  const result = new Float32Array(sample.length);
  for (let pixel = 0; pixel < PIXELS; pixel++) {
    for (let channel = 0; channel < 3; channel++) result[pixel * 4 + channel] = sample[pixel * 4 + channel] - mean[pixel * 4 + channel];
  }
  return result;
}

function analyze(dir) {
  const meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const base = floats(path.join(dir, 'q-b.f32'), PIXELS * 4);
  const production = floats(path.join(dir, 'q-production.f32'), PIXELS * 4);
  const mask = Uint8Array.from({ length: PIXELS }, (_, p) => Number(base[p * 4 + 3] > 0 || production[p * 4 + 3] > 0));
  const rough = floats(path.join(dir, 'roughness.f32'), PIXELS * 4);
  const normal = floats(path.join(dir, 'normal.f32'), PIXELS * 4);
  const depth = floats(path.join(dir, 'depth.f32'), PIXELS * 4);
  const roughBand = Uint8Array.from({ length: PIXELS }, (_, p) => band(rough[p * 4] / 255, [0.1, 0.2, 0.3]));
  const curveBand = Uint8Array.from(curvatureOf(normal, depth), (value) => band(value, [0.002, 0.01, 0.05]));
  const levelMaps = Array.from({ length: ONE_PASS }, (_, i) => floats(path.join(dir, `level-production-s${i}.f32`), PIXELS));
  const levelMean = new Float32Array(PIXELS);
  for (let pixel = 0; pixel < PIXELS; pixel++) {
    let count = 0;
    for (const map of levelMaps) if (map[pixel] >= 0) { levelMean[pixel] += map[pixel]; count++; }
    levelMean[pixel] = count ? levelMean[pixel] / count : -1;
  }
  const groups = metricGroups(mask, roughBand, curveBand, levelMean);
  for (const [name, low, high] of [['lv0-1', 0, 1], ['lv1-2', 1, 2], ['lv2-3', 2, 3], ['lv3-4', 3, 4], ['lv4+', 4, Infinity]]) {
    groups[`all/${name}`] = Uint8Array.from(mask, (inside, p) => Number(inside && levelMean[p] >= low && levelMean[p] < high));
  }
  for (const surface of Object.keys(groups).filter((name) => !name.includes('/'))) {
    for (const level of ['lv0-1', 'lv1-2', 'lv2-3', 'lv3-4', 'lv4+']) {
      const key = `${surface}/${level}`;
      const bandMask = groups[`all/${level}`];
      groups[key] = Uint8Array.from(mask, (inside, p) => Number(inside && bandMask[p] && groups[surface][p]));
    }
    groups[`${surface}/all`] = groups[surface];
  }
  const rawSamples = Array.from({ length: ONE_PASS }, (_, i) => floats(path.join(dir, `sample-L0-s${i}.f32`), PIXELS * 4));
  const rawResiduals = rawSamples.map((sample) => residual(sample, base));
  const targets = [{ key: 'production', mean: production, sampleName: 'sample-production' }];
  for (let level = 0; level <= meta.lmax; level++) {
    targets.push({ key: `L${level}`, mean: level ? floats(path.join(dir, `q-L${level}.f32`), PIXELS * 4) : base,
      sampleName: `sample-L${level}` });
  }
  const results = {};
  const maps = {};
  const leaks = {};
  for (const target of targets) {
    const samples = Array.from({ length: ONE_PASS }, (_, i) => floats(path.join(dir, `${target.sampleName}-s${i}.f32`), PIXELS * 4));
    const residuals = samples.map((sample) => residual(sample, target.mean));
    const targetMaps = noiseMaps(residuals, mask);
    maps[target.key] = targetMaps;
    if (target.key !== 'L0') leaks[target.key] = rawLeak(residuals, rawResiduals, mask);
    const targetGroups = {};
    for (const [group, groupMask] of Object.entries(groups)) {
      const stats = noiseBands(residuals, groupMask, [1, 2, 4, 8, 16, 32]);
      if (!stats.pixels) continue;
      targetGroups[group] = { ...stats, leak: target.key === 'L0' ? 1 : rawLeakOverall(residuals, rawResiduals, groupMask) };
    }
    results[target.key] = targetGroups;
  }
  const productionQuantile = quantileOf(maps.production.all, mask, 0.999);
  const gain = powerOfTwoAtMost(0.95 / Math.max(productionQuantile, 1e-12));
  const analysis = path.join(dir, 'analysis');
  mkdirSync(analysis, { recursive: true });
  const denominator = results.production['all/all']?.energy ?? 0;
  for (const target of targets) {
    for (const group of Object.values(results[target.key])) group.energyShare = denominator ? group.energy / denominator : 0;
    const targetMaps = maps[target.key];
    saveNoise(analysis, target.key, 'all', targetMaps.all, mask, gain);
    saveNoise(analysis, target.key, 'fine', targetMaps.fine, mask, gain);
    saveNoise(analysis, target.key, 'coarse', targetMaps.coarse, mask, gain);
    if (target.key !== 'L0') saveLeak(analysis, target.key, leaks[target.key], mask);
  }
  writeFileSync(path.join(analysis, 'noise-bands.json'), JSON.stringify({ gain, targets: results }, null, 2));
}

function quantileOf(values, mask, fraction) {
  const sorted = [];
  for (let p = 0; p < PIXELS; p++) if (mask[p]) sorted.push(values[p]);
  sorted.sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * fraction)] ?? 0;
}

function saveNoise(dir, target, kind, values, mask, gain) {
  const rgb = new Uint8Array(PIXELS * 3);
  for (let p = 0; p < PIXELS; p++) {
    const value = mask[p] ? Math.max(0, Math.min(255, Math.round(Math.sqrt(values[p] * gain) * 255))) : null;
    rgb[p * 3] = value ?? 0;
    rgb[p * 3 + 1] = value ?? 24;
    rgb[p * 3 + 2] = value ?? 64;
  }
  writeFileSync(path.join(dir, `noise-${kind}-${target}.png`), encodeRgbPng(WIDTH, HEIGHT, rgb));
}

function saveLeak(dir, target, values, mask) {
  const rgb = new Uint8Array(PIXELS * 3);
  for (let p = 0; p < PIXELS; p++) {
    const value = mask[p] ? Math.round(255 * Math.max(0, Math.min(1, values[p]))) : null;
    rgb[p * 3] = value ?? 0;
    rgb[p * 3 + 1] = value ?? 24;
    rgb[p * 3 + 2] = value ?? 64;
  }
  writeFileSync(path.join(dir, `noise-leak-${target}.png`), encodeRgbPng(WIDTH, HEIGHT, rgb));
}

function writeNoiseMarkdown(runDir, scenes) {
  const lines = ['# 雑音の尺度と由来', ''];
  for (const scene of scenes) {
    const dir = path.join(runDir, scene);
    const meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    const result = JSON.parse(readFileSync(path.join(dir, 'analysis', 'noise-bands.json'), 'utf8'));
    lines.push(`## ${scene}`, '', ...markdown(result.targets, meta.lmax), '');
  }
  writeFileSync(path.join(runDir, 'noise-bands.md'), lines.join('\n'));
}

function markdown(targets, lmax) {
  const lines = [];
  for (const target of ['production', 'L3', 'L4', `L${lmax}`]) {
    if (!targets[target]) continue;
    lines.push(`## ${target}`, '', '| 組 | 画素率 | energyShare | N | N8 | 1 | 2 | 4 | 8 | 16 | 32+ | leak |',
      '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    const keys = ['all/all', 'no-rim/all', ...['lv0-1', 'lv1-2', 'lv2-3', 'lv3-4', 'lv4+'].map((level) => `all/${level}`),
      ...[0, 2, 3].flatMap((curve) => [`curve-${curve}/lv3-4`, `curve-${curve}/lv4+`]), ...[0, 1, 2, 3].map((value) => `rough-${value}/all`)];
    for (const key of keys) {
      const row = targets[target][key];
      if (!row) continue;
      const shares = ['1', '2', '4', '8', '16', '32+'].map((name) => `${(row.shares[name] * 100).toFixed(1)}%`);
      lines.push(`| ${key} | ${(100 * row.pixels / PIXELS).toFixed(1)}% | ${(100 * row.energyShare).toFixed(1)}% | ${row.N.toExponential(3)} | ${row.sizes['8'].toExponential(3)} | ${shares.join(' | ')} | ${row.leak.toFixed(3)} |`);
    }
    lines.push('');
  }
  return lines;
}
