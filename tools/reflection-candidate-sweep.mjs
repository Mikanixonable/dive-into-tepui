import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PIXELS, centeredPng, colorPng } from './reflection-chain-common.mjs';
import { absDifference, metricGroups, pointMetrics } from './reflection-read-level-metrics.mjs';
import { grayLevelPng } from './reflection-read-level-images.mjs';
import { ratiosFor } from './reflection-candidate-curve.mjs';
import { averageLevels, floats, loadLevelStack, loadLevels, makeCurveBand, makeRoughBand,
  readJson, simulatedPoint } from './reflection-level-simulator.mjs';

const args = process.argv.slice(2);
const [baselineRun, candidateRun] = args;
if (!baselineRun || !candidateRun) throw new Error('usage: node tools/reflection-candidate-sweep.mjs <baseline-run> <c1-run>');
const option = (name, fallback) => args.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3)
  .split(',').map(Number) ?? fallback;
const cValues = option('c', [0.03, 0.1, 0.3]);
const kValues = option('k', [1, 0.71, 0.5, 0.35]);
const floorValues = option('floor', null);
const sceneOption = args.find((value) => value.startsWith('--scene='))?.slice(8);
const root = path.join(path.resolve(import.meta.dirname, '..'), '.render-lab-shots', 'ssr-read-levels', 'runs');
const baselineDir = path.join(root, baselineRun);
const scenes = readdirSync(baselineDir).filter((scene) => (!sceneOption || scene === sceneOption)
  && existsSync(path.join(baselineDir, scene, 'meta.json')));
for (const scene of scenes) analyzeScene(scene);
writeMarkdown();

function analyzeScene(scene) {
  const baseDir = path.join(baselineDir, scene);
  const output = path.join(baseDir, 'analysis');
  mkdirSync(output, { recursive: true });
  const meta = readJson(path.join(baseDir, 'meta.json'));
  const report = readJson(path.join(output, 'report.json'));
  const candidateDir = path.join(root, candidateRun, scene);
  const base = floats(path.join(baseDir, 'q-b.f32'), PIXELS * 4);
  const stack = loadLevelStack(baseDir, meta);
  const baseline = loadLevels(baseDir);
  const candidate = loadLevels(candidateDir);
  const baselineMean = averageLevels(baseline);
  const production = floats(path.join(baseDir, 'q-production.f32'), PIXELS * 4);
  const rough = makeRoughBand(baseDir);
  const curve = makeCurveBand(baseDir);
  const mask = Uint8Array.from({ length: PIXELS }, (_, pixel) =>
    Number(base[pixel * 4 + 3] > 0 || production[pixel * 4 + 3] > 0));
  const groups = metricGroups(mask, rough, curve, baselineMean);
  if (floorValues === null) {
    const series = cValues.map((c) => makeSeries(c, baseline, candidate, stack, base, groups, baseDir, report, meta));
    writeFileSync(path.join(output, 'sweep.json'), JSON.stringify({ series }, null, 2));
  } else {
    const series = makeFloorSeries(floorValues, baseline, candidate, stack, base, groups, baseDir, report, meta);
    writeFileSync(path.join(output, 'floor.json'), JSON.stringify({ series: [series] }, null, 2));
  }
}

function makeSeries(c, baseline, candidate, stack, base, groups, baseDir, report, meta) {
  const points = makePoints(kValues, baseline, candidate, stack, base, groups, baseDir, report, meta,
    (k) => ({ key: String(k), label: `k=${k}`, name: `sweep-c${c}-k${k}` }),
    (k, levels, other) => combineLevels(levels, other, c, k),
    (k, maps) => {
      if (k !== 1) return { diff: '', level: '' };
      const level = `level-sweep-c${c}`;
      writeFileSync(path.join(baseDir, 'analysis', `${level}.png`), grayLevelPng(averageLevels(maps), meta.lmax));
      return { diff: '', level };
    });
  return { key: `sweep-c${c}`, label: `c=${c}（模擬）`, marker: 'triangle', line: true, points };
}

