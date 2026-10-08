// Four candidate screen-space methods, timed in one render-lab page. This is a preliminary curve only;
// it does not capture or anonymize stimuli.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openChromeSession, sleep } from './chrome-session.mjs';
import { seedOf } from './screen-space-lab.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.render-lab');
const outputDir = path.join(root, '.render-lab-shots', 'ssd-8-blind', 'work');
const additionalOnly = process.argv.includes('--additional-only');
const rotatedCalibration = process.argv.includes('--rotated-calibration');
const highTune = process.argv.includes('--high-tune');
const highTuneQ8 = process.argv.includes('--high-tune-q8');
const highFinal = process.argv.includes('--high-final');
const highQuarter11 = process.argv.includes('--high-quarter11');
const highQuarter10 = process.argv.includes('--high-quarter10');
const outputName = highQuarter10 ? 'preliminary-timings-high-quarter10.json'
  : highQuarter11 ? 'preliminary-timings-high-quarter11.json'
  : highFinal ? 'preliminary-timings-high-final.json'
  : highTuneQ8 ? 'preliminary-timings-high-tune-q8.json'
  : highTune ? 'preliminary-timings-high-tune.json'
  : rotatedCalibration ? 'preliminary-timings-calibration.json'
  : additionalOnly ? 'preliminary-timings-additional.json' : 'preliminary-timings.json';
const port = 8773;
const debugPort = 9450;
const variants = ['band', 'q', 'raw-quarter', 'raw-full'];
const anchors = [
  { slices: 1, paths: 1, variants: ['raw-full'] },
  { slices: 2, paths: 1, variants: ['raw-full'] },
  { slices: 4, paths: 1, variants: ['raw-full'] },
];
const curvePoints = [
  ...[8, 12, 16].map((slices) => ({ slices, paths: 1, variants: ['band', 'q', 'raw-quarter'] })),
  { slices: 16, paths: 1, variants: ['q'], sparseTapCount: 12 },
  { slices: 16, paths: 1, variants: ['q'], sparseTapCount: 16 },
  { slices: 20, paths: 1, variants: ['raw-quarter'] },
  { slices: 24, paths: 1, variants: ['raw-quarter'] },
  ...[4, 8, 12, 16].map((slices) => ({ slices, paths: 2, variants: ['band', 'q', 'raw-quarter'] })),
  { slices: 6, paths: 2, variants: ['band'] },
  ...[4, 6, 8].map((slices) => ({ slices, paths: 4, variants: ['band', 'q', 'raw-quarter'] })),
  { slices: 7, paths: 4, variants: ['q'] },
];
const additionalPoints = [
  { slices: 20, paths: 1, variants: ['q'] },
  { slices: 9, paths: 2, variants: ['raw-quarter'] },
  { slices: 9, paths: 4, variants: ['raw-quarter'] },
];
const calibrationConfigs = {
  low: {
    band: { slices: 16, paths: 1 }, q: { slices: 20, paths: 1 },
    'raw-quarter': { slices: 22, paths: 1 }, 'raw-full': { slices: 1, paths: 1 },
  },
  medium: {
    band: { slices: 6, paths: 2 }, q: { slices: 8, paths: 2 },
    'raw-quarter': { slices: 9, paths: 2 }, 'raw-full': { slices: 2, paths: 1 },
  },
  high: {
    band: { slices: 6, paths: 4 }, q: { slices: 7, paths: 4 },
    'raw-quarter': { slices: 9, paths: 4 }, 'raw-full': { slices: 4, paths: 1 },
  },
};
const calibrationOrders = [
  ['band', 'q', 'raw-quarter', 'raw-full'],
  ['raw-full', 'raw-quarter', 'q', 'band'],
  ['q', 'raw-full', 'band', 'raw-quarter'],
];
const calibrationPoints = Object.entries(calibrationConfigs).flatMap(([budget, configs]) => (
  calibrationOrders.flatMap((order, round) => order.map((variant) => ({
    ...configs[variant], variants: [variant], budget, calibrationRound: round + 1,
  })))
));
const highTuneConfigs = {
  band: { slices: 7, paths: 4 }, q: { slices: highTuneQ8 ? 8 : 9, paths: 4 },
  'raw-quarter': { slices: 9, paths: 4 }, 'raw-full': { slices: 4, paths: 1 },
};
const highTuneOrders = [
  ['band', 'q', 'raw-quarter', 'raw-full'],
  ['raw-full', 'raw-quarter', 'q', 'band'],
  ['q', 'raw-full', 'band', 'raw-quarter'],
];
const highTunePoints = highTuneOrders.flatMap((order, round) => order.map((variant) => ({
  ...highTuneConfigs[variant], variants: [variant], budget: 'high', calibrationRound: round + 1,
})));
const highFinalConfigs = {
  band: { slices: 7, paths: 4 }, q8: { slices: 8, paths: 4 }, q9: { slices: 9, paths: 4 },
  'raw-quarter': { slices: 9, paths: 4 }, 'raw-full': { slices: 4, paths: 1 },
};
const highFinalOrders = [
  ['band', 'q8', 'raw-quarter', 'q9', 'raw-full'],
  ['raw-full', 'q9', 'raw-quarter', 'q8', 'band'],
  ['q8', 'raw-full', 'band', 'q9', 'raw-quarter'],
];
const highFinalPoints = highFinalOrders.flatMap((order, round) => order.map((name) => ({
  ...highFinalConfigs[name], variants: [name.startsWith('q') ? 'q' : name],
  budget: 'high', calibrationRound: round + 1, candidate: name,
})));
const highQuarter11Configs = {
  band: { slices: 7, paths: 4 }, 'raw-quarter': { slices: highQuarter10 ? 10 : 11, paths: 4 },
  'raw-full': { slices: 4, paths: 1 },
};
const highQuarter11Orders = [
  ['band', 'raw-quarter', 'raw-full'], ['raw-full', 'raw-quarter', 'band'], ['raw-quarter', 'band', 'raw-full'],
];
const highQuarter11Points = highQuarter11Orders.flatMap((order, round) => order.map((name) => ({
  ...highQuarter11Configs[name], variants: [name], budget: 'high', calibrationRound: round + 1, candidate: name,
})));
const points = highQuarter10 || highQuarter11 ? highQuarter11Points : highFinal ? highFinalPoints : highTune || highTuneQ8 ? highTunePoints : rotatedCalibration ? calibrationPoints
  : additionalOnly ? [...anchors, ...additionalPoints] : [...anchors, ...curvePoints];
