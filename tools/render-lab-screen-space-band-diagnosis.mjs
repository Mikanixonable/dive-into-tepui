// 収束帯の鎖への寄与と、1パス雑音の帯ごとの分布を記録する。
// 使い方: node tools/render-lab-screen-space-band-diagnosis.mjs --run=<label> [--scene=<name>] [--baseline=<label>] [--compare=<run>] [--routing]
// run を撮ったときと同じ src/ で走らせる(1 パスの帯を撮り直すため)。検査するのは A の一致だけで、道具の側の変更は通す。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { convergedBandsOf, mergedOf, packedOfSingleBand, readBands, rgbDifference } from './screen-space-chain-bands.mjs';
import { accumulateScaleRms, scaleRmsAccumulator, scaleRmsOf } from './screen-space-chain-scale-rms.mjs';
import { RUNS, SCAN_PIXELS, signedPng, unsignedPng } from './screen-space-chain-runs.mjs';
import { readFloats, withLab, writeFloats } from './screen-space-lab.mjs';
import { maskedRms, preparedScene, runRecordOf, writeBandDiagnosisIndex } from './screen-space-band-diagnosis-common.mjs';

const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const run = arg('run'), baseline = arg('baseline'), compare = arg('compare'), sceneArg = arg('scene');
const routingEnabled = process.argv.includes('--routing');
if (!run || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(run)) throw new Error('--run must be a safe lowercase label');
for (const [name, value] of [['baseline', baseline], ['compare', compare]]) {
  if (value && !/^[a-z0-9][a-z0-9-]{0,47}$/.test(value)) throw new Error(`--${name} must be a safe lowercase label`);
}
const runDir = path.join(RUNS, run);
const record = runRecordOf(run);
const scenes = Object.values(record.scenes ?? {}).filter((item) => !sceneArg || item.scene === sceneArg);
if (!scenes.length) throw new Error(`no recorded scene matches ${sceneArg ?? run}`);
const pixels = SCAN_PIXELS, bandCount = record.conditions.tier.bandCount, passes = record.conditions.passes;
const noiseRange = { first: 5000, count: 32 }, routingRange = { first: 5000, count: 8 };
const rgbaOf = (rgb) => {
  const rgba = new Float32Array(pixels * 4);
  for (let p = 0; p < pixels; p++) { rgba[4 * p] = rgb[3 * p]; rgba[4 * p + 1] = rgb[3 * p + 1]; rgba[4 * p + 2] = rgb[3 * p + 2]; rgba[4 * p + 3] = 1; }
  return rgba;
};
function absoluteQuantile(arrays, stride) {
  const values = [];
  for (const array of arrays) for (let i = 0; i < array.length; i += stride) for (let c = 0; c < 3; c++) values.push(Math.abs(array[i + c]));
  values.sort((a, b) => a - b);
  return Math.max(values[Math.floor(0.999 * (values.length - 1))], 1e-12);
}
function maskedMeanMagnitude(values, mask) {
  let sum = 0, count = 0;
  for (let p = 0; p < mask.length; p++) if (mask[p]) { sum += Math.sqrt((values[p * 4] ** 2 + values[p * 4 + 1] ** 2 + values[p * 4 + 2] ** 2) / 3); count++; }
  return sum / count;
}
function maxMagnitude(values, mask) {
  let max = 0;
  for (let p = 0; p < mask.length; p++) if (mask[p]) max = Math.max(max, Math.sqrt((values[p * 4] ** 2 + values[p * 4 + 1] ** 2 + values[p * 4 + 2] ** 2) / 3));
  return max;
}
function maxRgbDifference(a, b) {
  let maximum = 0;
  for (let p = 0; p < pixels; p++) for (let c = 0; c < 3; c++) maximum = Math.max(maximum, Math.abs(a[4 * p + c] - b[4 * p + c]));
  return maximum;
}
function addRgb(target, source) { for (let p = 0; p < target.length; p++) target[p] += source[p]; }
function maxInto(target, values, mask) {
  for (let p = 0; p < mask.length; p++) if (mask[p]) target[4 * p] = Math.max(target[4 * p], Math.sqrt((values[4 * p] ** 2 + values[4 * p + 1] ** 2 + values[4 * p + 2] ** 2) / 3));
}
function compareBands(sceneName) {
  const bands = convergedBandsOf(compare, sceneName);
  if (bands === null || bands.length !== bandCount) throw new Error(`${compare}/${sceneName}: compatible converged bands are missing`);
  const metricsPath = path.join(RUNS, compare, sceneName, 'metrics.json');
  const metrics = JSON.parse(readFileSync(metricsPath, 'utf8'));
  const sameCapture = metrics.caseName === record.scenes[sceneName].caseName && metrics.shot === record.scenes[sceneName].shot
    && metrics.conditions.passes === passes && metrics.conditions.tier.bandCount === bandCount
    && JSON.stringify(metrics.conditions.viewport) === JSON.stringify(record.conditions.viewport)
    && JSON.stringify(metrics.conditions.scanResolution) === JSON.stringify(record.conditions.scanResolution)
    && JSON.stringify(metrics.conditions.fixedFactors) === JSON.stringify(record.conditions.fixedFactors)
    && JSON.stringify(metrics.conditions.lighting ?? { occlusionOnly: false, graphics: {} }) === JSON.stringify(record.conditions.lighting ?? { occlusionOnly: false, graphics: {} });
  if (!sameCapture) {
    throw new Error(`${compare}/${sceneName}: comparison run does not match the same scene and capture conditions`);
  }
  return bands;
}

