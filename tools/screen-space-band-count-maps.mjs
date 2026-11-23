import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RUNS, SCAN_HEIGHT, SCAN_PIXELS, SCAN_WIDTH, metricsOf, recordOf, sceneDirOf, signedPng, unsignedPng } from './screen-space-chain-runs.mjs';
import { SCALES } from './screen-space-chain-scale-rms.mjs';
import { readFloats } from './screen-space-lab.mjs';
import { convergedBandsOf } from './screen-space-chain-bands.mjs';
import { encodeRgbPng } from './png.mjs';

const QUANTILE_BY_TYPE = { signed: 0.999, unsigned: 0.995, share: 1 };
const LUMINANCE = [0.2126, 0.7152, 0.0722];
const FULL_IMAGE_IDS = [
  ['one-pass', 'one-pass-correction.png'],
  ['one-pass-phase1', 'one-pass-correction-phase1.png'],
  ['one-pass-phase2', 'one-pass-correction-phase2.png'],
  ['one-pass-phase3', 'one-pass-correction-phase3.png'],
  ['one-pass-clay', 'one-pass-diffuse-clay.png'],
];
const METRIC_TYPES = [
  { id: 'structure', prefix: 'structure', type: 'signed', metric: 'structure' },
  { id: 'noise', prefix: 'noise', type: 'unsigned', metric: 'noise' },
  { id: 'noise-seed', prefix: 'noise-seed', type: 'unsigned', metric: 'noiseSeed' },
];

function sceneNamesOf(run) {
  const runDir = path.join(RUNS, run);
  return readdirSync(runDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(runDir, entry.name, 'metrics.json')))
    .map((entry) => entry.name);
}

function passesOf(run) {
  return recordOf(run).conditions.passes;
}

function readMap(dir, file) {
  const filePath = path.join(dir, file);
  return existsSync(filePath) ? readFloats(filePath) : null;
}

function imageEntry(entries, id, values, type = 'signed') {
  if (values) entries[id] = { values, type };
}

function readFullImages(dir, passes, entries) {
  for (const [id, file] of FULL_IMAGE_IDS) {
    const source = path.join(dir, file);
    if (existsSync(source)) entries[id] = { source, fullResolution: true };
  }
  const meanPath = path.join(dir, `mean-${passes}-correction.png`);
  if (existsSync(meanPath)) entries.mean = { source: meanPath, fullResolution: true };
}

function readMetricMaps(dir, passes, entries) {
  const sources = {};
  for (const metric of METRIC_TYPES) {
    const wholeFile = metric.id === 'structure'
      ? `structure-${passes}.rgba.f32`
      : `${metric.prefix}-rms-${passes}.rgba.f32`;
    const whole = readMap(dir, wholeFile);
    sources[metric.id] = { whole, scales: {} };
    imageEntry(entries, metric.id, whole, metric.type);
    for (const scale of SCALES) {
      const values = readMap(dir, `${metric.prefix}-scale-${scale}-${passes}.rgba.f32`);
      sources[metric.id].scales[scale] = values;
      imageEntry(entries, `${metric.id}-s${scale}`, values, metric.type);
    }
  }
  const noise = sources.noise.whole;
  const seed = sources['noise-seed'].whole;
  if (noise && seed) {
    const raster = subtractRootMeanSquare(noise, seed);
    sources.noiseRaster = { whole: raster, scales: {} };
    imageEntry(entries, 'noise-raster', raster, 'unsigned');
  }
  const noiseSource = sources.noise;
  const seedSource = sources['noise-seed'];
  for (const scale of SCALES) {
    const noiseScale = noiseSource.scales[scale];
    const seedScale = seedSource.scales[scale];
    if (!noiseScale || !seedScale) continue;
    const rasterScale = subtractRootMeanSquare(noiseScale, seedScale);
    sources.noiseRaster ??= { whole: null, scales: {} };
    sources.noiseRaster.scales[scale] = rasterScale;
    imageEntry(entries, `noise-raster-s${scale}`, rasterScale, 'unsigned');
  }
  return sources;
}

function subtractRootMeanSquare(total, seed) {
  return Float32Array.from(total, (value, index) => index % 4 === 3
    ? 1
    : Math.sqrt(Math.max(value * value - seed[index] * seed[index], 0)));
}

