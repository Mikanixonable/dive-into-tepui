// 収束像、雑音、読む段、面形状ごとの診断を float 撮影から計算する。
// 使い方: node tools/reflection-read-level-analysis.mjs <run>... [--nu=1,0.25] [--radius=8]
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ONE_PASS, PIXELS, colorPng, centeredPng, powerOfTwoAtMost } from './reflection-chain-common.mjs';
import {
  band, boxAverage, curvatureOf, errorOf, absDifference, groupMetrics, quantile, rms,
  scaleMetrics, pointMetrics, metricGroups,
} from './reflection-read-level-metrics.mjs';
import { grayLevelPng, overPng } from './reflection-read-level-images.mjs';
import { loadLevelStack, composeMean, composeSample, shifted, simulatedPoint } from './reflection-level-simulator.mjs';

const args = process.argv.slice(2);
const runs = args.filter((arg) => !arg.startsWith('--'));
const realRuns = (option('real') ?? '').split(',').filter(Boolean).map(parseRealRun);
const radius = Number(option('radius') ?? 8);
const nus = (option('nu') ?? '16,4,1,0.25,0.0625').split(',').map(Number);
if (!runs.length || !Number.isInteger(radius) || radius < 0 || nus.some((value) => !Number.isFinite(value) || value < 0)) {
  throw new Error('usage: node tools/reflection-read-level-analysis.mjs <run>... [--nu=1,0.25] [--radius=8]');
}
const root = path.join(path.resolve(import.meta.dirname, '..'), '.render-lab-shots', 'ssr-read-levels');
for (const run of runs) {
  const runDir = path.join(root, 'runs', run);
  for (const scene of scenesOf(runDir)) {
    const meta = JSON.parse(readFileSync(path.join(runDir, scene, 'meta.json'), 'utf8'));
    if (meta.productionOnly) {
      throw new Error(`analysis input must include fixed levels: ${run}/${scene}`);
    }
    analyzeScene(path.join(runDir, scene), radius, nus, realRuns, runs[0]);
  }
}
writeSummary(root, runs, radius, nus);
writeValidationMarkdown(root, runs[0]);
await import('./reflection-read-level-index.mjs');

