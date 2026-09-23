// Capture a paired cloud-off / observed / generated GPU baseline from the real
// render pipeline. Every reported frame total sums passes from that frame before
// taking a percentile; per-pass percentiles cannot be added to obtain a p95.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.render-lab');
const outputPath = path.join(buildDir, 'cloud-baseline.json');
const modes = [
  { id: 'off', clouds: false, source: 'generated' },
  { id: 'generated-standard', clouds: true, source: 'generated' },
  { id: 'observed-standard', clouds: true, source: 'observed' },
];

const profile = process.env.CLOUD_BASELINE_PROFILE === 'smoke' ? 'smoke' : 'full';
const preparationTimes = profile === 'smoke' ? [3_600] : [3_600, 86_400, -3_600];
const warmupFrames = profile === 'smoke' ? 1 : 6;
const sampleFrames = profile === 'smoke' ? 2 : 30;
const roundCount = profile === 'smoke' ? 1 : 2;

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

    const device = await devTools.evaluate(`(async () => {
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
    })()`);
    const initialGraphicsSettings = await devTools.evaluate('window.renderLab.graphicsSettings()');
    await devTools.evaluate("window.renderLab.setGraphicsOption('clouds', true)");
    await devTools.evaluate("window.renderLab.setGraphicsOption('cloudFieldSource', 'generated')");
    const cloudPreparation = await devTools.evaluate(
      `window.renderLab.measureCloudPreparation('earth', ${JSON.stringify(preparationTimes)})`,
    );
    const cloudResourceBudget = await devTools.evaluate('window.renderLab.cloudResourceBudget');
    console.log(`cloud resource budget: ${JSON.stringify(cloudResourceBudget)}`);
    console.log(`cloud preparation: ${JSON.stringify(cloudPreparation)}`);
    const jsHeap = await devTools.evaluate(`(() => {
      const memory = performance.memory;
      return memory ? {
        usedJSHeapSize: memory.usedJSHeapSize,
        totalJSHeapSize: memory.totalJSHeapSize,
        jsHeapSizeLimit: memory.jsHeapSizeLimit,
      } : null;
    })()`);
    const rounds = [];
    for (let round = 0; round < roundCount; round += 1) {
      const order = round === 0 ? modes : [...modes].reverse();
      for (const mode of order) {
        await devTools.evaluate(`window.renderLab.setGraphicsOption('cloudFieldSource', ${JSON.stringify(mode.source)})`);
        await devTools.evaluate("window.renderLab.setGraphicsOption('cumulusDetail', 2)");
        await devTools.evaluate(`window.renderLab.setGraphicsOption('clouds', ${mode.clouds})`);
        const graphicsSettings = await devTools.evaluate('window.renderLab.graphicsSettings()');
        const measurement = await devTools.evaluate(
          `window.renderLab.measure('earth', {}, ${warmupFrames}, ${sampleFrames})`,
        );
        if (measurement.gpuSupported && !(measurement.gpuPassTotalMs.p95 > 0)) {
          throw new Error(`Timestamp queries returned no usable pass timings for ${mode.id}`);
        }
        rounds.push({ round, mode: mode.id, graphicsSettings, measurement });
        console.log(`${mode.id} round=${round + 1}: GPU pass total p95=${measurement.gpuSupported
          ? measurement.gpuPassTotalMs.p95.toFixed(3) : 'unsupported'} ms`);
      }
    }
    if (fatalEvents.length > 0) throw new Error(`Page reported errors:\n${fatalEvents.join('\n')}`);
    const result = {
      recordedAt: new Date().toISOString(),
      measurementProfile: profile,
      hostPlatform: process.platform,
      hostArchitecture: process.arch,
      device,
      caseName: 'earth',
      sampleFramesPerRound: rounds[0]?.measurement.frames ?? 0,
      quality: { cumulusDetail: 'standard' },
      initialGraphicsSettings,
      cloudPreparation,
      cloudResourceBudget,
      jsHeap,
      rounds,
      gpuSupported: rounds.every((entry) => entry.measurement.gpuSupported),
      interpretation: profile === 'smoke'
        ? 'CI smoke profile executes all cloud source paths with too few frames for performance acceptance. Use the full profile on target hardware for budgets.'
        : 'Cloud-off is a baseline of instrumented render passes, not a verified whole-frame B0. Cloud-on minus cloud-off is not a paired per-frame cost. cloudPreparation pairs a changed-time cold bake with an immediate same-time warm reuse; core baked bytes exclude source images and WebGPU driver overhead. Timestamp support alone does not establish target hardware suitability.',
    };
    writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`Wrote ${path.relative(root, outputPath)}`);
  } finally {
    await session.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