function luminanceMagnitude(values, pixel) {
  const offset = pixel * 3;
  return LUMINANCE.reduce((sum, weight, channel) => sum + weight * Math.abs(values[offset + channel]), 0);
}

function bandDataOf(run, scene) {
  const bands = convergedBandsOf(run, scene);
  if (!bands) return null;
  const totals = bands.map((band) => {
    let total = 0;
    for (let pixel = 0; pixel < SCAN_PIXELS; pixel++) total += luminanceMagnitude(band, pixel);
    return total;
  });
  const share = new Float32Array(SCAN_PIXELS * 4);
  const coarsest = bands.at(-1);
  for (let pixel = 0; pixel < SCAN_PIXELS; pixel++) {
    let total = 0;
    for (const band of bands) total += luminanceMagnitude(band, pixel);
    share.fill(total === 0 ? 0 : luminanceMagnitude(coarsest, pixel) / total, pixel * 4, pixel * 4 + 3);
    share[pixel * 4 + 3] = 1;
  }
  return { totals, share };
}

function sceneSourcesOf(runs, scene) {
  const sources = {};
  for (const run of runs) {
    const metrics = metricsOf(run, scene);
    if (!metrics) continue;
    const dir = sceneDirOf(run, scene);
    const entries = {};
    readFullImages(dir, passesOf(run), entries);
    const maps = readMetricMaps(dir, passesOf(run), entries);
    const onePass = readMap(dir, 'scan-one-pass-merged.rgba.f32');
    const converged = readMap(dir, 'scan-converged-merged.rgba.f32');
    const bandSum = readMap(dir, `band-sum-${passesOf(run)}.rgba.f32`);
    imageEntry(entries, 'deviation', subtractMaps(onePass, converged), 'signed');
    const bandData = bandDataOf(run, scene);
    if (bandData) imageEntry(entries, 'top-share', bandData.share, 'share');
    sources[run] = {
      entries,
      maps,
      onePass,
      converged,
      bandSum,
      bandTotals: bandData?.totals ?? null,
      records: recordOf(run),
      metrics,
    };
  }
  return sources;
}

function subtractMaps(a, b) {
  if (!a || !b) return null;
  return Float32Array.from(a, (value, index) => index % 4 === 3 ? 1 : value - b[index]);
}

function pairNamesOf(sources) {
  const counts = [...new Set(Object.values(sources).map(({ records }) => records.conditions.tier.bandCount))]
    .sort((a, b) => a - b);
  const pairs = [];
  for (let index = 0; index < counts.length - 1; index++) pairs.push([counts[index], counts[index + 1]]);
  if (counts.length > 1) {
    pairs.push([counts[0], counts.at(-1)]);
    const five = counts.find((count) => count === 5);
    if (five !== undefined) pairs.push([five, counts.at(-1)]);
  }
  return pairs;
}

function sourceForCount(sources, count) {
  return Object.entries(sources).find(([, source]) => source.records.conditions.tier.bandCount === count)?.[0] ?? null;
}

function absoluteLuminanceDifference(a, b) {
  if (!a || !b) return null;
  const result = new Float32Array(a.length);
  for (let pixel = 0; pixel < a.length / 4; pixel++) {
    let difference = 0;
    for (let channel = 0; channel < 3; channel++) {
      const index = pixel * 4 + channel;
      difference += LUMINANCE[channel] * (Math.abs(b[index]) - Math.abs(a[index]));
    }
    result[pixel * 4] = difference;
    result[pixel * 4 + 1] = difference;
    result[pixel * 4 + 2] = difference;
    result[pixel * 4 + 3] = 1;
  }
  return result;
}

function differenceOf(a, b) {
  if (!a || !b) return null;
  const result = new Float32Array(a.length);
  for (let pixel = 0; pixel < a.length / 4; pixel++) {
    let difference = 0;
    for (let channel = 0; channel < 3; channel++) {
      difference += LUMINANCE[channel] * (b[pixel * 4 + channel] - a[pixel * 4 + channel]);
    }
    result[pixel * 4] = difference;
    result[pixel * 4 + 1] = difference;
    result[pixel * 4 + 2] = difference;
    result[pixel * 4 + 3] = 1;
  }
  return result;
}

