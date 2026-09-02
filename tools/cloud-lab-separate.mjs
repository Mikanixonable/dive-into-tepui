// 実写の分離環境(.cloud-lab/separate.html)をヘッドレス Chrome で開き、分離した各チャンネルを
// PNG にして .cloud-lab/separated/ へ書く。描画側が仮テクスチャとして使うのは coverage /
// cloud-top / translucent の 3 枚で、veil(巻雲の輝度)と recomposed(再合成 — 入力と見比べて
// 分離の癖を探す)は検分用。分離の方法と調整パラメータは tools/cloud-lab/separation-pipeline.ts。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.cloud-lab');
const outDir = path.join(buildDir, 'separated');
const port = 8770;
const debugPort = 9447;

// 撮る量と書き先。並びは器(coverage / cloud-top / translucent)→ 検分用。
const SHOTS = [
  ['coverage', 'coverage.png'],
  ['cloudTop', 'cloud-top.png'],
  ['translucent', 'translucent.png'],
  ['veil', 'veil.png'],
  ['recomposed', 'recomposed.png'],
];

async function main() {
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-cloud-separate-', onEvent,
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/separate.html` });
    await waitFor(
      devTools,
      "(document.getElementById('error')?.textContent || typeof window.cloudSeparate === 'object')",
      'the separation page to initialise',
    );
    const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
    if (failure) throw new Error(`Separation page failed to initialise: ${failure}`);

    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    for (const [view, file] of SHOTS) {
      const dataUrl = await devTools.evaluate(`window.cloudSeparate.capture(${JSON.stringify(view)})`);
      writeFileSync(path.join(outDir, file), Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
      console.log(`wrote ${file}`);
    }
    if (fatalEvents.length > 0) throw new Error(`Page reported errors:\n${fatalEvents.join('\n')}`);
    console.log(`Wrote ${SHOTS.length} PNGs to ${path.relative(root, outDir)}`);
  } finally {
    await session.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