async function routingOf(lab, converged, mask) {
  const sums = Array.from({ length: bandCount }, () => Array.from({ length: bandCount }, () => new Float64Array(pixels * 3)));
  const maxima = Array.from({ length: bandCount }, () => Array.from({ length: bandCount }, () => new Float32Array(pixels)));
  const means = [];
  for (let band = 0; band < bandCount; band++) {
    means.push([]);
    for (let slot = band; slot < bandCount; slot++) means[band][slot] = (await mergedOf(lab, packedOfSingleBand(converged, band, slot))).merged;
  }
  for (let pass = routingRange.first; pass < routingRange.first + routingRange.count; pass++) {
    await lab.setStageRange('all'); await lab.renderProductionCorrectionPhase(pass, true);
    const onePass = await readBands(lab, bandCount);
    for (let band = 0; band < bandCount; band++) for (let slot = band; slot < bandCount; slot++) {
      const one = await mergedOf(lab, packedOfSingleBand(onePass, band, slot));
      const difference = rgbDifference(one.merged, means[band][slot]), cell = sums[band][slot], max = maxima[band][slot];
      for (let p = 0; p < pixels; p++) if (mask[p]) {
        let magnitude = 0;
        for (let c = 0; c < 3; c++) { const value = difference[p * 4 + c]; cell[p * 3 + c] += value * value; magnitude += value * value / 3; }
        max[p] = Math.max(max[p], Math.sqrt(magnitude));
      }
    }
  }
  const rms = [], max = [];
  for (let band = 0; band < bandCount; band++) {
    rms.push([]); max.push([]);
    for (let slot = 0; slot < bandCount; slot++) {
      if (slot < band) { rms[band].push(null); max[band].push(null); continue; }
      let square = 0, count = 0, peak = 0;
      for (let p = 0; p < pixels; p++) if (mask[p]) {
        for (let c = 0; c < 3; c++) { square += sums[band][slot][p * 3 + c] / routingRange.count; count++; }
        peak = Math.max(peak, maxima[band][slot][p]);
      }
      rms[band].push(Math.sqrt(square / count)); max[band].push(peak);
    }
  }
  return { seeds: [routingRange.first, routingRange.first + routingRange.count - 1], rms, max };
}

