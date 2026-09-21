// 描画テスト環境の撮影。ヘッドレス Chrome で .render-lab/ を開き、ケースごとに
// window.renderLab.shoot() を呼んで、ケースが宣言した向きごとの PNG を撮影名で書く。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.render-lab');
const outDir = path.join(buildDir, 'shots');
const port = 8767;
const debugPort = 9444;

async function main() {
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-render-lab-', onEvent,
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    // レンダラーの init() が終わるまで撮れない。ページが失敗を文字で出していたらそれを読む。
    await waitFor(
      devTools,
      "(document.getElementById('error')?.textContent || typeof window.renderLab?.shoot === 'function')",
      'the render lab to initialise',
    );
    const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
    if (failure) throw new Error(`Render lab failed to initialise: ${failure}`);

    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const names = await devTools.evaluate('window.renderLab.cases');
    const shotNames = new Set();
    for (const name of names) {
      const pngs = await devTools.evaluate(`window.renderLab.shoot(${JSON.stringify(name)})`);
      for (const [shotName, dataUrl] of Object.entries(pngs)) {
        // 撮影名が重なると、後の撮影が先の PNG を黙って上書きする。
        if (shotNames.has(shotName)) throw new Error(`Shot name "${shotName}" (case ${name}) is used twice`);
        shotNames.add(shotName);
        writeFileSync(
          path.join(outDir, `${shotName}.png`), Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'),
        );
        console.log(`shot ${shotName}`);
      }
    }
    if (fatalEvents.length > 0) throw new Error(`Page reported errors during shooting:\n${fatalEvents.join('\n')}`);
    console.log(`Wrote ${shotNames.size} PNGs to ${path.relative(root, outDir)}`);
  } finally {
    await session.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