function scenesOf(runDir) {
  return readdirSync(runDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

function analyzeScene(dir, radiusPx, weights, real, baselineRun) {
  const meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const output = path.join(dir, 'analysis');
  mkdirSync(output, { recursive: true });
  const base = readFloats(path.join(dir, 'q-b.f32'), PIXELS * 4);
  const production = readFloats(path.join(dir, 'q-production.f32'), PIXELS * 4);
  const stack = loadLevelStack(dir, meta);
  const productionSamples = Array.from({ length: ONE_PASS }, (_, i) => readFloats(
    path.join(dir, `sample-production-s${i}.f32`), PIXELS * 4));
  const levelMaps = Array.from({ length: ONE_PASS }, (_, i) => readFloats(path.join(dir, `level-production-s${i}.f32`), PIXELS));
  const levelCurrent = new Float32Array(PIXELS);
  for (let pixel = 0; pixel < PIXELS; pixel++) {
    let count = 0;
    for (const map of levelMaps) if (map[pixel] >= 0) { levelCurrent[pixel] += map[pixel]; count++; }
    levelCurrent[pixel] = count ? levelCurrent[pixel] / count : -1;
  }
  const productionNoise = noiseMap(productionSamples, production);
  const rawNoise = noiseMap(stack.samples[0], base);
  const roughness = readFloats(path.join(dir, 'roughness.f32'), PIXELS * 4);
  const encodedNormal = readFloats(path.join(dir, 'normal.f32'), PIXELS * 4);
  const depth = readFloats(path.join(dir, 'depth.f32'), PIXELS * 4);
  const images = [base];
  const noises = [rawNoise];
  const samples = [stack.samples[0][0]];
  for (let level = 1; level <= meta.lmax; level++) {
    images.push(readFloats(path.join(dir, `q-L${level}.f32`), PIXELS * 4));
    noises.push(noiseMap(stack.samples[level], images[level]));
    samples.push(stack.samples[level][0]);
  }
  const mask = Uint8Array.from({ length: PIXELS }, (_, p) => Number(base[p * 4 + 3] > 0 || production[p * 4 + 3] > 0));
  const curvature = curvatureOf(encodedNormal, depth);
  const roughBand = Uint8Array.from({ length: PIXELS }, (_, p) => band(roughness[p * 4] / 255, [0.1, 0.2, 0.3]));
  const curveBand = Uint8Array.from(curvature, (value) => band(value, [0.002, 0.01, 0.05]));
  const structuralErrors = images.map((image) => errorOf(image, base));
  const localErrors = structuralErrors.map((values) => boxAverage(values, mask, radiusPx));
  const localNoises = noises.map((values) => boxAverage(values, mask, radiusPx));
  const balancedLevels = balancedLevelsOf(localErrors, localNoises, meta.lmax, weights);
  const report = {
    lmax: meta.lmax,
    settings: { passes: meta.passes, levelPasses: meta.levelPasses, radius: radiusPx, graphics: meta.graphics },
    levels: [],
    groups: {},
    scaleRms: {},
  };
  for (let level = 0; level <= meta.lmax; level++) {
    report.levels.push({ level, structuralRms: rms(structuralErrors[level], mask), noiseRms: rms(noises[level], mask) });
  }
  const gain = powerOfTwoAtMost(0.95 / Math.max(quantile(base, mask, 0.99), 1e-12));
  const diffGain = powerOfTwoAtMost(0.5 / Math.max(quantile(absDifference(production, base), mask, 0.999), 1e-12));
  const pngs = pngsOf(dir, base, production, images, samples, levelCurrent, meta.lmax, gain, diffGain, productionSamples[0]);
  for (let index = 0; index < weights.length; index++) {
    const nu = weights[index];
    const balanced = balancedLevels[index];
    const { oracle, oracleSample, oracleNoise } = oracleImages(images, samples, noises, balanced);
    pngs[`level-bal-nu${nu}`] = grayLevelPng(Float32Array.from(balanced), meta.lmax);
    pngs[`over-nu${nu}`] = overPng(levelCurrent, balanced);
    pngs[`oracle-minus-b-nu${nu}`] = centeredPng(absDifference(oracle, base), diffGain);
    report.groups[String(nu)] = groupMetrics(mask, levelCurrent, balanced, production,
      oracle, base, productionNoise, oracleNoise, roughBand, curveBand);
    const sampleProduction = productionSamples[0];
    report.scaleRms[String(nu)] = scaleMetrics(production, oracle, base, sampleProduction, oracleSample, mask);
  }
  const groupMasks = metricGroups(mask, roughBand, curveBand, levelCurrent);
  const scatter = scatterOf(dir, stack, base, production, productionSamples, levelMaps, levelCurrent,
    groupMasks, gain, balancedLevels, weights, real, baselineRun, path.basename(dir));
  writeFileSync(path.join(output, 'scatter.json'), JSON.stringify(scatter, null, 2));
  const validation = validationOf(dir, stack, base, groupMasks, real, baselineRun, path.basename(dir));
  writeFileSync(path.join(output, 'validation.json'), JSON.stringify(validation, null, 2));
  report.display = { colorGain: gain, differenceGain: diffGain };
  report.simulateMsPerPoint = scatter.simulateMsPerPoint;
  report.images = [...Object.keys(pngs), ...weights.flatMap((nu) => [`oracle-nu${nu}`, `sample-oracle-nu${nu}`])];
  writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  for (const [name, bytes] of Object.entries(pngs)) writeFileSync(path.join(output, `${name}.png`), bytes);
}

function scatterOf(dir, stack, base, production, productionSamples, levelMaps, levelMean,
  groups, gain, balanced, weights, real, baselineRun, sceneName) {
  const series = [];
  const fixed = { key: 'fixed', label: '固定段', marker: 'circle', line: true, points: [] };
  for (let level = 0; level <= stack.lmax; level++) {
    const mean = stack.means[level];
    const samples = stack.samples[level];
    const name = level ? `L${level}` : 'b';
    fixed.points.push(addScatterPoint(dir, fixed.key, String(level), name,
      `sample-L${level}`, mean, samples, base, groups, gain));
  }
  series.push(fixed);
  const width = { key: 'width', label: '幅', marker: 'square', line: true, points: [] };
  let simulateMilliseconds = 0;
  for (const scale of [2, 1.41, 1, 0.71, 0.5, 0.35, 0.25, 0.125]) {
    const started = performance.now();
    const shift = Math.log2(scale);
    const meanMap = shifted(levelMean, shift);
    const mean = composeMean(stack, meanMap);
    const samples = levelMaps.map((map, seed) => composeSample(stack, shifted(map, shift), seed));
    const metrics = pointMetrics(mean, samples, base, groups);
    simulateMilliseconds += performance.now() - started;
    const key = String(scale);
    width.points.push(addScatterPoint(dir, width.key, key, `k = ${key}`, `sample-sim-w${key}`,
      mean, samples, base, groups, gain, metrics));
  }
  series.push(width);
  const oracle = { key: 'oracle', label: '釣り合い（基準を見る上限）', marker: 'diamond', line: true, points: [] };
  for (let index = 0; index < weights.length; index++) {
    const nu = weights[index];
    const mean = composeMean(stack, Float32Array.from(balanced[index]));
    const samples = levelMaps.map((map, seed) => composeSample(stack, balanced[index], seed));
    const point = addScatterPoint(dir, 'oracle', `nu${nu}`, `ν=${nu}`,
      `sample-oracle-nu${nu}`, mean, samples, base, groups, gain);
    point.images.mean = `oracle-nu${nu}`;
    oracle.points.push(point);
  }
  series.push(oracle);
  const productionPoint = addScatterPoint(dir, 'production', 'production', '本番', 'sample-production',
    production, productionSamples, base, groups, gain);
  series.push({ key: 'production', label: '本番', marker: 'circle', line: false, points: [productionPoint] });
  const realSeries = { key: 'real', label: '幅を変えた本番（実測）', marker: 'open-square', line: false, points: [] };
  const baseDir = path.join(path.dirname(path.dirname(dir)), baselineRun, sceneName);
  const realBase = readFloats(path.join(baseDir, 'q-b.f32'), PIXELS * 4);
  for (const entry of real) {
    const realDir = path.join(path.dirname(path.dirname(dir)), entry.run, sceneName);
    requireProductionRun(realDir, entry.run);
    const mean = readFloats(path.join(realDir, 'q-production.f32'), PIXELS * 4);
    const samples = Array.from({ length: ONE_PASS }, (_, seed) => readFloats(
      path.join(realDir, `sample-production-s${seed}.f32`), PIXELS * 4));
    realSeries.points.push({ key: `${entry.run}-${entry.k}`, label: `k=${entry.k}`,
      metrics: pointMetrics(mean, samples, realBase, groups), images: { mean: '', sample: '' } });
  }
  if (realSeries.points.length) series.push(realSeries);
  return { series, simulateMsPerPoint: simulateMilliseconds / width.points.length };
}

function parseRealRun(value) {
  const match = /^([a-z0-9][a-z0-9-]{0,47}):([0-9]+(?:\.[0-9]+)?)$/.exec(value);
  if (!match) throw new Error(`invalid --real entry: ${value}`);
  return { run: match[1], k: Number(match[2]) };
}

function validationOf(dir, stack, base, groups, real, baselineRun, sceneName) {
  const rows = [];
  const allRuns = [{ run: baselineRun, k: 1 }, ...real];
  const selectedGroups = ['all', 'curve-0', 'curve-2', 'rough-2'];
  const baselineDir = path.join(path.dirname(path.dirname(dir)), baselineRun, sceneName);
  const baselineMaps = Array.from({ length: ONE_PASS }, (_, seed) => readFloats(
    path.join(baselineDir, `level-production-s${seed}.f32`), PIXELS));
  for (const entry of allRuns) {
    const runDir = path.join(path.dirname(path.dirname(dir)), entry.run, sceneName);
    if (entry.run !== baselineRun) requireProductionRun(runDir, entry.run);
    const mean = readFloats(path.join(runDir, 'q-production.f32'), PIXELS * 4);
    const samples = Array.from({ length: ONE_PASS }, (_, seed) => readFloats(
      path.join(runDir, `sample-production-s${seed}.f32`), PIXELS * 4));
    const maps = Array.from({ length: ONE_PASS }, (_, seed) => readFloats(
      path.join(runDir, `level-production-s${seed}.f32`), PIXELS));
    const shift = Math.log2(entry.k);
    const mapsA = baselineMaps.map((map) => shifted(map, shift));
    const simulatedA = simulatedPoint(stack, mapsA);
    const simulatedB = simulatedPoint(stack, maps);
    const actualMetrics = pointMetrics(mean, samples, base, groups);
    const metricA = pointMetrics(simulatedA.mean, simulatedA.samples, base, groups);
    const metricB = pointMetrics(simulatedB.mean, simulatedB.samples, base, groups);
    for (const group of selectedGroups) {
      rows.push({ run: entry.run, k: entry.k, group, measured: actualMetrics[group],
        simulatedA: metricA[group], simulatedB: metricB[group],
        meanOffset: maskedRmsDifference(simulatedB.mean, mean, groups[group])
          / Math.max(maskedRmsDifference(mean, base, groups[group]), 1e-30),
        passDifferenceOverNoise: pairedRms(simulatedB.samples, samples, groups[group])
          / Math.max(actualMetrics[group].N, 1e-30),
        noiseDifferenceOverNoise: pairedRms(residuals(simulatedB.samples, simulatedB.mean), residuals(samples, mean),
          groups[group]) / Math.max(actualMetrics[group].N, 1e-30) });
    }
  }
  return { rows };
}

function requireProductionRun(dir, run) {
  const meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  if (!meta.productionOnly) throw new Error(`--real run must use --production-only: ${run}`);
}

function maskedRmsDifference(first, second, mask) {
  let sum = 0;
  let count = 0;
  for (let pixel = 0; pixel < PIXELS; pixel++) {
    if (!mask[pixel]) continue;
    for (let channel = 0; channel < 3; channel++) {
      const delta = first[pixel * 4 + channel] - second[pixel * 4 + channel];
      sum += delta * delta;
      count++;
    }
  }
  return Math.sqrt(sum / Math.max(count, 1));
}

function pairedRms(firstSamples, secondSamples, mask) {
  let sum = 0;
  let count = 0;
  for (let seed = 0; seed < firstSamples.length; seed++) {
    const first = firstSamples[seed];
    const second = secondSamples[seed];
    for (let pixel = 0; pixel < PIXELS; pixel++) {
      if (!mask[pixel]) continue;
      count++;
      for (let channel = 0; channel < 3; channel++) {
        const delta = first[pixel * 4 + channel] - second[pixel * 4 + channel];
        sum += delta * delta;
      }
    }
  }
  return Math.sqrt(sum / Math.max(count, 1));
}

function residuals(samples, mean) {
  return samples.map((sample) => sample.map((value, index) => value - mean[index]));
}

function addScatterPoint(dir, seriesKey, key, label, sampleName, mean, samples, base, groups, gain, metrics = null) {
  const imagesDir = path.join(dir, 'analysis');
  const meanName = seriesKey === 'fixed' ? key === '0' ? 'b' : `L${key}` : `${seriesKey}-${key}`;
  writeFileSync(path.join(imagesDir, `${meanName}.png`), colorPng(mean, gain));
  writeFileSync(path.join(imagesDir, `${sampleName}.png`), colorPng(samples[0], gain));
  return { key, label, metrics: metrics ?? pointMetrics(mean, samples, base, groups),
    images: { mean: meanName, sample: sampleName } };
}

function noiseMap(samples, mean) {
  const result = new Float32Array(PIXELS);
  for (let pixel = 0; pixel < PIXELS; pixel++) {
    for (const sample of samples) for (let channel = 0; channel < 3; channel++) {
      const delta = sample[pixel * 4 + channel] - mean[pixel * 4 + channel];
      result[pixel] += delta * delta / (samples.length * 3);
    }
  }
  return result;
}

function balancedLevelsOf(localErrors, localNoises, lmax, weights) {
  return weights.map((nu) => Uint8Array.from({ length: PIXELS }, (_, pixel) => {
    let best = 0;
    let score = localErrors[0][pixel] + nu * localNoises[0][pixel];
    for (let level = 1; level <= lmax; level++) {
      const candidate = localErrors[level][pixel] + nu * localNoises[level][pixel];
      if (candidate < score) {
        best = level;
        score = candidate;
      }
    }
    return best;
  }));
}

function pngsOf(dir, base, production, images, samples, levelCurrent, lmax, gain, diffGain, sampleProduction) {
  const pngs = {
    b: colorPng(base, gain),
    production: colorPng(production, gain),
    'sample-production': colorPng(sampleProduction, gain),
    'sample-L0': colorPng(samples[0], gain),
    'production-minus-b': centeredPng(absDifference(production, base), diffGain),
    'level-production': grayLevelPng(levelCurrent, lmax),
  };
  for (let level = 1; level <= lmax; level++) {
    pngs[`L${level}`] = colorPng(images[level], gain);
    pngs[`L${level}-minus-b`] = centeredPng(absDifference(images[level], base), diffGain);
    pngs[`sample-L${level}`] = colorPng(samples[level], gain);
  }
  return pngs;
}

function oracleImages(images, samples, noises, levels) {
  const oracle = new Float32Array(PIXELS * 4);
  const oracleSample = new Float32Array(PIXELS * 4);
  const oracleNoise = new Float32Array(PIXELS);
  for (let pixel = 0; pixel < PIXELS; pixel++) {
    const level = levels[pixel];
    oracle.set(images[level].subarray(pixel * 4, pixel * 4 + 4), pixel * 4);
    oracleSample.set(samples[level].subarray(pixel * 4, pixel * 4 + 4), pixel * 4);
    oracleNoise[pixel] = noises[level][pixel];
  }
  return { oracle, oracleSample, oracleNoise };
}

function readFloats(file, count) {
  const bytes = readFileSync(file);
  if (bytes.byteLength !== count * 4) throw new Error(`${file}: expected ${count} floats, got ${bytes.byteLength / 4}`);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function writeSummary(rootDir, selectedRuns, radiusPx, weights) {
  const reports = selectedRuns.flatMap((run) => scenesOf(path.join(rootDir, 'runs', run)).map((scene) =>
    JSON.parse(readFileSync(path.join(rootDir, 'runs', run, scene, 'analysis', 'report.json'), 'utf8'))));
  const meanMs = reports.reduce((sum, report) => sum + report.simulateMsPerPoint, 0) / Math.max(reports.length, 1);
  const lines = ['# 映り込みの読む段診断', '', `模擬 1 点の平均: ${meanMs.toFixed(3)} ms`,
    `窓半径: ${radiusPx}px。ν: ${weights.join(', ')}`, ''];
  for (const run of selectedRuns) {
    for (const scene of scenesOf(path.join(rootDir, 'runs', run))) {
      const report = JSON.parse(readFileSync(path.join(rootDir, 'runs', run, scene, 'analysis', 'report.json'), 'utf8'));
      lines.push(`## ${run} / ${scene}`, '', '| L | S_L | N_L |', '|---:|---:|---:|');
      for (const row of report.levels) {
        lines.push(`| ${row.level} | ${row.structuralRms.toExponential(3)} | `
          + `${row.noiseRms.toExponential(3)} |`);
      }
      for (const nu of weights) appendGroupSummary(lines, report, nu);
      lines.push('');
    }
  }
  writeFileSync(path.join(rootDir, 'runs', selectedRuns.at(-1), 'summary.md'), lines.join('\n'));
}

function writeValidationMarkdown(rootDir, baselineRun) {
  const runDir = path.join(rootDir, 'runs', baselineRun);
  const lines = ['# 実測と模擬の照合', '',
    '| 撮影 | k | 組 | 実測 S/N/N8 | 模擬A S/N/N8 | 模擬B S/N/N8 | 平均ずれ | 1パス差/N | 雑音差/N |',
    '|---|---:|---|---|---|---|---:|---:|---:|'];
  for (const scene of scenesOf(runDir)) {
    const file = path.join(runDir, scene, 'analysis', 'validation.json');
    if (!existsSync(file)) continue;
    const validation = JSON.parse(readFileSync(file, 'utf8'));
    for (const row of validation.rows) {
      lines.push(`| ${scene} / ${row.run} | ${row.k} | ${row.group} | ${metricText(row.measured)} | `
        + `${metricText(row.simulatedA)} | ${metricText(row.simulatedB)} | `
        + `${row.meanOffset.toExponential(3)} | ${row.passDifferenceOverNoise.toExponential(3)} | ${row.noiseDifferenceOverNoise.toExponential(3)} |`);
    }
  }
  writeFileSync(path.join(runDir, 'validation.md'), lines.join('\n'));
}

function metricText(metric) {
  return `${metric.S.toExponential(3)} / ${metric.N.toExponential(3)} / ${metric.N8.toExponential(3)}`;
}

function appendGroupSummary(lines, report, nu) {
  lines.push('', `### ν = ${nu}`, '',
    '| 組 | 画素数 | 平均 Lcur | 平均 Lbal | over ≥ 1 | over ≤ −1 | S本番 | Sオラクル | N本番 | Nオラクル |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const [name, group] of Object.entries(report.groups[String(nu)])) {
    const metrics = group.metrics;
    const values = [name, group.count, metrics.meanLcur.toFixed(3), metrics.meanLbal.toFixed(3),
      `${(100 * metrics.overAtLeastOne).toFixed(2)}%`,
      `${(100 * metrics.overAtMostMinusOne).toFixed(2)}%`,
      metrics.productionStructuralRms.toExponential(3), metrics.oracleStructuralRms.toExponential(3),
      metrics.productionNoiseRms.toExponential(3), metrics.oracleNoiseRms.toExponential(3)];
    lines.push(`| ${values.join(' | ')} |`);
  }
  lines.push('', 'スケール別 RMS (RGB):', '');
  for (const [metric, scales] of Object.entries(report.scaleRms[String(nu)])) {
    const values = Object.entries(scales).map(([scale, scaleValues]) =>
      `${scale}=${scaleValues.map((value) => value.toExponential(2)).join('/')}`);
    lines.push(`- ${metric}: ${values.join(', ')}`);
  }
}

function option(name) {
  return args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}
