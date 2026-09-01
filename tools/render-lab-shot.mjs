// 描画テスト環境の撮影。ヘッドレス Chrome で .render-lab/ を開き、ケースごとに
// window.renderLab.shoot() を呼んで PNG を書く。画素はページ側が合成パスの出力先から
// 読み出しているので、WebGPU キャンバスの提示・Page.captureScreenshot はどこも通らない。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.render-lab');
const outDir = path.join(buildDir, 'shots');
const port = 8767;
const debugPort = 9444;

async function main() {
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-render-lab-', onEvent,
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    // レンダラーの init() が終わるまで撮れない。ページが失敗を文字で出していたらそれを読む。
    await waitFor(
      devTools,
      "(document.getElementById('error')?.textContent || typeof window.renderLab === 'object')",
      'the render lab to initialise',
    );
    const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
    if (failure) throw new Error(`Render lab failed to initialise: ${failure}`);

    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const names = await devTools.evaluate('window.renderLab.cases');
    for (const name of names) {
      const dataUrl = await devTools.evaluate(`window.renderLab.shoot(${JSON.stringify(name)})`);
      writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
      console.log(`shot ${name}`);
    }
    const proteinNames = names.filter((name) => String(name).startsWith('protein-'));
    const baselineCases = {};
    for (const name of proteinNames) {
      baselineCases[name] = await devTools.evaluate(`window.renderLab.measure(${JSON.stringify(name)})`);
      console.log(`measure ${name}`);
    }
    const baselineFile = path.join(root, 'memos/mikanixonable/protein-motion-baseline.json');
    writeFileSync(baselineFile, `${JSON.stringify({
      schemaVersion: 2,
      viewport: { width: 960, height: 540 },
      warmupFrames: 6,
      sampleFrames: 30,
      gpuTimingSource: 'src/gpu-timings.ts:GpuTimings',
      cpuTimingSource: 'performance.now() around RenderPipeline.render()',
      cases: baselineCases,
    }, null, 2)}\n`);
    console.log(`Wrote protein baseline to ${path.relative(root, baselineFile)}`);
    if (fatalEvents.length > 0) throw new Error(`Page reported errors during shooting:\n${fatalEvents.join('\n')}`);
    console.log(`Wrote ${names.length} PNGs to ${path.relative(root, outDir)}`);
  } finally {
    await session.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