async function analyze(lab, sceneMetrics) {
  const sceneName = sceneMetrics.scene, dir = path.join(runDir, sceneName);
  const outputDir = path.join(dir, 'band-diagnosis'), converged = convergedBandsOf(run, sceneName);
  if (converged === null || converged.length !== bandCount) throw new Error(`${run}/${sceneName}: converged bands are missing or incompatible`);
  const compared = compare ? compareBands(sceneName) : null;
  const { mask, alphaMaximumDifference } = await preparedScene(lab, run, record, sceneName);

  const chained = [], structure = [], inputDiff = [], structureSquares = Array.from({ length: bandCount }, scaleRmsAccumulator);
  const structureSum = new Float32Array(pixels * 4), chainedSum = new Float32Array(pixels * 4);
  for (let band = 0; band < bandCount; band++) {
    const result = await mergedOf(lab, packedOfSingleBand(converged, band));
    chained.push(result.merged); structure.push(rgbDifference(result.bandSum, result.merged));
    addRgb(chainedSum, result.merged); addRgb(structureSum, structure[band]);
    accumulateScaleRms(structureSquares[band], structure[band], mask);
    if (compared) inputDiff.push(rgbaOf(converged[band].map((value, i) => value - compared[band][i])));
  }
  const expectedMerged = readFloats(path.join(dir, `merged-${passes}.rgba.f32`)), expectedStructure = readFloats(path.join(dir, `structure-${passes}.rgba.f32`));
  const linearity = { chainedRgbMaximumDifference: maxRgbDifference(chainedSum, expectedMerged), structureRgbMaximumDifference: maxRgbDifference(structureSum, expectedStructure) };

  const noiseSquares = Array.from({ length: bandCount }, () => new Float64Array(pixels * 3));
  const residual = Array.from({ length: bandCount }, () => new Float32Array(pixels * 4));
  const noise = Array.from({ length: bandCount }, () => new Float32Array(pixels * 4));
  const peak = Array.from({ length: bandCount }, () => new Float32Array(pixels * 4));
  const noiseScaleSquares = Array.from({ length: bandCount }, scaleRmsAccumulator);
  for (let pass = noiseRange.first; pass < noiseRange.first + noiseRange.count; pass++) {
    await lab.setStageRange('all'); await lab.renderProductionCorrectionPhase(pass, true);
    const onePass = await readBands(lab, bandCount);
    for (let band = 0; band < bandCount; band++) {
      const result = await mergedOf(lab, packedOfSingleBand(onePass, band)), difference = rgbDifference(result.merged, chained[band]);
      if (pass === noiseRange.first) residual[band] = difference;
      for (let p = 0; p < pixels; p++) for (let c = 0; c < 3; c++) noiseSquares[band][p * 3 + c] += difference[p * 4 + c] ** 2;
      maxInto(peak[band], difference, mask);
      accumulateScaleRms(noiseScaleSquares[band], difference, mask);
    }
  }
  for (let band = 0; band < bandCount; band++) {
    for (let p = 0; p < pixels; p++) {
      const magnitude = peak[band][p * 4];
      for (let c = 0; c < 3; c++) noise[band][p * 4 + c] = Math.sqrt(noiseSquares[band][p * 3 + c] / noiseRange.count);
      noise[band][p * 4 + 3] = peak[band][p * 4 + 3] = 1;
      peak[band][p * 4 + 1] = peak[band][p * 4 + 2] = magnitude;
    }
  }
  const signalScale = Math.max(absoluteQuantile(converged, 3), absoluteQuantile(chained, 4));
  const errorImages = [...structure, ...residual, ...(compared ? inputDiff : [])];
  const errorScale = absoluteQuantile(errorImages, 4);
  let scales = { signal: signalScale, error: errorScale };
  if (baseline) {
    const file = path.join(RUNS, baseline, sceneName, 'band-diagnosis', 'diagnosis.json');
    if (!existsSync(file)) throw new Error(`${baseline}/${sceneName}: baseline diagnosis is missing`);
    scales = JSON.parse(readFileSync(file, 'utf8')).scales;
  }
  const scaleRms = Array.from({ length: bandCount }, (_, band) => ({ structure: scaleRmsOf(structureSquares[band], mask),
    noise: scaleRmsOf(noiseScaleSquares[band], mask, noiseRange.count) }));
  mkdirSync(outputDir, { recursive: true });
  writeImages(outputDir, converged, chained, structure, residual, noise, peak, structureSum, chainedSum, compared ? inputDiff : null, scales);
  const bands = Array.from({ length: bandCount }, (_, band) => {
    const noiseMean = maskedMeanMagnitude(noise[band], mask), peakMean = maskedMeanMagnitude(peak[band], mask);
    return { band, inputSumAbs: converged[band].reduce((sum, value) => sum + Math.abs(value), 0),
      structureRms: maskedRms(structure[band], mask), noiseRms: maskedRms(noise[band], mask), peakMax: maxMagnitude(peak[band], mask),
      peakToNoise: peakMean / Math.max(noiseMean, 1e-30), scaleRms: scaleRms[band] };
  });
  const routing = routingEnabled ? await routingOf(lab, converged, mask) : undefined;
  const diagnosis = { run, scene: sceneName, bandCount, passes, noise: noiseRange, scales, alphaMaximumDifference, compare: compare ?? null,
    linearity, bands, ...(routing ? { routing } : {}) };
  writeFileSync(path.join(outputDir, 'diagnosis.json'), JSON.stringify(diagnosis, null, 2));
  console.log(JSON.stringify({ scene: sceneName, alphaMaximumDifference, linearity }));
}