function makeFloorSeries(values, baseline, candidate, stack, base, groups, baseDir, report, meta) {
  const points = makePoints(values, baseline, candidate, stack, base, groups, baseDir, report, meta,
    (f) => ({ key: String(f), label: `f=${f}`, name: `floor-f${f}` }),
    (f, levels, other) => combineFloorLevels(levels, other, f),
    (f, maps, simulated) => {
      const level = `level-floor-f${f}`;
      const diff = `diff-floor-f${f}`;
      writeFileSync(path.join(baseDir, 'analysis', `${level}.png`), grayLevelPng(averageLevels(maps), meta.lmax));
      writeFileSync(path.join(baseDir, 'analysis', `${diff}.png`),
        centeredPng(absDifference(simulated.mean, base), report.display.differenceGain));
      return { diff, level };
    });
  return { key: 'floor', label: '曲面の下限（模擬）', marker: 'triangle', line: true, points };
}

function makePoints(values, baseline, candidate, stack, base, groups, baseDir, report, meta, describe, combine, writeExtraImages) {
  return values.map((value) => {
    const maps = baseline.map((levels, seed) => combine(value, levels, candidate[seed]));
    const simulated = simulatedPoint(stack, maps);
    const { key, label, name } = describe(value);
    const sample = `sample-${name}`;
    writeFileSync(path.join(baseDir, 'analysis', `${name}.png`), colorPng(simulated.mean, report.display.colorGain));
    writeFileSync(path.join(baseDir, 'analysis', `${sample}.png`), colorPng(simulated.samples[0], report.display.colorGain));
    const images = { mean: name, sample, ...writeExtraImages(value, maps, simulated) };
    const point = { key, label, metrics: pointMetrics(simulated.mean, simulated.samples, base, groups), images };
    point.ratio = ratiosFor(point.metrics, baseDir);
    return point;
  });
}

function combineLevels(first, second, c, k) {
  const result = new Float32Array(PIXELS);
  const offset = Math.log2(k);
  for (let pixel = 0; pixel < PIXELS; pixel++) {
    if (first[pixel] < 0) {
      result[pixel] = -1;
      continue;
    }
    const x0 = 2 ** Math.max(first[pixel], 0);
    const x1 = 2 ** Math.max(second[pixel], 0);
    const inverseWidth = (1 - c) / x0 + c / x1;
    result[pixel] = Math.max(0, -Math.log2(inverseWidth) + offset);
  }
  return result;
}

function combineFloorLevels(first, second, f) {
  const result = new Float32Array(PIXELS);
  for (let pixel = 0; pixel < PIXELS; pixel++) {
    if (first[pixel] < 0) {
      result[pixel] = -1;
      continue;
    }
    const x0 = 2 ** Math.max(first[pixel], 0);
    const x1 = 2 ** Math.max(second[pixel], 0);
    result[pixel] = Math.max(0, Math.log2(x0 * (f + (1 - f) * x1 / x0)));
  }
  return result;
}

