// 雲の実験環境の撮影。ヘッドレス Chrome で .cloud-lab/ を開き、表示の種類 × 時刻ごとに
// window.cloudLab.capture() を呼んで PNG を書く。画素はページ側が撮影ターゲットから読み出す。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.cloud-lab');
const outDir = path.join(buildDir, 'shots');
const port = 8768;
const debugPort = 9445;
// 撮る時刻 [h]。0 と、移流の周期の整数倍でない 1 点。
const SHOT_HOURS = [0, 25];

async function main() {
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-cloud-lab-', onEvent,
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    await waitFor(
      devTools,
      "(document.getElementById('error')?.textContent || typeof window.cloudLab === 'object')",
      'the cloud lab to initialise',
    );
    const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
    if (failure) throw new Error(`Cloud lab failed to initialise: ${failure}`);

    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const views = await devTools.evaluate('window.cloudLab.views');
    for (const hours of SHOT_HOURS) {
      await devTools.evaluate(`window.cloudLab.setTime(${hours})`);
      for (const view of views) {
        await devTools.evaluate(`window.cloudLab.show(${JSON.stringify(view)})`);
        const dataUrl = await devTools.evaluate('window.cloudLab.capture()');
        writeFileSync(path.join(outDir, `${view}-${hours}h.png`), Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
        console.log(`shot ${view} at ${hours} h`);
      }
    }
    if (fatalEvents.length > 0) throw new Error(`Page reported errors during shooting:\n${fatalEvents.join('\n')}`);
    console.log(`Wrote ${views.length * SHOT_HOURS.length} PNGs to ${path.relative(root, outDir)}`);
  } finally {
    await session.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
