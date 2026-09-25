// 250 km・medium shot で局所診断タイルだけを切り替え、観測済み GPU pass 合計の増分を測る。
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const shotName = process.argv.includes('--cloudy')
  ? 'cloud-detail-residual-250km-cloudy-diagnostic'
  : 'cloud-standard-near-range-250km';
const residual = process.argv.includes('--residual');
const tile = {
  wavelengthKm: 2, directionDeg: 0,
  composition: residual ? 'coverage-residual' : 'absolute',
};
const blockCount = 8;
const lens = !process.argv.includes('--lens-off');
const provisionalDeltaP95LimitMs = 5;

function distribution(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return { p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1], min: sorted[0], max: sorted.at(-1) };
}

function hostGpu() {
  if (process.platform !== 'darwin') return null;
  try {
    const report = JSON.parse(execFileSync('system_profiler', ['-json', 'SPDisplaysDataType'], {
      encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'],
    }));
    return (report.SPDisplaysDataType ?? []).map((display) => ({
      model: display.sppci_model ?? display._name ?? null,
      cores: display.sppci_cores ?? null,
    }));
  } catch {
    return null;
  }
}
const { fatalEvents, onEvent } = collectFatalEvents();
const session = await openChromeSession({
  serveDir: path.join(root, '.render-lab'), port: 8788, debugPort: 9465,
  profilePrefix: 'tepui-cloud-detail-benchmark-', onEvent,
});
try {
  const { devTools } = session;
  await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
  await waitFor(devTools,
    "(document.getElementById('error')?.textContent || typeof window.renderLab?.measureShot === 'function')",
    'render lab measurement API');
  const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
  if (failure) throw new Error(failure);
  const adapter = await devTools.evaluate(`(async () => {
    const adapter = await navigator.gpu?.requestAdapter();
    return adapter ? {
      vendor: adapter.info.vendor, architecture: adapter.info.architecture,
      device: adapter.info.device, description: adapter.info.description,
      timestampQuery: adapter.features.has('timestamp-query'),
    } : null;
  })()`);
  const measure = (detailTile) => devTools.evaluate(`window.renderLab.measureShot(
    'earth', ${JSON.stringify(shotName)}, ${JSON.stringify({ lens })}, ${JSON.stringify(detailTile)})`);
  // 初回 pipeline 構築と texture upload は測定外に置く。冷タイル交換は別の計測が必要。
  await measure(null);
  await measure(tile);
  const blocks = [];
  for (let index = 0; index < blockCount; index += 1) {
    const offBefore = await measure(null);
    const on = await measure(tile);
    const offAfter = await measure(null);
    for (const sample of [offBefore, on, offAfter]) {
      if (sample.canvasWidth !== 720 || sample.canvasHeight !== 405) {
        throw new Error(`unexpected medium internal raster ${sample.canvasWidth}x${sample.canvasHeight}`);
      }
      if (!sample.gpuSupported || sample.observedRenderCompleteFrames !== sample.frames) {
        throw new Error('GPU timestamp coverage is incomplete');
      }
    }
    const delta = on.observedRenderTotalMs.p95
      - (offBefore.observedRenderTotalMs.p95 + offAfter.observedRenderTotalMs.p95) / 2;
    const noise = Math.abs(offAfter.observedRenderTotalMs.p95 - offBefore.observedRenderTotalMs.p95);
    blocks.push({ index, deltaMs: delta, offOffNoiseMs: noise, offBefore, on, offAfter });
    console.log(JSON.stringify({ index, deltaMs: delta, offOffNoiseMs: noise }));
  }
  if (fatalEvents.length) throw new Error(fatalEvents.join('\n'));
  const delta = distribution(blocks.map((block) => block.deltaMs));
  const offOffNoise = distribution(blocks.map((block) => block.offOffNoiseMs));
  const result = {
    scope: 'observed-render-total (all resolved renderer.render GPU timestamp queries, not full-frame B0)',
    caseName: 'earth', shotName, internalRaster: [720, 405], lens, residual, adapter,
    hostGpu: hostGpu(),
    summary: {
      pairedDeltaMs: delta, offOffNoiseMs: offOffNoise, provisionalDeltaP95LimitMs,
      withinProvisionalLimitThisRun: delta.p95 <= provisionalDeltaP95LimitMs,
      qualification: 'diagnostic-only; repeatability, CPU, full-frame GPU, cold exchange, and actual GPU allocation are separate',
      fullFrameGpu: 'not-measured', actualGpuAllocation: 'not-measured',
    },
    blocks,
  };
  const output = path.join(root, '.render-lab',
    `cloud-detail-benchmark-${shotName}-${residual ? 'residual' : 'absolute'}-lens-${lens ? 'on' : 'off'}.json`);
  writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(output);
} finally {
  await session.close();
}
