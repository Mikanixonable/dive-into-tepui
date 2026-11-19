// 斑点の時間推移を見る撮影。全球の写しで地表の湿度・地表の風・合成を長い時間刻みで撮る。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.cloud-lab');
const outDir = path.join(buildDir, 'shots-series');
const port = 8772;
const debugPort = 9449;

const VIEWS = ['surfaceHumidity', 'surfaceHumiditySource', 'convectionSource', 'convection', 'landFraction'];
const TIMES = [0, 6];

async function main() {
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-cloud-lab-series-', onEvent,
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
    let seq = 0;
    for (const hours of TIMES) { seq += 1;
      await devTools.evaluate(`window.cloudLab.setTime(${hours})`);
      for (const view of VIEWS) {
        await devTools.evaluate(`window.cloudLab.show(${JSON.stringify(view)})`);
        const dataUrl = await devTools.evaluate('window.cloudLab.capture()');
        writeFileSync(
          path.join(outDir, `${view}-s${seq}-${hours}h.png`),
          Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
      }
      console.log(`shot ${hours}h`);
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
