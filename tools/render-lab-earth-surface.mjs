// Earth surface の実行時検証入口。
// 現時点の render-lab が返せるのは通常の色画像だけなので、Earth surface 用の
// capture API が公開されていない環境では、画像を捏造せず unavailable を保存する。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.render-lab');
const outDir = path.join(root, '.earth-surface', 'verification', 'capture');
const port = 8768;
const debugPort = 9445;
const VIEWPORT = { width: 1920, height: 1080 };
const FRAMES_PER_CASE = 300;

// T5 の比較点。名前はデータセットが用意された後も変えず、撮影結果を追跡可能にする。
const CASES = [
  'himalaya-50km', 'himalaya-200km', 'himalaya-2000km', 'equator', 'latitude-60',
  'north-pole', 'south-pole', 'date-line', 'coast', 'blue-land', 'ice',
  'negative-elevation-land', 'seabed', 'schematic', 'lod-fallback',
];

// 実ブラウザの capture と独立に、既存の fake transport/GPU テストで再生される失敗経路を
// 記録する。実装済みのテスト名を結果へ添えるので、未実施の実機測定と混同しない。
const REPLAY_SCENARIOS = [
  ['out-of-order-arrival', 'tests/render/earth-surface-resident.test.ts'],
  ['http-404', 'tests/render/earth-surface-request.test.ts'],
  ['http-408-429-5xx', 'tests/render/earth-surface-request.test.ts'],
  ['network-failure', 'tests/render/earth-surface-request.test.ts'],
  ['128-layer-capacity', 'tests/render/earth-surface-resident.test.ts'],
  ['dispose-and-generation', 'tests/render/earth-surface-request.test.ts'],
  ['mipmap-disabled', 'tests/render/earth-surface-gpu.test.ts'],
].map(([id, test]) => ({ id, status: 'covered-by-tests', test }));

function unavailableBuffer(reason) {
  return { status: 'unavailable', path: null, sha256: null, byteLength: null, reason };
}

function unavailableDocument(reason, environment = {}) {
  const capturedAt = new Date().toISOString();
  return {
    schemaVersion: 2,
    capturedAt,
    environment: {
      os: `${os.platform()} ${os.release()}`,
      browser: environment.browser ?? null,
      backend: environment.backend ?? null,
      webgpu: environment.webgpu ?? 'unavailable',
      drawingBuffer: environment.drawingBuffer ?? 'unavailable',
    },
    viewport: VIEWPORT,
    framesPerCase: FRAMES_PER_CASE,
    replayScenarios: REPLAY_SCENARIOS,
    cases: CASES.map((caseName) => ({
      caseName,
      status: 'unavailable',
      datasetId: null,
      viewport: VIEWPORT,
      projection: 'ellipsoid-equirectangular',
      sunAzimuthDeg: 0,
      selectedZ: null,
      errorPx: null,
      frontier: [],
      fallbackRate: null,
      httpDecodeWaitMs: null,
      gpuLayers: null,
      pageTableUpdates: null,
      encodedBytes: null,
      payloadBytes: null,
      gpuP95Ms: null,
      frames: FRAMES_PER_CASE,
      color: unavailableBuffer(reason),
      normal: unavailableBuffer(reason),
      depth: unavailableBuffer(reason),
      reason,
    })),
  };
}

function writeDocument(document) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const materialized = materializeBuffers(document);
  const file = path.join(outDir, 'metrics.json');
  writeFileSync(file, `${JSON.stringify(materialized, null, 2)}\n`);
  const status = materialized.cases.every((entry) => entry.status === 'unavailable') ? 'unavailable' : 'complete';
  console.log(`earth-surface:capture: ${status}`);
  console.log(`earth-surface:capture: wrote ${path.relative(root, file)}`);
}

function decodePngDataUrl(value, label) {
  if (typeof value !== 'string' || !value.startsWith('data:image/png;base64,')) {
    throw new Error(`${label} must be a PNG data URL`);
  }
  const bytes = Buffer.from(value.slice('data:image/png;base64,'.length), 'base64');
  if (bytes.length === 0) throw new Error(`${label} returned an empty PNG`);
  return bytes;
}

