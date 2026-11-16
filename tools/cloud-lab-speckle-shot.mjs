// 斑点・ジッタの診断撮影。全球の写し(地形テクスチャをアンダーサンプリングする解像度)で
// 湿度・追跡の風・地表の風を撮り、cap では細かい時間刻みで同じ面を撮って時間方向の
// ちらつきを比較する。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.cloud-lab');
const outDir = path.join(buildDir, 'shots-speckle');
const port = 8771;
const debugPort = 9448;

const GLOBAL_VIEWS = ['surfaceHumidity', 'traceWind', 'surfaceWind', 'composite'];
// cap の置き方。アンデスは風が山脈へ吹き付ける所、ハワイは孤立峰。
const CAPS = [
  { name: 'andes', latitude: -20, longitude: -69, radius: 8 },
  { name: 'hawaii', latitude: 19.6, longitude: -155.5, radius: 5 },
];
const CAP_VIEWS = ['surfaceHumidity', 'surfaceWind', 'composite'];
const CAP_TIMES = [0, 0.05, 0.1, 0.5, 1, 2];

async function main() {
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-cloud-lab-speckle-', onEvent,
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/?capture-only` });
    await waitFor(
      devTools,
      "(document.getElementById('error')?.textContent || typeof window.cloudLab === 'object')",
      'the cloud lab to initialise',
    );
    const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
    if (failure) throw new Error(`Cloud lab failed to initialise: ${failure}`);

    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const shot = async (view, name) => {
      await devTools.evaluate(`window.cloudLab.show(${JSON.stringify(view)})`);
      const dataUrl = await devTools.evaluate('window.cloudLab.capture()');
      writeFileSync(
        path.join(outDir, `${name}.png`),
        Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
      console.log(`shot ${name}`);
    };
    await devTools.evaluate('window.cloudLab.setTime(0)');
    for (const view of GLOBAL_VIEWS) await shot(view, `global-${view}-0h`);
    for (const cap of CAPS) {
      await devTools.evaluate(
        `window.cloudLab.aimCap(${cap.latitude}, ${cap.longitude}, ${cap.radius})`);
      for (const hours of CAP_TIMES) {
        await devTools.evaluate(`window.cloudLab.setTime(${hours})`);
        for (const view of CAP_VIEWS) await shot(view, `${cap.name}-${view}-${hours}h`);
      }
    }
    console.log(`Wrote PNGs to ${path.relative(root, outDir)}`);
    if (fatalEvents.length > 0) {
      console.error('fatal events:', fatalEvents);
      process.exitCode = 1;
    }
  } finally {
    await session.close();
  }
}

await main();