const warmupFrames = 3;
const sampleFrames = 8;
const independentSamples = 8;

function tierOf(variant, slices) {
  return {
    scale: variant === 'raw-full' ? 1 : 0.25,
    sliceCount: slices,
    stepCount: 5,
    bandCount: variant === 'band' ? 4 : 1,
    bandScale: 3 / 4,
  };
}

function screenSpaceRows(measurement) {
  return Object.fromEntries(Object.entries(measurement.gpuPassMsById)
    .filter(([id]) => id.startsWith('nearbyDiffuse'))
    .map(([label, value]) => [label, value.p50]));
}

function screenSpaceTotal(rows) {
  return Object.values(rows).reduce((sum, value) => sum + value, 0);
}

async function readCorrectionSummary(devTools) {
  return devTools.evaluate(`(async () => {
    const { width, height, rgba } = await window.renderLab.readFloat("correction");
    let nonzeroRgbTexels = 0, nonzeroAlphaTexels = 0, maxAbsRgb = 0, finiteRgbChannels = 0;
    for (let pixel = 0; pixel < rgba.length; pixel += 4) {
      let pixelNonzero = false;
      for (let channel = 0; channel < 3; channel++) {
        const value = rgba[pixel + channel], magnitude = Math.abs(value);
        if (Number.isFinite(value)) finiteRgbChannels++;
        if (magnitude > maxAbsRgb) maxAbsRgb = magnitude;
        if (magnitude > 1e-8) pixelNonzero = true;
      }
      if (pixelNonzero) nonzeroRgbTexels++;
      if (Math.abs(rgba[pixel + 3]) > 1e-8) nonzeroAlphaTexels++;
    }
    return { width, height, nonzeroRgbTexels, nonzeroAlphaTexels, maxAbsRgb, finiteRgbChannels };
  })()`);
}

