// チェジュ島の雲道の撮影。cap を済州島(33.4N, 126.5E)へ向け、地方時の異なる時刻で
// 表示の種類ごとに PNG を書く。架空の太陽(平均太陽日)の下での地方時を添えた名前にする。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.cloud-lab');
const outDir = path.join(buildDir, 'shots-jeju');
const port = 8769;
const debugPort = 9446;

// cap の置き方。済州島を中心へ、風下が見える半径。
const CAP = { latitude: 33.4, longitude: 126.5, radius: 3 };
// 撮る表示時刻 [h] と、その時の済州島の地方時 [時]。架空の太陽は太陽直下経度を
// −360°/日 の速さで西へ動かすので、済州島(経度 126.5°)の地方時は
// fract(t/24h + 0.5 + 126.5/360) × 24 で求まる。
const localHourAt = (hours) =>
  (((hours / 24 + 0.5 + CAP.longitude / 360) % 1) + 1) % 1 * 24;
const SHOT_HOURS = [0, 5.5, 13, 17, 21, 25];
// 撮る表示の種類。合成(雲の見え)と地表付近の湿度(湿りの写し)を見る。
const SHOT_VIEWS = ['composite', 'surfaceHumidity'];

async function main() {
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-cloud-lab-jeju-', onEvent,
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
    await devTools.evaluate(
      `window.cloudLab.aimCap(${CAP.latitude}, ${CAP.longitude}, ${CAP.radius})`);
    for (const hours of SHOT_HOURS) {
      await devTools.evaluate(`window.cloudLab.setTime(${hours})`);
      const local = localHourAt(hours).toFixed(1);
      for (const view of SHOT_VIEWS) {
        await devTools.evaluate(`window.cloudLab.show(${JSON.stringify(view)})`);
        const dataUrl = await devTools.evaluate('window.cloudLab.capture()');
        writeFileSync(
          path.join(outDir, `${view}-${hours}h-local${local}.png`),
          Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
        console.log(`shot ${view} at ${hours} h (local ${local})`);
      }
    }
    console.log(`Wrote ${SHOT_VIEWS.length * SHOT_HOURS.length} PNGs to ${path.relative(root, outDir)}`);
    if (fatalEvents.length > 0) {
      console.error('fatal events:', fatalEvents);
      process.exitCode = 1;
    }
  } finally {
    await session.close();
  }
}

await main();