function writeMarkdown() {
  if (floorValues !== null) {
    writeFloorMarkdown();
    return;
  }
  const groups = ['no-rim', 'curve-0', 'curve-1', 'curve-2', 'rough-1', 'rough-2'];
  const rows = [];
  const means = [];
  for (const scene of scenes) {
    const dir = path.join(baselineDir, scene, 'analysis');
    const sweepFile = path.join(dir, 'sweep.json');
    if (!existsSync(sweepFile)) continue;
    const data = readJson(sweepFile);
    const scatter = readJson(path.join(dir, 'scatter.json'));
    const reference = scatter.series.find((item) => item.key === 'production')?.points[0];
    for (const series of data.series) {
      const c = Number(series.key.slice('sweep-c'.length));
      for (const point of series.points) for (const group of groups) {
        const baseline = reference?.metrics[group];
        const metric = point.metrics[group];
        if (!baseline || !metric) continue;
        const nf = group === 'no-rim' ? point.metrics['no-rim-fine']?.N : null;
        rows.push(`| ${scene} | ${c} | ${point.key} | ${group} | ${fmt(metric.S)} | ${fmt(metric.N8)} | `
          + `${fmt(point.ratio[group])} | ${fmt(nf)} |`);
      }
    }
    const baselineLevels = loadLevels(path.join(root, baselineRun, scene));
    const candidateLevels = loadLevels(path.join(root, candidateRun, scene));
    for (const cValue of [0, 1]) {
      const levelMean = averageLevels(cValue ? candidateLevels : baselineLevels);
      for (const group of groups) {
        const result = meanOf(levelMean, groupMaskForMean(dir, group, baselineLevels));
        means.push(`| ${scene} | ${cValue} | ${group} | ${fmt(result)} |`);
      }
    }
  }
  const body = ['# 読む段 c × k 掃引', '', '| 撮影 | c | k | 組 | S | N8 | 曲線比 | Nf |',
    '|---|---:|---:|---|---:|---:|---:|---:|', ...rows, '', '## 段の平均', '',
    '| 撮影 | c | 組 | λ̄ |', '|---|---:|---|---:|', ...means].join('\n');
  writeFileSync(path.join(baselineDir, 'sweep.md'), body);
}

function writeFloorMarkdown() {
  const groups = ['no-rim', 'no-rim-fine', 'curve-0', 'curve-1', 'curve-2', 'rough-1', 'rough-2', 'rough-3'];
  const rows = [];
  for (const scene of scenes) {
    const dir = path.join(baselineDir, scene, 'analysis');
    const floorFile = path.join(dir, 'floor.json');
    if (!existsSync(floorFile)) continue;
    const data = readJson(floorFile);
    for (const series of data.series) for (const point of series.points) for (const group of groups) {
      const metric = point.metrics[group];
      if (!metric) continue;
      rows.push(`| ${scene} | ${point.key} | ${group} | ${fmt(metric.S)} | ${fmt(metric.N8)} | `
        + `${fmt(metric.N)} | ${fmt(point.ratio[group])} |`);
    }
  }
  const body = ['# 読む段 曲面の下限', '', '| 撮影 | f | 組 | S | N8 | N | 曲線比 |',
    '|---|---:|---|---:|---:|---:|---:|', ...rows].join('\n');
  writeFileSync(path.join(baselineDir, 'floor.md'), body);
}

function groupMaskForMean(dir, name, maps) {
  const mask = new Uint8Array(PIXELS);
  const curve = makeCurveBand(path.dirname(dir));
  const rough = makeRoughBand(path.dirname(dir));
  const level = averageLevels(maps);
  const base = floats(path.join(path.dirname(dir), 'q-b.f32'), PIXELS * 4);
  const production = floats(path.join(path.dirname(dir), 'q-production.f32'), PIXELS * 4);
  for (let pixel = 0; pixel < PIXELS; pixel++) {
    const inside = base[pixel * 4 + 3] > 0 || production[pixel * 4 + 3] > 0;
    const selected = name === 'no-rim' ? curve[pixel] !== 3
      : name.startsWith('curve-') ? curve[pixel] === Number(name.slice(6))
        : rough[pixel] === Number(name.slice(6));
    mask[pixel] = Number(inside && selected && level[pixel] >= 0);
  }
  return mask;
}

function meanOf(levels, mask) {
  let total = 0;
  let count = 0;
  for (let pixel = 0; pixel < PIXELS; pixel++) if (mask[pixel]) { total += levels[pixel]; count++; }
  return count ? total / count : NaN;
}

function fmt(value) {
  return Number.isFinite(value) ? value.toExponential(3) : '—';
}
