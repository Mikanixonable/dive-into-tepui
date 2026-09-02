// 実写の分離環境(.cloud-lab/separate.html)をヘッドレス Chrome で開き、分離した各チャンネルを
// PNG に書く。層境界の 3 チャンネル(被覆率・雲頂高度・薄い雲 τ)は描画側が仮テクスチャとして
// 読む生成アセットなので src/assets/ へ直接焼く(export-climate などと同じ流儀)。veil(巻雲の
// 輝度)と recomposed(再合成 — 入力と見比べて分離の癖を探す)は検分用で .cloud-lab/separated/ へ。
// 分離の方法と調整パラメータは tools/cloud-lab/separation-pipeline.ts。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';
import { decodeRedPng, fieldToGrayPng } from './gray-image.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.cloud-lab');
const assetsDir = path.join(root, 'src', 'assets');
const outDir = path.join(buildDir, 'separated');
const port = 8770;
const debugPort = 9447;

// 撮る量と書き先。並びは器(仮テクスチャ 3 枚)→ 検分用。
const SHOTS = [
  ['coverage', path.join(assetsDir, 'cloud-coverage.png')],
  ['cloudTop', path.join(assetsDir, 'cloud-top.png')],
  ['translucent', path.join(assetsDir, 'cloud-translucent.png')],
  ['veil', path.join(outDir, 'veil.png')],
  ['recomposed', path.join(outDir, 'recomposed.png')],
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
      // キャンバス由来の RGBA PNG のままだと 4 倍近く重いので、グレースケール 8bit へ詰め直す。
      const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
      writeFileSync(file, fieldToGrayPng(decodeRedPng(png)));
      console.log(`wrote ${path.relative(root, file)}`);
    }
    if (fatalEvents.length > 0) throw new Error(`Page reported errors:\n${fatalEvents.join('\n')}`);
    // 分離の質の指標(意味は tools/cloud-lab/separate-main.ts)。調整の前後比較の記録用。
    const metrics = await devTools.evaluate('window.cloudSeparate.metrics()');
    console.log(`相関 全体 ${metrics.corrAll.toFixed(3)} / 150-600km ${metrics.corrBand.toFixed(3)}`
      + ` | 平均 veil ${metrics.veilMean.toFixed(3)} / thick ${metrics.thickMean.toFixed(3)}`);
    console.log('Wrote the 3 provisional textures to src/assets and 2 inspection PNGs to .cloud-lab/separated');
  } finally {
    await session.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