function pairEntriesOf(sources, pairs) {
  const result = {};
  for (const [countA, countB] of pairs) {
    const runA = sourceForCount(sources, countA);
    const runB = sourceForCount(sources, countB);
    if (!runA || !runB) continue;
    const sourceA = sources[runA];
    const sourceB = sources[runB];
    const entries = {};
    imageEntry(entries, 'delta-merged', subtractMaps(sourceB.converged, sourceA.converged), 'signed');
    for (const metric of ['structure', 'noise', 'noise-seed']) {
      const delta = metric === 'structure' ? absoluteLuminanceDifference : differenceOf;
      imageEntry(entries, `delta-${metric}`, delta(sourceA.maps[metric]?.whole, sourceB.maps[metric]?.whole), 'diverging');
      for (const scale of SCALES) {
        imageEntry(entries, `delta-${metric}-s${scale}`,
          delta(sourceA.maps[metric]?.scales[scale], sourceB.maps[metric]?.scales[scale]), 'diverging');
      }
    }
    result[`${countA}-${countB}`] = { counts: [countA, countB], runs: [runA, runB], entries };
  }
  return result;
}

function quantileScale(values, type) {
  const magnitudes = [];
  for (let index = 0; index < values.length; index += 4) {
    for (let channel = 0; channel < 3; channel++) {
      const component = values[index + channel];
      magnitudes.push(type === 'share' ? Math.max(0, component) : Math.abs(component));
    }
  }
  magnitudes.sort((a, b) => a - b);
  const value = magnitudes[Math.floor(QUANTILE_BY_TYPE[type] * (magnitudes.length - 1))] || 1e-12;
  return 2 ** Math.ceil(Math.log2(value));
}

function collectScalesOf(sources, pairs) {
  const scales = {};
  const referenceRun = Object.keys(sources).at(-1);
  const reference = sources[referenceRun];
  for (const [id, entry] of Object.entries(reference?.entries ?? {})) {
    if (entry.values && !entry.fullResolution) scales[`kind:${id}`] = quantileScale(entry.values, entry.type);
  }
  const valuesByDeltaKind = {};
  const typesByDeltaKind = {};
  for (const pair of Object.values(pairs)) {
    for (const [id, entry] of Object.entries(pair.entries)) {
      if (!entry.values) continue;
      valuesByDeltaKind[id] ??= [];
      typesByDeltaKind[id] = entry.type === 'diverging' ? 'signed' : entry.type;
      for (let index = 0; index < entry.values.length; index += 4) {
        for (let channel = 0; channel < 3; channel++) valuesByDeltaKind[id].push(entry.values[index + channel]);
      }
    }
  }
  for (const [id, values] of Object.entries(valuesByDeltaKind)) {
    const packed = new Float32Array(values.length * 4);
    for (let index = 0; index < values.length; index++) packed[index * 4] = values[index];
    scales[`delta-kind:${id}`] = quantileScale(packed, typesByDeltaKind[id]);
  }
  return scales;
}

// 0 を灰色、正を赤、負を青で描く。
function divergingRgb(values, scale) {
  const rgb = new Uint8Array(SCAN_PIXELS * 3);
  for (let pixel = 0; pixel < SCAN_PIXELS; pixel++) {
    const ratio = Math.max(-1, Math.min(1, values[pixel * 4] / scale));
    const strength = Math.abs(ratio);
    const color = ratio > 0
      ? [128 + 127 * strength, 128 - 128 * strength, 128 - 128 * strength]
      : [128 - 128 * strength, 128 - 128 * strength, 128 + 127 * strength];
    for (let channel = 0; channel < 3; channel++) rgb[pixel * 3 + channel] = Math.round(color[channel]);
  }
  return rgb;
}

function pngOf(entry, scale) {
  if (entry.type === 'signed') return signedPng(entry.values, 4, scale);
  if (entry.type === 'diverging') return encodeRgbPng(SCAN_WIDTH, SCAN_HEIGHT, divergingRgb(entry.values, scale));
  return unsignedPng(entry.values, 4, scale);
}

function saveRunImages(out, scene, sources, scales) {
  const files = {};
  for (const [run, source] of Object.entries(sources)) {
    files[run] = {};
    const target = path.join(out, run, scene);
    mkdirSync(target, { recursive: true });
    for (const [id, entry] of Object.entries(source.entries)) {
      if (entry.fullResolution) {
        files[run][id] = relativePath(out, entry.source);
        continue;
      }
      if (!entry.values) continue;
      const scale = scales[`kind:${id}`];
      const targetPath = path.join(target, `${id}.png`);
      writeFileSync(targetPath, pngOf(entry, scale));
      files[run][id] = relativePath(out, targetPath);
    }
  }
  return files;
}

