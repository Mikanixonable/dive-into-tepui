// かなとこ(脱出水ベール)の撮影。対流の強い域へ cap を向け、合成・巻雲・積雲の写しを撮る。
// 孤立した塔のまわりに直径数十キロのかなとこが架かるか、風下へ伸びるかを目視確認するため。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.cloud-lab');
const outDir = path.join(buildDir, 'shots-anvil');
const port = 8772;
const debugPort = 9449;

// cap の置き方。アマゾン(午後の陸上対流)と西太平洋の収束帯(熱帯の海上対流)。
const CAPS = [
  { name: 'amazon', latitude: -3, longitude: -60, radius: 6 },
  { name: 'westpacific', latitude: 8, longitude: 145, radius: 6 },
];
const SHOT_HOURS = [0, 14];
const SHOT_VIEWS = ['composite', 'cirrus', 'cumulus'];

async function main() {
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-cloud-lab-anvil-', onEvent,
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

main();
