import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ONE_PASS, PIXELS, centeredPng, colorPng } from './reflection-chain-common.mjs';
import { absDifference, metricGroups, pointMetrics } from './reflection-read-level-metrics.mjs';
import { grayLevelPng } from './reflection-read-level-images.mjs';
import { averageLevels, floats, loadLevelStack, loadLevels, makeCurveBand, makeRoughBand, readJson,
  shifted, simulatedPoint } from './reflection-level-simulator.mjs';
import { ratiosFor } from './reflection-candidate-curve.mjs';

const args = process.argv.slice(2);
const [baselineRun, ...candidateArgs] = args;
if (!baselineRun || !candidateArgs.length) {
  throw new Error('usage: node tools/reflection-candidate-scatter.mjs <baseline-run> <run>:<label> [...]');
}
const candidates = candidateArgs.map(parseCandidate);
const root = path.join(path.resolve(import.meta.dirname, '..'), '.render-lab-shots', 'ssr-read-levels', 'runs');
const baselineDir = path.join(root, baselineRun);
const scenes = readdirSync(baselineDir).filter((scene) => existsSync(path.join(baselineDir, scene, 'meta.json')));
for (const scene of scenes) analyzeScene(scene);
writeMarkdown();

function parseCandidate(value) {
  const separator = value.indexOf(':');
  if (separator < 1 || separator === value.length - 1) throw new Error(`invalid candidate: ${value}`);
  return { run: value.slice(0, separator), label: value.slice(separator + 1) };
}

function analyzeScene(scene) {
  const baseDir = path.join(baselineDir, scene);
  const output = path.join(baseDir, 'analysis');
  mkdirSync(output, { recursive: true });
  const meta = readJson(path.join(baseDir, 'meta.json'));
  const report = readJson(path.join(output, 'report.json'));
  const base = floats(path.join(baseDir, 'q-b.f32'), PIXELS * 4);
  const stack = loadLevelStack(baseDir, meta);
  const baselineMaps = loadLevels(baseDir);
  const levelCurrent = averageLevels(baselineMaps);
  const production = floats(path.join(baseDir, 'q-production.f32'), PIXELS * 4);
  const roughBand = makeRoughBand(baseDir);
  const curveBand = makeCurveBand(baseDir);
  const mask = Uint8Array.from({ length: PIXELS }, (_, pixel) =>
    Number(base[pixel * 4 + 3] > 0 || production[pixel * 4 + 3] > 0));
  const groups = metricGroups(mask, roughBand, curveBand, levelCurrent);
  const series = candidates.map((candidate) => candidateSeries(candidate, scene, baseDir, stack, base, groups,
    report.display.colorGain, report.display.differenceGain, meta.lmax));
  const groupPixels = Object.fromEntries(Object.entries(groups).map(([name, group]) =>
    [name, group.reduce((count, value) => count + Number(value > 0), 0)]));
  writeFileSync(path.join(output, 'candidates.json'), JSON.stringify({ series, groupPixels }, null, 2));
  return { scene, series, groups };
}