function savePairImages(out, scene, pairs, scales) {
  const files = {};
  for (const [pairName, pair] of Object.entries(pairs)) {
    files[pairName] = {};
    const target = path.join(out, `delta-${pairName}`, scene);
    mkdirSync(target, { recursive: true });
    for (const [id, entry] of Object.entries(pair.entries)) {
      if (!entry.values) continue;
      const scale = scales[`delta-kind:${id}`];
      const targetPath = path.join(target, `${id}.png`);
      writeFileSync(targetPath, pngOf(entry, scale));
      files[pairName][id] = relativePath(out, targetPath);
    }
  }
  return files;
}

function relativePath(out, target) {
  return path.relative(path.dirname(out), target).replaceAll('\\', '/');
}

function controlsOf(controls, scene) {
  const selected = {};
  for (const run of controls) {
    const metrics = metricsOf(run, scene);
    if (!metrics) continue;
    selected[run] = { metrics, records: recordOf(run) };
  }
  return selected;
}

function sceneDataOf(scene, runs, controls, out) {
  const runList = runs.filter((run) => metricsOf(run, scene));
  if (runList.length === 0) return null;
  const sources = sceneSourcesOf(runList, scene);
  const pairEntries = pairEntriesOf(sources, pairNamesOf(sources));
  const scales = collectScalesOf(sources, pairEntries);
  const files = saveRunImages(out, scene, sources, scales);
  const pairFiles = savePairImages(out, scene, pairEntries, scales);
  const controlData = controlsOf(controls, scene);
  return {
    name: scene,
    runs: Object.keys(sources),
    files,
    pairs: Object.fromEntries(Object.keys(pairEntries).map((key) => [key, true])),
    pairFiles,
    pairRuns: Object.fromEntries(Object.entries(pairEntries).map(([key, value]) => [key, value.runs])),
    counts: Object.fromEntries(Object.entries(sources).map(([run, value]) => [run, value.records.conditions.tier.bandCount])),
    bands: Object.fromEntries(Object.entries(sources).map(([run, value]) => [run, value.bandTotals])),
    records: Object.fromEntries(Object.entries(sources).map(([run, value]) => [run, { conditions: value.records.conditions }])),
    metrics: Object.fromEntries(Object.entries(sources).map(([run, value]) => [run, { scaleRms: value.metrics.scaleRms }])),
    controls: Object.fromEntries(Object.entries(controlData).map(([run, value]) => [run, { metrics: { scaleRms: value.metrics.scaleRms } }])),
    controlCounts: Object.fromEntries(Object.entries(controlData).map(([run, value]) => [run, value.records.conditions.tier.bandCount])),
    bandSumInspection: bandSumInspectionOf(sources),
    scales,
  };
}

function bandSumInspectionOf(sources) {
  const referenceRun = Object.keys(sources).at(-1);
  const reference = sources[referenceRun]?.bandSum;
  const inspection = {};
  for (const [run, source] of Object.entries(sources)) {
    if (!reference || !source.bandSum) {
      inspection[run] = null;
      continue;
    }
    let absoluteSum = 0;
    let maximum = 0;
    let count = 0;
    for (let index = 0; index < source.bandSum.length; index += 4) {
      for (let channel = 0; channel < 3; channel++) {
        const difference = Math.abs(source.bandSum[index + channel] - reference[index + channel]);
        absoluteSum += difference;
        maximum = Math.max(maximum, difference);
        count++;
      }
    }
    inspection[run] = { meanAbsoluteDifference: absoluteSum / count, maximumDifference: maximum };
  }
  return inspection;
}

export function buildComparison(runs, controls, out, pageWriter) {
  mkdirSync(out, { recursive: true });
  const scenes = [...new Set(runs.flatMap(sceneNamesOf))];
  const sceneResults = scenes.map((scene) => sceneDataOf(scene, runs, controls, out)).filter(Boolean);
  const scaleManifest = Object.fromEntries(sceneResults.map((scene) => [scene.name, scene.scales]));
  writeFileSync(path.join(out, 'scales.json'), JSON.stringify(scaleManifest, null, 2));
  const html = pageWriter(sceneResults);
  writeFileSync(`${out}.html`, html, 'utf8');
  return { scenes: sceneResults, html };
}
