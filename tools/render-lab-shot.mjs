// 描画テスト環境の撮影。ヘッドレス Chrome で .render-lab/ を開き、ケースごとに
// window.renderLab.shoot() を呼んで PNG を書く。画素はページ側が合成パスの出力先から
// 読み出しているので、WebGPU キャンバスの提示・Page.captureScreenshot はどこも通らない。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openChromeSession, sleep } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.render-lab');
const outDir = path.join(buildDir, 'shots');
const port = 8767;
const debugPort = 9444;

async function waitFor(devTools, expression, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await devTools.evaluate(expression)) return;
    await sleep(200);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}.`);
}

async function main() {
  const fatalEvents = [];
  const session = await openChromeSession({
    serveDir: buildDir,
    port,
    debugPort,
    profilePrefix: 'tepui-render-lab-',
    onEvent: (event) => {
      if (event.method === 'Runtime.exceptionThrown') fatalEvents.push(event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text);
      if (event.method === 'Runtime.consoleAPICalled' && event.params?.type === 'error') fatalEvents.push(event.params.args.map((arg) => arg.description ?? String(arg.value)).join(' '));
      if (event.method === 'Inspector.targetCrashed') fatalEvents.push('renderer target crashed');
    },
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    // 2 台のレンダラーの init() が終わるまで撮れない。ページが失敗を文字で出していたらそれを読む。
    await waitFor(
      devTools,
      "(document.getElementById('error')?.textContent || typeof window.renderLab === 'object')",
      'the render lab to initialise',
    );
    const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
    if (failure) throw new Error(`Render lab failed to initialise: ${failure}`);

    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const names = await devTools.evaluate('window.renderLab.cases');
    for (const name of names) {
      const shot = await devTools.evaluate(`window.renderLab.shoot(${JSON.stringify(name)})`);
      for (const [pathName, dataUrl] of Object.entries(shot)) {
        const file = path.join(outDir, `${name}-${pathName}.png`);
        writeFileSync(file, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
      }
      console.log(`shot ${name}`);
    }
    if (fatalEvents.length > 0) throw new Error(`Page reported errors during shooting:\n${fatalEvents.join('\n')}`);
    console.log(`Wrote ${names.length * 3} PNGs to ${path.relative(root, outDir)}`);
  } finally {
    await session.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