function materializeBuffers(document) {
  const cases = document.cases.map((entry) => {
    const outputs = {};
    for (const kind of ['color', 'normal', 'depth']) {
      const buffer = entry[kind];
      if (buffer?.status !== 'complete') {
        outputs[kind] = buffer;
        continue;
      }
      try {
        const bytes = decodePngDataUrl(buffer.dataUrl, `${entry.caseName}.${kind}`);
        const filename = `${entry.caseName}-${kind}.png`;
        writeFileSync(path.join(outDir, filename), bytes);
        outputs[kind] = { ...imageMetric(bytes), path: `./${filename}` };
      } catch (error) {
        outputs[kind] = {
          status: 'failed', path: null, sha256: null, byteLength: null, reason: error.message,
        };
      }
    }
    const failedOutput = Object.values(outputs).some((buffer) => buffer?.status === 'failed');
    return {
      ...entry,
      status: failedOutput ? 'failed' : entry.status,
      color: outputs.color,
      normal: outputs.normal,
      depth: outputs.depth,
      reason: failedOutput ? 'one or more image outputs could not be materialized' : entry.reason,
    };
  });
  return { ...document, cases };
}

function browserEnvironment(devTools) {
  return devTools.evaluate(`(async () => {
    const adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
    const info = adapter?.info ?? {};
    return {
      browser: navigator.userAgent,
      backend: [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' / ') || null,
      webgpu: adapter ? 'available' : 'unavailable',
      drawingBuffer: document.querySelector('canvas') ? 'available' : 'unavailable',
    };
  })()`);
}

async function tryCapture() {
  if (!existsSync(path.join(buildDir, 'index.html'))) {
    return unavailableDocument('render-lab production build is missing; run npm run earth-surface:capture');
  }
  const { fatalEvents, onEvent } = collectFatalEvents();
  let session;
  try {
    session = await openChromeSession({
      serveDir: buildDir,
      port,
      debugPort,
      profilePrefix: 'tepui-render-lab-earth-surface-',
      windowSize: VIEWPORT,
      onEvent,
    });
  } catch (error) {
    return unavailableDocument(`browser/WebGPU session could not be started: ${error.message}`);
  }
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    await waitFor(
      devTools,
      "(document.getElementById('error')?.textContent || typeof window.renderLab === 'object')",
      'the render lab to initialise',
    );
    const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
    const environment = await browserEnvironment(devTools);
    if (failure) return unavailableDocument(`render-lab initialisation failed: ${failure}`, environment);
    if (environment.webgpu !== 'available') return unavailableDocument('WebGPU adapter is unavailable', environment);

    // Normal/depth/paging/fallback を同じ runtime から取り出す専用 API が必要である。
    // 既存の renderLab.shoot は別の5ケースの色PNGだけを返すため、そこから代用しない。
    const supported = await devTools.evaluate(
      "typeof window.renderLab.earthSurfaceCapture === 'function'",
    );
    if (!supported) {
      return unavailableDocument(
        'render-lab exposes color-only legacy capture; Earth surface color/normal/depth metrics API is unavailable',
        environment,
      );
    }
    const result = await devTools.evaluate(
      `window.renderLab.earthSurfaceCapture(${JSON.stringify({ cases: CASES, viewport: VIEWPORT, frames: FRAMES_PER_CASE })})`,
    );
    if (!result || result.schemaVersion !== 2 || !Array.isArray(result.cases)) {
      return unavailableDocument('Earth surface capture API returned an invalid result', environment);
    }
    return {
      ...result,
      capturedAt: new Date().toISOString(),
      environment,
      viewport: VIEWPORT,
      framesPerCase: FRAMES_PER_CASE,
      replayScenarios: REPLAY_SCENARIOS,
    };
  } catch (error) {
    const environment = await browserEnvironment(session.devTools).catch(() => ({}));
    return unavailableDocument(`Earth surface capture was not completed: ${error.message}`, environment);
  } finally {
    if (fatalEvents.length > 0) console.warn(`earth-surface:capture: page events: ${fatalEvents.join(' | ')}`);
    await session.close();
  }
}

if (process.argv.includes('--contract')) {
  writeDocument(unavailableDocument('capture contract test'));
} else {
  tryCapture().then(writeDocument).catch((error) => {
    // Even a harness failure is recorded as unavailable, so a missing browser cannot turn into
    // an apparently successful empty capture or a half-written metrics file.
    writeDocument(unavailableDocument(`capture harness failed: ${error.message}`));
  });
}

// Only bytes received from the renderer may become an output image.
export function imageMetric(bytes) {
  return {
    status: 'complete',
    path: null,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.length,
    reason: null,
  };
}
