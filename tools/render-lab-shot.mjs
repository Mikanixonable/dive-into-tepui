// 描画テスト環境の撮影。ヘッドレス Chrome で .render-lab/ を開き、ケースごとに
// window.renderLab.shoot() を呼んで、ケースが宣言した向きごとの PNG を 1 枚ずつ受け取り、撮影名で書く。
// 書き先は第 1 引数に撮影の組の名前を渡せば .render-lab-shots/<名前>/、省けば .render-lab/shots で、
// 撮影の前に作り直す。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.render-lab');
const port = 8767;
const debugPort = 9444;
// いまのケースの撮影結果(撮影名から PNG のデータ URL への表)を、取り出し終えるまでページ内に置く名前。
const PENDING_PNGS = '__renderLabPendingPngs';

// 撮影の組の名前 setName(省けば undefined)の書き先。名前が /^[\w.-]+$/ に合わないか . / .. なら
// 使い方を投げる。
function outDirOf(setName) {
  if (setName === undefined) return path.join(buildDir, 'shots');
  if (!/^[\w.-]+$/.test(setName) || setName === '.' || setName === '..') {
    throw new Error('usage: node tools/render-lab-shot.mjs [<shot-set-name>]');
  }
  return path.join(root, '.render-lab-shots', setName);
}

async function main() {
  const outDir = outDirOf(process.argv[2]);
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
      // **PNG は 1 枚ずつ受け取る** — CDP の 1 メッセージが約 4 MB を超えると接続が閉じるので、ケースの
      // 全撮影をまとめて返させると、撮影の多いケースで落ちる。
      const caseShotNames = await devTools.evaluate(
        `window.renderLab.shoot(${JSON.stringify(name)}).then((pngs) => {
          window.${PENDING_PNGS} = pngs;
          return Object.keys(pngs);
        })`,
      );
      for (const shotName of caseShotNames) {
        // 撮影名が重なると、後の撮影が先の PNG を黙って上書きする。
        if (shotNames.has(shotName)) throw new Error(`Shot name "${shotName}" (case ${name}) is used twice`);
        shotNames.add(shotName);
        const dataUrl = await devTools.evaluate(`window.${PENDING_PNGS}[${JSON.stringify(shotName)}]`);
        writeFileSync(
          path.join(outDir, `${shotName}.png`), Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'),
        );
        console.log(`shot ${shotName}`);
      }
      await devTools.evaluate(`delete window.${PENDING_PNGS}`);
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
