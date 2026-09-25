// 局所雲タイルの CPU 生成・所有中サイズ推定・初回描画待ち・warm 再利用を分けて記録する。
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.render-lab');
const outputPath = path.join(buildDir, 'cloud-detail-lifecycle-benchmark.json');
const caseName = 'earth';
const shotName = 'cloud-standard-near-range-250km';
const sampleCount = 8;
const graphics = { clouds: true, cloudFieldSource: 'generated', lens: true };
const detail = { wavelengthKm: 2, directionDeg: 0, composition: 'absolute' };

function distribution(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (ratio) => sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? null;
  return {
    samples: values.length,
    mean: values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    min: sorted[0] ?? null,
    max: sorted.at(-1) ?? null,
  };
}

function summarize(runs, key) {
  return distribution(runs.map((run) => run[key]));
}

function systemGraphicsIdentity() {
  if (process.platform !== 'darwin') return null;
  try {
    const result = execFileSync('system_profiler', ['-json', 'SPDisplaysDataType'], {
      encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return (JSON.parse(result).SPDisplaysDataType ?? []).map((display) => ({
      chipset: display.sppci_model ?? null,
      vendor: display.sppci_vendor ?? null,
      cores: display.sppci_cores ?? null,
      metalSupport: display.spdisplays_mtlgpufamilysupport ?? null,
    }));
  } catch {
    return null;
  }
}

const { fatalEvents, onEvent } = collectFatalEvents();
const session = await openChromeSession({
  serveDir: buildDir, port: 8791, debugPort: 9478,
  profilePrefix: 'tepui-cloud-detail-lifecycle-', onEvent,
});
try {
  const { devTools } = session;
  await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
  await waitFor(
    devTools,
    "(document.getElementById('error')?.textContent || typeof window.renderLab?.measureCloudDetailLifecycle === 'function')",
    'the render-lab cloud detail lifecycle API',
  );
  const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
  if (failure) throw new Error(`Render lab failed to initialise: ${failure}`);

  const [device, browser] = await Promise.all([
    devTools.evaluate(`(async () => {
      const adapter = await navigator.gpu?.requestAdapter();
      return adapter ? {
        vendor: adapter.info.vendor, architecture: adapter.info.architecture,
        device: adapter.info.device, description: adapter.info.description,
        timestampQueryAdvertised: adapter.features.has('timestamp-query'),
      } : null;
    })()`),
    devTools.send('Browser.getVersion'),
  ]);
  const measurement = await devTools.evaluate(`window.renderLab.measureCloudDetailLifecycle(
    ${JSON.stringify(caseName)}, ${JSON.stringify(shotName)}, ${JSON.stringify(graphics)},
    ${JSON.stringify(detail)}, ${sampleCount})`);
  if (!measurement.caseReady) throw new Error('Render lab case did not become ready');
  if (fatalEvents.length > 0) throw new Error(`Page reported errors:\n${fatalEvents.join('\n')}`);

  const textureEstimate = measurement.coldExchange.at(-1)?.ownerEstimate ?? null;
  const result = {
    schemaVersion: 1,
    diagnostic: 'cloud-detail-cold-exchange-and-warm-reuse',
    recordedAt: new Date().toISOString(),
    host: {
      platform: process.platform,
      architecture: process.arch,
      osRelease: os.release(),
      systemGraphics: systemGraphicsIdentity(),
    },
    browser: { product: browser.product, userAgent: browser.userAgent, jsVersion: browser.jsVersion },
    adapter: device,
    caseName,
    shotName,
    graphics,
    detail,
    sampleCount,
    fixture: {
      internalRaster: [measurement.canvasWidth, measurement.canvasHeight],
      fixedDisplayTimeSeconds: measurement.sampleDisplayTimeSeconds,
      actualGpuTimestampSupport: measurement.gpuTimestampResolveSupport,
      advertisedGpuTimestampSupport: device?.timestampQueryAdvertised ?? false,
    },
    preparation: {
      caseReadinessWaitWallMs: measurement.caseReadinessWaitWallMs,
      caseReady: measurement.caseReady,
      setupWarmupWallMs: measurement.setupWarmupWallMs,
      interpretation: 'Readiness and fixed six-frame setup warm-up wall time; excluded from cold/warm samples.',
    },
    coldExchange: {
      scope: 'Each new deterministic phase replaces the currently owned tile; setter latency includes CPU texel generation and, after the first sample, old texture disposal. Display time is fixed after setup warm-up, so the generated cloud field is not rebaked between tile samples.',
      firstSample: 'Initial tile creation from an empty diagnostic owner; following samples replace the previously owned tile.',
      setterCpuWallMs: summarize(measurement.coldExchange, 'setterCpuWallMs'),
      firstUseWallMs: summarize(measurement.coldExchange, 'firstUseWallMs'),
      renderCallCpuWallMs: summarize(measurement.coldExchange, 'renderCallCpuWallMs'),
      pipelineRenderCpuWallMs: summarize(measurement.coldExchange, 'pipelineRenderCpuWallMs'),
      timestampResolveAwaitWallMs: summarize(measurement.coldExchange, 'timestampResolveAwaitWallMs'),
      samples: measurement.coldExchange,
    },
    warmReuse: {
      scope: 'The same tile parameters are reapplied while the owner still holds that texture; this is the current no-op reuse path, not a cached second texture swap.',
      setterCpuWallMs: summarize(measurement.warmReuse, 'setterCpuWallMs'),
      reuseWallMs: summarize(measurement.warmReuse, 'reuseWallMs'),
      renderCallCpuWallMs: summarize(measurement.warmReuse, 'renderCallCpuWallMs'),
      pipelineRenderCpuWallMs: summarize(measurement.warmReuse, 'pipelineRenderCpuWallMs'),
      timestampResolveAwaitWallMs: summarize(measurement.warmReuse, 'timestampResolveAwaitWallMs'),
      allSamplesRetainedSameTexture: measurement.warmReuse.every((sample) => sample.sameTextureRetained),
      samples: measurement.warmReuse,
    },
    ownerTexture: {
      resource: 'The render-lab diagnostic tile only; other render-pipeline textures are excluded.',
      diagnosticTileOwnerResidentTextureCount: textureEstimate === null ? 0 : 1,
      cpuBackingArrayBytes: {
        status: textureEstimate?.cpuBackingBytes === null ? 'not-measured' : 'measured',
        value: textureEstimate?.cpuBackingBytes ?? null,
      },
      estimatedGpuBaseLevelBytes: {
        status: textureEstimate?.estimatedGpuBaseLevelBytes === null ? 'not-estimated' : 'estimated',
        value: textureEstimate?.estimatedGpuBaseLevelBytes ?? null,
        basis: 'RGBA8 width × height base level only; excludes driver alignment, temporary copies, residency, and any implementation-specific allocation.',
      },
      dimensions: textureEstimate === null ? null : [textureEstimate.width, textureEstimate.height],
      actualGpuAllocation: measurement.actualGpuAllocation,
    },
    cloudTextureUploadReadyWait: measurement.cloudTextureUploadReadyWait,
    fullFrameGpuB0: measurement.fullFrameGpuB0,
    timestampResolveScope: 'CPU wall time awaiting render-lab timestamp-query resolution after renderer.render(); this is not a texture-upload completion signal or full-frame GPU time.',
  };
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Wrote ${path.relative(root, outputPath)}`);
} finally {
  await session.close();
}
