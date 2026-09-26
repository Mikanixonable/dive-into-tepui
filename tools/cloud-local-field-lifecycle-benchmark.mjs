// 局所光学場の再焼を、製品経路の焼き器が載った実フレームで計測する。定常フレーム・
// 再焼間隔超過・直下点の閾値超の移動それぞれの CPU 発行時間・GPU pass 時間・試行記録・
// 体積の容量推定を .render-lab/cloud-local-field-lifecycle-benchmark.json へ書き出す。
// --self-test は GPU なしで、計測口のコンパイルと入口の接続だけを点検する。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.render-lab');
const outputPath = path.join(buildDir, 'cloud-local-field-lifecycle-benchmark.json');
const caseName = 'earth';
const shotName = 'cloud-local-field-nadir-600km';
const sampleCount = 4;
const graphics = {};
const nodeRequire = createRequire(import.meta.url);

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
  return distribution(runs.map((run) => run[key]).filter((value) => value !== null));
}

function gpuPassTotalMs(frame) {
  return Object.values(frame.gpuPassMs).reduce((sum, value) => sum + value, 0);
}

function framesByKind(frames, kind) {
  return frames.filter((frame) => frame.kind === kind);
}

function summarizeKind(frames) {
  return {
    samples: frames.length,
    renderCallCpuWallMs: summarize(frames, 'renderCallCpuWallMs'),
    pipelineRenderCpuWallMs: summarize(frames, 'pipelineRenderCpuWallMs'),
    timestampResolveAwaitWallMs: summarize(frames, 'timestampResolveAwaitWallMs'),
    observedRenderTotalMs: summarize(frames, 'observedRenderTotalMs'),
    observedComputeTotalMs: summarize(frames, 'observedComputeTotalMs'),
    gpuPassTotalMs: distribution(frames.map(gpuPassTotalMs)),
    rebuildAttemptCount: frames.reduce((sum, frame) => sum + frame.bakeAttempts.length, 0),
    frames,
  };
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

function selfTest() {
  execFileSync('npm', ['run', 'test:compile'], { cwd: root, stdio: 'inherit' });
  const bakerModulePath = path.join(root, 'tests/dist/src/render/cloud/cloud-local-field-baker.js');
  assert.ok(existsSync(bakerModulePath), 'cloud local field baker did not compile');
  const baker = nodeRequire(bakerModulePath);
  assert.equal(typeof baker.CloudLocalFieldBaker, 'function', 'CloudLocalFieldBaker is missing');
  // 計測口がコンパイル済みの姿へ出ていること。
  const bakerSource = readFileSync(bakerModulePath, 'utf8');
  for (const key of ['bakeStats', 'deriveMs', 'volumeBuildMs', 'estimatedGpuBaseLevelBytes', 'generation']) {
    assert.ok(bakerSource.includes(key), `baker is missing measurement port: ${key}`);
  }
  // 計測関数が LabView と CDP 入口へ接続されていること。
  const labModulePath = path.join(root, 'tests/dist/tools/render-lab/lab.js');
  assert.ok(existsSync(labModulePath), 'render-lab view did not compile');
  const labSource = readFileSync(labModulePath, 'utf8');
  for (const key of [
    'measureCloudLocalFieldLifecycle', 'interval-rebuild', 'recenter-rebuild',
    'renderCallCpuWallMs', 'volumeBytes', 'bindingTextureUuid',
  ]) {
    assert.ok(labSource.includes(key), `lab is missing measurement key: ${key}`);
  }
  const labEarthPath = path.join(root, 'tests/dist/tools/render-lab/lab-earth.js');
  assert.ok(readFileSync(labEarthPath, 'utf8').includes('cloudLocalFieldBakeStats'),
    'lab earth is missing the bake stats forwarding');
  const mainSource = readFileSync(path.join(root, 'tools/render-lab/main.ts'), 'utf8');
  assert.ok(mainSource.includes('measureCloudLocalFieldLifecycle'),
    'measureCloudLocalFieldLifecycle is not wired into window.renderLab');
  console.log('cloud local field lifecycle benchmark self-test passed');
}

async function main() {
  if (process.argv[2] === '--self-test') {
    selfTest();
    return;
  }
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port: 8797, debugPort: 9482,
    profilePrefix: 'tepui-cloud-local-field-', onEvent,
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    await waitFor(
      devTools,
      "(document.getElementById('error')?.textContent || typeof window.renderLab?.measureCloudLocalFieldLifecycle === 'function')",
      'the render-lab cloud local field lifecycle API',
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
    const measurement = await devTools.evaluate(`window.renderLab.measureCloudLocalFieldLifecycle(
      ${JSON.stringify(caseName)}, ${JSON.stringify(shotName)}, ${JSON.stringify(graphics)},
      ${sampleCount})`);
    if (!measurement.caseReady) throw new Error('Render lab case did not become ready');
    if (fatalEvents.length > 0) throw new Error(`Page reported errors:\n${fatalEvents.join('\n')}`);

    const result = {
      schemaVersion: 1,
      diagnostic: 'cloud-local-field-rebuild-lifecycle',
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
      sampleCount,
      fixture: {
        internalRaster: [measurement.canvasWidth, measurement.canvasHeight],
        actualGpuTimestampSupport: measurement.gpuTimestampResolveSupport,
        advertisedGpuTimestampSupport: device?.timestampQueryAdvertised ?? false,
      },
      preparation: {
        caseReadinessWaitWallMs: measurement.caseReadinessWaitWallMs,
        caseReady: measurement.caseReady,
        setupWarmupWallMs: measurement.setupWarmupWallMs,
        interpretation: 'Readiness and six-frame warm-up wall time; the initial field build runs inside setup and is recorded only via bakeAttempts.',
      },
      bakeAttempts: {
        scope: 'Per-attempt records kept by the product-path baker, including the initial build. deriveMs covers supply.derive + frame validation; volumeBuildMs covers CloudOpticalVolume assembly; estimatedGpuBaseLevelBytes is the upload-payload estimate of the baked volume.',
        attempts: measurement.bakeAttempts,
        deriveMs: distribution(measurement.bakeAttempts.map((attempt) => attempt.deriveMs)),
        volumeBuildMs: distribution(measurement.bakeAttempts.map((attempt) => attempt.volumeBuildMs)),
        uploadPayloadBytes: measurement.bakeAttempts.map((attempt) => attempt.estimatedGpuBaseLevelBytes),
        failedAttemptCount: measurement.bakeAttempts.filter((attempt) => !attempt.rebuilt).length,
      },
      steady: summarizeKind(framesByKind(measurement.frames, 'steady')),
      intervalRebuild: summarizeKind(framesByKind(measurement.frames, 'interval-rebuild')),
      recenterRebuild: summarizeKind(framesByKind(measurement.frames, 'recenter-rebuild')),
      volumeBytes: {
        scope: 'current + retained volume totals kept by the baker; the sum while an exchange retains the previous volume is the swap peak.',
        last: measurement.frames.at(-1)?.volumeBytes ?? null,
      },
      generation: measurement.frames.at(-1)?.generation ?? null,
      fullFrameGpuB0: measurement.fullFrameGpuB0,
      actualGpuAllocation: measurement.actualGpuAllocation,
      textureUploadReadyWait: measurement.textureUploadReadyWait,
      timestampResolveScope: 'CPU wall time awaiting render-lab timestamp-query resolution after renderer.render(); this is not a texture-upload completion signal or full-frame GPU time.',
      gpuPassScope: 'Per-pass GPU timestamps resolved for each measured frame; texture uploads are copies and are not covered by render/compute pass queries.',
      frames: measurement.frames,
    };
    writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`Wrote ${path.relative(root, outputPath)}`);
    console.log(JSON.stringify({
      deriveMs: result.bakeAttempts.deriveMs,
      intervalRebuild: {
        renderCallCpuWallMs: result.intervalRebuild.renderCallCpuWallMs,
        rebuildAttemptCount: result.intervalRebuild.rebuildAttemptCount,
      },
      recenterRebuild: {
        renderCallCpuWallMs: result.recenterRebuild.renderCallCpuWallMs,
        rebuildAttemptCount: result.recenterRebuild.rebuildAttemptCount,
      },
      steady: { renderCallCpuWallMs: result.steady.renderCallCpuWallMs },
      volumeBytes: result.volumeBytes.last,
    }, null, 2));
  } finally {
    await session.close();
  }
}

await main();