function candidateSeries(candidate, scene, baseDir, stack, base, groups, colorGain, diffGain, lmax) {
  const dir = path.join(root, candidate.run, scene);
  const meta = readJson(path.join(dir, 'meta.json'));
  if (!meta.productionOnly) throw new Error(`candidate run must use --production-only: ${candidate.run}`);
  const maps = loadLevels(dir);
  const mean = floats(path.join(dir, 'q-production.f32'), PIXELS * 4);
  const samples = Array.from({ length: ONE_PASS }, (_, seed) => floats(
    path.join(dir, `sample-production-s${seed}.f32`), PIXELS * 4));
  const measured = { key: 'real', label: '実測', marker: 'open-triangle', measured: true,
    metrics: pointMetrics(mean, samples, base, groups),
    images: saveImages(baseDir, `cand-${candidate.run}-real`, mean, samples[0], base, diffGain,
      averageLevels(maps), lmax, colorGain) };
  const points = [measured];
  for (const scale of [1, 0.71, 0.5, 0.35, 0.25]) {
    const shiftedMaps = maps.map((levels) => scale === 1 ? levels : shifted(levels, Math.log2(scale)));
    const simulated = simulatedPoint(stack, shiftedMaps);
    const key = String(scale);
    const name = `cand-${candidate.run}-k${key}`;
    const sampleName = `sample-${name}`;
    writeFileSync(path.join(baseDir, 'analysis', `${name}.png`), colorPng(simulated.mean, colorGain));
    writeFileSync(path.join(baseDir, 'analysis', `${sampleName}.png`), colorPng(simulated.samples[0], colorGain));
    points.push({ key, label: `k = ${key}`, metrics: pointMetrics(simulated.mean, simulated.samples, base, groups),
      images: { mean: name, sample: sampleName, diff: '', level: '' } });
  }
  for (const point of points) point.ratio = ratiosFor(point.metrics, baseDir);
  return { key: `cand-${candidate.run}`, label: candidate.label, marker: 'triangle', line: true, points };
}

function saveImages(baseDir, name, mean, sample, base, diffGain, levels, lmax, colorGain) {
  const analysis = path.join(baseDir, 'analysis');
  const sampleName = `sample-${name}`;
  writeFileSync(path.join(analysis, `${name}.png`), colorPng(mean, colorGain));
  writeFileSync(path.join(analysis, `${sampleName}.png`), colorPng(sample, colorGain));
  const diffName = `diff-${name}`;
  const levelName = `level-${name}`;
  writeFileSync(path.join(analysis, `${diffName}.png`), centeredPng(absDifference(mean, base), diffGain));
  writeFileSync(path.join(analysis, `${levelName}.png`), grayLevelPng(levels, lmax));
  return { mean: name, sample: sampleName, diff: diffName, level: levelName };
}

function writeMarkdown() {
  const rows = [];
  const groups = ['no-rim', 'curve-0', 'curve-1', 'curve-2', 'curve-3',
    'rough-0', 'rough-1', 'rough-2', 'rough-3'];
  for (const scene of scenes) {
    const dir = path.join(baselineDir, scene, 'analysis');
    const candidatesFile = path.join(dir, 'candidates.json');
    if (!existsSync(candidatesFile)) continue;
    const actual = readJson(path.join(dir, 'scatter.json'));
    const production = actual.series.find((series) => series.key === 'production')?.points[0];
    const data = readJson(candidatesFile);
    for (const series of data.series) {
      for (const point of series.points) {
        for (const group of groups) {
          const baselineMetric = production?.metrics[group];
          const metric = point.metrics[group];
          if (!baselineMetric || !metric || data.groupPixels[group] === 0) continue;
          const fineBase = production.metrics['no-rim-fine']?.N;
          const fineCandidate = point.metrics['no-rim-fine']?.N;
          const nfBase = group === 'no-rim' ? fineBase : null;
          const nfCandidate = group === 'no-rim' ? fineCandidate : null;
          rows.push(`| ${scene} | ${series.label} | ${point.label} | ${group} | ${fmt(baselineMetric.S)} | `
            + `${fmt(baselineMetric.N8)} | ${fmt(baselineMetric.N)} | ${fmt(metric.S)} | ${fmt(metric.N8)} | `
            + `${fmt(metric.N)} | ${fmt(nfBase)} | ${fmt(nfCandidate)} | ${fmt(point.ratio?.[group])} |`);
        }
      }
    }
  }
  const header = '| 撮影 | 候補 | 点 | 組 | 本番 S | 本番 N8 | 本番 N | 候補 S | 候補 N8 | 候補 N | Nf 本番 | Nf 候補 | 曲線比 |';
  const separator = '|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|';
  writeFileSync(path.join(baselineDir, 'candidates.md'), ['# 読む段候補', '', header, separator, ...rows].join('\n'));
}

function fmt(value) {
  return Number.isFinite(value) ? value.toExponential(3) : '—';
}
