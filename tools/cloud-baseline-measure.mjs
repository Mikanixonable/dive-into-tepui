// 雲なし／雲ありの観測済み render timestamp 合計を、反復ブロックで比較する。
// すべての GPU 命令の完了時刻や画面提示時刻とは区別する。
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';
import { qualifyObservedRenderBaseline, summarizeBaselineBlocks } from './cloud-baseline-statistics.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.render-lab');
const outputPath = path.join(buildDir, 'cloud-baseline.json');
const BLOCK_COUNT = 8;
const CASE_NAME = 'earth';
const SHOT_NAME = 'cloud-standard-near-range-250km';
const FIXTURE_WIDTH = 960;
const FIXTURE_HEIGHT = 540;
const modes = [
  { id: 'generated-standard', source: 'generated' },
  { id: 'observed-standard', source: 'observed' },
];

function distribution(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (ratio) => sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
  return {
    samples: values.length,
    avg: values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0,
  };
}

function summarizeObservedRenderRepeats(blocks) {
  const modesSummary = {};
  for (const mode of modes) {
    const deltas = [];
    const noise = [];
    for (const block of blocks) {
      const runs = block.modes[mode.id];
      const before = runs.offBefore.measurement.observedRenderTotalMs.p95;
      const cloud = runs.cloudOn.measurement.observedRenderTotalMs.p95;
      const after = runs.offAfter.measurement.observedRenderTotalMs.p95;
      deltas.push(cloud - (before + after) / 2);
      noise.push(Math.abs(after - before));
    }
    modesSummary[mode.id] = {
      pairedObservedRenderP95DeltaMs: distribution(deltas),
      offOffRepeatabilityNoiseFloorMs: distribution(noise),
    };
  }
  return {
    scope: 'observed-render-total',
    pairedDeltaDefinition: 'cloud-on observed-render p95 minus the mean of the same block\'s surrounding cloud-off observed-render p95 values',
    noiseFloorDefinition: 'absolute difference between the same block\'s surrounding cloud-off observed-render p95 values',
    modes: modesSummary,
  };
}