async function main() {
  execFileSync(process.execPath, [
    'node_modules/webpack-cli/bin/cli.js', '--config', 'webpack.render-lab.config.js', '--mode', 'production',
  ], { cwd: root, stdio: 'inherit' });
  mkdirSync(outputDir, { recursive: true });
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-render-lab-ssd8-curve-',
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    for (let attempt = 0; attempt < 600; attempt++) {
      if (await devTools.evaluate('typeof window.renderLab?.measureScreenSpacePaths === "function"')) break;
      await sleep(200);
    }
    const ready = await devTools.evaluate('typeof window.renderLab?.measureScreenSpacePaths === "function"');
    if (!ready) throw new Error('render-lab experiment timing API did not become ready');
    const adapter = await devTools.evaluate(
      '(async () => { const a = await navigator.gpu.requestAdapter(); const i = a.info ?? {};'
      + ' return [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(" / "); })()',
    );
    await devTools.evaluate('window.renderLab.showShot("bay", "bay-dark")');
    await devTools.evaluate('window.renderLab.setTarget("correction")');
    await devTools.evaluate('window.renderLab.setGraphicsOption("screenSpaceDiffuse", 2)');
    await devTools.evaluate('window.renderLab.setGraphicsOption("screenSpaceQuality", 2)');
    await devTools.evaluate('window.renderLab.setScanSeed(0, 0)');

    const results = [];
    for (const [round, point] of points.entries()) {
      const methods = round % 2 === 0 ? point.variants : [...point.variants].reverse();
      for (const variant of methods) {
        const config = { ...point, variant };
        const sparseTapCount = config.sparseTapCount ?? 8;
        const tier = tierOf(variant, config.slices);
        const seeds = Array.from({ length: config.paths }, (_, index) => seedOf(index));
        await devTools.evaluate('window.renderLab.setScanWhiteNoisePass(null)');
        await devTools.evaluate(`window.renderLab.setScanSeed(${seeds[0][0]}, ${seeds[0][1]})`);
        await devTools.evaluate(
          `window.renderLab.setScreenSpaceExperiment(${JSON.stringify(variant)}, ${JSON.stringify(tier)}, ${sparseTapCount})`,
        );
        const measurement = await devTools.evaluate(
          `window.renderLab.measureCurrent(${warmupFrames}, ${sampleFrames})`,
        );
        if (!measurement.gpuSupported) throw new Error('GPU timestamp queries are unavailable in this session');
        const rows = screenSpaceRows(measurement);
        const correctionProbe = config.paths === 1
          ? await readCorrectionSummary(devTools)
          : null;
        let multiPathRows = null;
        if (config.paths > 1) {
          const pathTiming = await devTools.evaluate(
            `window.renderLab.measureScreenSpacePaths(${JSON.stringify(seeds)}, ${independentSamples})`,
          );
          if (!pathTiming.gpuSupported) throw new Error('GPU timestamp queries were lost during path timing');
          multiPathRows = Object.fromEntries(Object.entries(pathTiming.gpuPassMsById)
            .filter(([id]) => id.startsWith('nearbyDiffuse'))
            .map(([id, value]) => [id, value.p50]));
        }
        const estimateMs = multiPathRows === null ? screenSpaceTotal(rows) : screenSpaceTotal(multiPathRows);
        const result = {
          variant, slices: config.slices, paths: config.paths, sparseTapCount, seeds, tier,
          budget: config.budget ?? null, calibrationRound: config.calibrationRound ?? null,
          candidate: config.candidate ?? null,
          frames: measurement.frames, rows, singlePathScreenSpaceP50Ms: screenSpaceTotal(rows),
          multiPathRows, pathMeasurementSamples: multiPathRows === null ? 0 : independentSamples,
          correctionProbe,
          estimatedScreenSpaceMs: estimateMs,
          cpuRenderP50Ms: measurement.cpuRenderMs.p50,
        };
        results.push(result);
        console.log(JSON.stringify(result));
      }
    }
    const oneSliceTier = { scale: 1, sliceCount: 1, stepCount: 5, bandCount: 1, bandScale: 0.75 };
    await devTools.evaluate('window.renderLab.setScanWhiteNoisePass(null)');
    await devTools.evaluate('window.renderLab.setScanSeed(0, 0)');
    await devTools.evaluate(
      `window.renderLab.setScreenSpaceExperiment("raw-full", ${JSON.stringify(oneSliceTier)}, 8)`,
    );
    const oneSliceFullRawMeasurement = await devTools.evaluate(
      `window.renderLab.measureCurrent(${warmupFrames}, ${sampleFrames})`,
    );
    if (!oneSliceFullRawMeasurement.gpuSupported) throw new Error('GPU timestamp queries are unavailable for one-slice raw');
    const oneSliceFullRaw = {
      slices: 1, paths: 1, rows: screenSpaceRows(oneSliceFullRawMeasurement),
      estimatedScreenSpaceMs: screenSpaceTotal(screenSpaceRows(oneSliceFullRawMeasurement)),
      cpuRenderP50Ms: oneSliceFullRawMeasurement.cpuRenderMs.p50,
      correctionProbe: await readCorrectionSummary(devTools),
    };
    const correctionPreviewDataUrl = await devTools.evaluate('window.renderLab.capture()');
    const correctionPreviewPath = path.join(outputDir, 'preview-raw-full-1slice-1path-correction.png');
    writeFileSync(correctionPreviewPath, Buffer.from(correctionPreviewDataUrl.split(',')[1], 'base64'));
    await devTools.evaluate('window.renderLab.setTarget("off")');
    const previewDataUrl = await devTools.evaluate('window.renderLab.capture()');
    const previewPath = path.join(outputDir, 'preview-raw-full-1slice-1path.png');
    writeFileSync(previewPath, Buffer.from(previewDataUrl.split(',')[1], 'base64'));
    await devTools.evaluate('window.renderLab.setScreenSpaceExperiment(null, {scale:0.25,sliceCount:4,stepCount:5,bandCount:4,bandScale:0.75})');
    const document = {
      capturedAt: new Date().toISOString(),
      branch: 'ssd-8-band-blocks',
      pageUrl: session.baseUrl,
      adapter,
      caseName: 'bay',
      shotName: 'bay-dark',
      screenSpaceRows: ['nearbyDiffuseScanSurface', 'nearbyDiffuseScan', 'nearbyDiffuseInputPyramid',
        'nearbyDiffuseBandReduce', 'nearbyDiffuseMerge', 'nearbyDiffuseUpsample',
        'nearbyDiffuseDenoise', 'nearbyDiffuseAverage'],
      warmupFrames,
      sampleFrames,
      independentSamples,
      order: results.map(({ variant, slices, paths, sparseTapCount, budget, calibrationRound, candidate }) => ({
        variant, slices, paths, sparseTapCount, budget, calibrationRound, candidate,
      })),
      results,
      ...(highTune ? {} : { oneSliceFullRaw }),
      previews: [path.basename(correctionPreviewPath), path.basename(previewPath)],
      note: 'For N > 1, each independent scan is followed by the candidate complete reconstruction, then the completed correction is accumulated. The reported GPU rows include source/surface once, all N scans and reconstructions, accumulation, clear, and final normalization.',
    };
    writeFileSync(path.join(outputDir, outputName), `${JSON.stringify(document, null, 2)}\n`);
    console.log(`Wrote ${path.relative(root, path.join(outputDir, outputName))}`);
  } finally {
    await session.close();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
