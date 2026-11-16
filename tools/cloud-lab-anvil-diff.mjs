// かなとこの寄与を分離する撮影。同じ cap・時刻で detrainGain あり/なしを撮り比べる。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.cloud-lab');
const outDir = path.join(buildDir, 'shots-anvil-diff');
const port = 8773;
const debugPort = 9450;

const CAPS = [
  { name: 'amazon', latitude: -3, longitude: -60, radius: 3 },
  { name: 'westpacific', latitude: 8, longitude: 145, radius: 3 },
];
const HOURS = [14];
const VIEWS = ['cirrus', 'composite'];

async function main() {
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-cloud-lab-anvildiff-', onEvent,
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
    for (const cap of CAPS) {
      await devTools.evaluate(
        `window.cloudLab.aimCap(${cap.latitude}, ${cap.longitude}, ${cap.radius})`);
      for (const hours of HOURS) {
        await devTools.evaluate(`window.cloudLab.setTime(${hours})`);
        for (const gain of [1, 0]) {
          await devTools.evaluate(`window.cloudLab.setParams({ detrainGain: ${gain} })`);
          for (const view of VIEWS) {
            await devTools.evaluate(`window.cloudLab.show(${JSON.stringify(view)})`);
            const dataUrl = await devTools.evaluate('window.cloudLab.capture()');
            writeFileSync(
              path.join(outDir, `${cap.name}-${view}-g${gain}-${hours}h.png`),
              Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
            console.log(`shot ${cap.name} ${view} gain=${gain} at ${hours} h`);
          }
        }
        await devTools.evaluate('window.cloudLab.setParams({ detrainGain: 1 })');
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

main();