function writeImages(dir, input, chained, structure, residual, noise, peak, structureSum, chainedSum, inputDiff, scales) {
  const writeSet = (name, values, scale, png = signedPng) => {
    for (const zoom of [1, 4]) writeFileSync(path.join(dir, `${name}.x${zoom}.png`), png(values, 4, scale / zoom));
  };
  const sums = { input: new Float32Array(pixels * 4), chained: chainedSum, structure: structureSum,
    residual: new Float32Array(pixels * 4), ...(inputDiff ? { 'input-diff': new Float32Array(pixels * 4) } : {}) };
  for (let band = 0; band < bandCount; band++) {
    writeSet(`input-${band}`, rgbaOf(input[band]), scales.signal); writeSet(`chained-${band}`, chained[band], scales.signal);
    writeSet(`structure-${band}`, structure[band], scales.error); writeSet(`residual-${band}`, residual[band], scales.error);
    writeSet(`noise-${band}`, noise[band], scales.error, unsignedPng); writeSet(`peak-${band}`, peak[band], scales.error, unsignedPng);
    addRgb(sums.input, rgbaOf(input[band])); addRgb(sums.residual, residual[band]);
    if (inputDiff) { writeSet(`input-diff-${band}`, inputDiff[band], scales.error); addRgb(sums['input-diff'], inputDiff[band]); }
    writeFloats(path.join(dir, `structure-${band}.rgba.f32`), structure[band]); writeFloats(path.join(dir, `noise-${band}.rgba.f32`), noise[band]);
    writeFloats(path.join(dir, `peak-${band}.rgba.f32`), peak[band]); writeFloats(path.join(dir, `chained-${band}.rgba.f32`), chained[band]);
  }
  for (const [kind, values] of Object.entries(sums)) writeSet(`${kind}-sum`, values, kind === 'input' || kind === 'chained' ? scales.signal : scales.error);
}

for (const item of scenes) {
  let completed = false;
  try { await withLab(async (lab) => { await analyze(lab, item); completed = true; }); }
  catch (error) { if (error?.code !== 'EPERM' || !completed) throw error; console.warn(`${item.scene}: outputs saved; Chrome profile cleanup returned EPERM`); }
}
writeBandDiagnosisIndex();
