// 起動から雲場が採用されるまでの壁時計を測る。docs/ の本番ビルドを静的配信し、
// ?stage=00 でランを起こし、dataset.gameReady / dataset.cloudFieldReady が立つまでの
// 時刻を記録する。
import { openChromeSession, sleep } from './chrome-session.mjs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.resolve(process.argv[2] ?? path.join(root, 'docs'));
const port = 8781;
const debugPort = 9481;

async function main() {
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-cloud-startup-',
  });
  try {
    const { devTools } = session;
    const t0 = Date.now();
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/?stage=00` });
    let gameReadyMs = null;
    let cloudReadyMs = null;
    const deadline = t0 + 120_000;
    while (Date.now() < deadline && (gameReadyMs === null || cloudReadyMs === null)) {
      const state = await devTools.evaluate(`({
        gameReady: document.documentElement.dataset.gameReady === 'true',
        cloudFieldReady: document.documentElement.dataset.cloudFieldReady === 'true',
        fatal: document.getElementById('fatal-error-overlay')?.textContent ?? '',
      })`);
      if (state.fatal) throw new Error(`fatal overlay: ${state.fatal}`);
      if (state.gameReady && gameReadyMs === null) gameReadyMs = Date.now() - t0;
      if (state.cloudFieldReady && cloudReadyMs === null) cloudReadyMs = Date.now() - t0;
      await sleep(50);
    }
    console.log(JSON.stringify({
      gameReadyMs, cloudReadyMs,
      note: 'navigate から dataset.gameReady / dataset.cloudFieldReady までの壁時計',
    }));
  } finally {
    await session.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