function systemGraphicsIdentity() {
  if (process.platform !== 'darwin') return null;
  try {
    const result = execFileSync('system_profiler', ['-json', 'SPDisplaysDataType'], {
      encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const displays = JSON.parse(result).SPDisplaysDataType ?? [];
    return displays.map((display) => ({
      chipset: display.sppci_model ?? null,
      vendor: display.sppci_vendor ?? null,
      cores: display.sppci_cores ?? null,
      metalSupport: display.spdisplays_mtlgpufamilysupport ?? null,
      displays: (display.spdisplays_ndrvs ?? []).map((screen) => ({
        resolution: screen._spdisplays_resolution ?? null,
        pixelDepth: screen.spdisplays_pixels ?? null,
      })),
    }));
  } catch {
    return null;
  }
}

async function main() {
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port: 8770, debugPort: 9447,
    profilePrefix: 'tepui-cloud-baseline-', onEvent,
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    await waitFor(
      devTools,
      "(document.getElementById('error')?.textContent || typeof window.renderLab?.measure === 'function')",
      'the render lab to initialise',
    );
    const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
    if (failure) throw new Error(`Render lab failed to initialise: ${failure}`);

    const [device, browser] = await Promise.all([
      devTools.evaluate(`(async () => {
        const adapter = await navigator.gpu?.requestAdapter();
        const canvas = document.querySelector('canvas');
        return {
          adapter: adapter ? {
            vendor: adapter.info.vendor,
            architecture: adapter.info.architecture,
            device: adapter.info.device,
            description: adapter.info.description,
            fallback: adapter.isFallbackAdapter,
            timestampQueryAdvertised: adapter.features.has('timestamp-query'),
          } : null,
          userAgent: navigator.userAgent,
          devicePixelRatio,
          canvasWidth: canvas?.width ?? null,
          canvasHeight: canvas?.height ?? null,
        };
      })()`),
      devTools.send('Browser.getVersion'),
    ]);
    if (device.canvasWidth !== FIXTURE_WIDTH || device.canvasHeight !== FIXTURE_HEIGHT) {
      throw new Error(`Expected ${FIXTURE_WIDTH}x${FIXTURE_HEIGHT} render-lab canvas, got `
        + `${device.canvasWidth}x${device.canvasHeight}`);
    }
    const initialGraphicsSettings = await devTools.evaluate('window.renderLab.graphicsSettings()');
    const blocks = [];
    const measure = async (source, clouds) => {
      const graphics = { cloudFieldSource: source, clouds };
      return await devTools.evaluate(`(async () => {
        const measurement = await window.renderLab.measureShot(${JSON.stringify(CASE_NAME)}, ${JSON.stringify(SHOT_NAME)}, ${JSON.stringify(graphics)});
        return { graphicsSettings: window.renderLab.graphicsSettings(), measurement };
      })()`);
    };

    for (let index = 0; index < BLOCK_COUNT; index += 1) {
      const block = { index, modes: {} };
      const orderedModes = index % 2 === 0 ? modes : [...modes].reverse();
      for (const mode of orderedModes) {
        // 雲ありを挟む二つの雲なし計測から、局所的な反復誤差を求める。
        const before = await measure(mode.source, false);
        const cloud = await measure(mode.source, true);
        const after = await measure(mode.source, false);
        for (const [label, run] of [['offBefore', before], ['cloudOn', cloud], ['offAfter', after]]) {
          if (run.measurement.gpuSupported && !(run.measurement.gpuPassTotalMs.p95 > 0)) {
            throw new Error(`Timestamp queries returned no usable pass timings for ${mode.id}/${label}`);
          }
          if (run.measurement.gpuSupported
            && (run.measurement.observedRenderCompleteFrames !== run.measurement.frames
              || !(run.measurement.observedRenderTotalMs.p95 > 0))) {
            throw new Error(`Observed render timestamps were incomplete for ${mode.id}/${label}`);
          }
        }
        block.modes[mode.id] = { offBefore: before, cloudOn: cloud, offAfter: after };
        console.log(`${mode.id} block=${index + 1}/${BLOCK_COUNT}: observed render p95 `
          + `off=${before.measurement.observedRenderTotalMs.p95.toFixed(3)}/`
          + `${after.measurement.observedRenderTotalMs.p95.toFixed(3)} ms, `
          + `cloud=${cloud.measurement.observedRenderTotalMs.p95.toFixed(3)} ms; `
          + `instrumented pass p95 off=${before.measurement.gpuPassTotalMs.p95.toFixed(3)}/`
          + `${after.measurement.gpuPassTotalMs.p95.toFixed(3)} ms, `
          + `cloud=${cloud.measurement.gpuPassTotalMs.p95.toFixed(3)} ms`);
      }
      blocks.push(block);
    }

    if (fatalEvents.length > 0) throw new Error(`Page reported errors:\n${fatalEvents.join('\n')}`);
    const gpuSupported = blocks.every((block) => Object.values(block.modes)
      .every((entry) => entry.offBefore.measurement.gpuSupported
        && entry.cloudOn.measurement.gpuSupported
        && entry.offAfter.measurement.gpuSupported));
    const computeQueryCount = blocks.reduce((sum, block) => sum + Object.values(block.modes).reduce((modeSum, entry) =>
      modeSum + ['offBefore', 'cloudOn', 'offAfter'].reduce((runSum, key) =>
        runSum + entry[key].measurement.observedComputeResolvedQueryCounts.reduce((count, queries) => count + queries, 0), 0), 0), 0);
    const computeExpectedQueryCount = blocks.reduce((sum, block) => sum + Object.values(block.modes).reduce((modeSum, entry) =>
      modeSum + ['offBefore', 'cloudOn', 'offAfter'].reduce((runSum, key) =>
        runSum + entry[key].measurement.observedComputeExpectedQueryCounts.reduce((count, queries) => count + queries, 0), 0), 0), 0);
    const systemGraphics = systemGraphicsIdentity();
    const result = {
      recordedAt: new Date().toISOString(),
      host: {
        platform: process.platform,
        architecture: process.arch,
        osRelease: os.release(),
        systemGraphics,
      },
      browser: { product: browser.product, userAgent: browser.userAgent, jsVersion: browser.jsVersion },
      device,
      caseName: CASE_NAME,
      shotName: SHOT_NAME,
      fixture: {
        qualityPreset: 'medium',
        canvasWidth: FIXTURE_WIDTH,
        canvasHeight: FIXTURE_HEIGHT,
      },
      sampleFramesPerMeasurement: blocks[0]?.modes[modes[0].id]?.cloudOn.measurement.frames ?? 0,
      blockCount: BLOCK_COUNT,
      quality: { preset: 'medium', cumulusDetail: 'standard' },
      initialGraphicsSettings,
      measurementScope: 'observed-render-total',
      passMeasurementScope: 'instrumented-render-pass-sum',
      fullFrameGpuB0: {
        status: 'not-measured',
        reason: 'Renderer render timestamps omit GPU work outside renderer.render(), and presentation timing is not measured.',
      },
      gpuSupported,
      observedRenderSupported: blocks.every((block) => Object.values(block.modes)
        .every((entry) => ['offBefore', 'cloudOn', 'offAfter'].every((key) =>
          entry[key].measurement.observedRenderCompleteFrames === entry[key].measurement.frames))),
      computeMeasurement: {
        scope: 'renderer-compute-query-sum',
        status: computeExpectedQueryCount === 0
          ? 'no-renderer-compute-query-uids-issued'
          : computeQueryCount === computeExpectedQueryCount
            ? 'renderer-compute-query-uids-resolved' : 'renderer-compute-query-uids-incomplete',
        queryResolutionComplete: blocks.every((block) => Object.values(block.modes)
          .every((entry) => ['offBefore', 'cloudOn', 'offAfter'].every((key) =>
            entry[key].measurement.observedComputeCompleteFrames === entry[key].measurement.frames))),
        queryCount: computeQueryCount,
        expectedQueryCount: computeExpectedQueryCount,
      },
      qualification: qualifyObservedRenderBaseline(blocks, {
        platform: process.platform,
        systemGraphics,
        timestampQueryAdvertised: device.adapter?.timestampQueryAdvertised === true,
        adapterFallback: device.adapter?.fallback,
        adapterVendor: device.adapter?.vendor,
        adapterArchitecture: device.adapter?.architecture,
        standardNearRange250kmFixture: true,
      }),
      statistics: summarizeBaselineBlocks(blocks),
      observedRenderStatistics: summarizeObservedRenderRepeats(blocks),
      blocks,
      interpretation: 'observed-render-total sums resolved GPU timestamp durations for every renderer.render() UID attributed to each measured lab frame, including calls without a named pass. It excludes GPU work outside renderer.render(), including compute and uninstrumented WebGPU operations, so it is not full-frame GPU B0. Compute renderer queries are reported separately. Qualification uses paired observed-render p95 deltas and off/off repeatability; instrumented pass and compute statistics remain descriptive.',
    };
    writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`Wrote ${path.relative(root, outputPath)}`);
  } finally {
    await session.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
