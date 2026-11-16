// 地形の効いた雲の撮影。アンデスとハワイへ cap を向け、合成(雲の見え)と地表付近の
// 湿度(湿りの写し)を撮る。風上の雲・風下の乾き(雨陰)・下層の流れの迂回を目視確認するため。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.cloud-lab');
const outDir = path.join(buildDir, 'shots-mountain');
const port = 8770;
const debugPort = 9447;

// cap の置き方。アンデス(20°S 西岸の乾燥帯と山脈)とハワイ(貿易風へ立つ高い島)。
const CAPS = [
  { name: 'andes', latitude: -20, longitude: -69, radius: 8 },
  { name: 'hawaii', latitude: 19.6, longitude: -155.5, radius: 5 },
];
const SHOT_HOURS = [0, 13];
const SHOT_VIEWS = ['composite', 'surfaceHumidity'];

async function main() {
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-cloud-lab-mountain-', onEvent,
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
      for (const hours of SHOT_HOURS) {
        await devTools.evaluate(`window.cloudLab.setTime(${hours})`);
        for (const view of SHOT_VIEWS) {
          await devTools.evaluate(`window.cloudLab.show(${JSON.stringify(view)})`);
          const dataUrl = await devTools.evaluate('window.cloudLab.capture()');
          writeFileSync(
            path.join(outDir, `${cap.name}-${view}-${hours}h.png`),
            Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
          console.log(`shot ${cap.name} ${view} at ${hours} h`);
        }
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
