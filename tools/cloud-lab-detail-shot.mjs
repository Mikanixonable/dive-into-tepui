// render-lab と同じ描画経路(detail.html)で、雲の細部の撮影を指定名だけ撮る単発の撮影口。
// 使い方: node tools/cloud-lab-detail-shot.mjs <出力dir> <撮影名> [<撮影名>…]
// 撮影名は window.cloudLabDetail.cloudDetailShots() の名(例: wpac-itcz-12h-4km-both)。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.resolve(root, process.argv[2] ?? '.cloud-lab/detail-shots');
const names = process.argv.slice(3);
if (names.length === 0) throw new Error('usage: node cloud-lab-detail-shot.mjs <出力dir> <撮影名>…');
const port = 8773;
const debugPort = 9451;

async function main() {
  mkdirSync(outDir, { recursive: true });
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: path.join(root, '.cloud-lab'), port, debugPort,
    profilePrefix: 'tepui-cloud-detail-shot-', onEvent,
    requestTimeoutMs: 120_000,
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/detail.html` });
    await waitFor(
      devTools,
      "(document.getElementById('error')?.textContent || typeof window.cloudLabDetail?.shootCloudDetail === 'function')",
      'the cloud lab detail page to initialise',
    );
    const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
    if (failure) throw new Error(`detail page failed to initialise: ${failure}`);
    // ページは cloudLabDetail を公開したあとも既定の撮影を非同期で回し続ける — 外部からの撮影が
    // その途中の状態を上書きするので、既定の撮影が終わるまで待つ。
    await waitFor(
      devTools,
      "document.getElementById('status') && !document.getElementById('status').textContent.startsWith('撮影中')",
      'the initial shot to finish',
    );
    for (const name of names) {
      const file = path.join(outDir, `${name}.png`);
      if (existsSync(file)) continue;
      console.log(`shot ${name}`);
      const dataUrl = await devTools.evaluate(
        `window.cloudLabDetail.shootCloudDetail(${JSON.stringify(name)})`,
      );
      writeFileSync(file, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
    }
    if (fatalEvents.length > 0) throw new Error(`errors during shooting:\n${fatalEvents.join('\n')}`);
    console.log(`Wrote PNGs to ${outDir}`);
  } finally {
    await session.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
