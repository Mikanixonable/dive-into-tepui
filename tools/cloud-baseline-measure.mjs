// 雲なし／雲ありの計測対象描画パス合計を、反復ブロックで比較する。
// フレーム全体の GPU 完了時刻や画面提示時刻とは区別する。
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';
import { summarizeBaselineBlocks } from './cloud-baseline-statistics.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.render-lab');
const outputPath = path.join(buildDir, 'cloud-baseline.json');
const BLOCK_COUNT = 8;
const modes = [
  { id: 'generated-standard', source: 'generated' },
  { id: 'observed-standard', source: 'observed' },
];

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
    const initialGraphicsSettings = await devTools.evaluate('window.renderLab.graphicsSettings()');
    const blocks = [];
    const measure = async (source, clouds) => {
      await devTools.evaluate(`window.renderLab.setGraphicsOption('cloudFieldSource', ${JSON.stringify(source)})`);
      await devTools.evaluate("window.renderLab.setGraphicsOption('cumulusDetail', 2)");
      await devTools.evaluate(`window.renderLab.setGraphicsOption('clouds', ${clouds})`);
      return {
        graphicsSettings: await devTools.evaluate('window.renderLab.graphicsSettings()'),
        measurement: await devTools.evaluate("window.renderLab.measure('earth')"),
      };
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
        }
        block.modes[mode.id] = { offBefore: before, cloudOn: cloud, offAfter: after };
        console.log(`${mode.id} block=${index + 1}/${BLOCK_COUNT}: instrumented pass p95 `
          + `off=${before.measurement.gpuPassTotalMs.p95.toFixed(3)}/`
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
    const result = {
      recordedAt: new Date().toISOString(),
      host: { platform: process.platform, architecture: process.arch, osRelease: os.release() },
      browser: { product: browser.product, userAgent: browser.userAgent, jsVersion: browser.jsVersion },
      device,
      caseName: 'earth',
      sampleFramesPerMeasurement: blocks[0]?.modes[modes[0].id]?.cloudOn.measurement.frames ?? 0,
      blockCount: BLOCK_COUNT,
      quality: { cumulusDetail: 'standard' },
      initialGraphicsSettings,
      measurementScope: 'instrumented-render-pass-sum',
      gpuSupported,
      qualification: {
        status: 'not-established',
        reason: 'No target device/browser identity was specified for this run; timestamp-query support does not establish hardware suitability.',
      },
      statistics: summarizeBaselineBlocks(blocks),
      blocks,
      interpretation: 'These are instrumented render-pass sums, not whole-frame GPU B0. Paired p95 deltas compare per-measurement instrumented-pass p95 values; the off/off noise floor is reported separately. No pass/fail threshold is applied.',
    };
    writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`Wrote ${path.relative(root, outputPath)}`);
  } finally {
    await session.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
