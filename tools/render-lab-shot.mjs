// 描画テスト環境の撮影。ヘッドレス Chrome で .render-lab/ を開き、ケースごとに
// window.renderLab.shoot() を呼んで、ケースが宣言した向きごとの PNG を 1 枚ずつ受け取り、撮影名で書く。
// 書き先は第 1 引数に撮影の組の名前を渡せば .render-lab-shots/<名前>/、省けば .render-lab/shots で、
// 撮影の前に作り直す。組の名前に続く「項目=値」(値は JSON。例: planetLightCount=0)は、全ケースの撮影へ
// 重ねる描画品質設定の差分になる。= を含まない引数にカンマ区切りの名前を渡すと、一致または前方一致するケースだけを
// 撮る。--case=<caseName> はケースを 1 つに絞り、--shot=<shotName> を加えるとその撮影だけを撮る。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.render-lab');
const port = 8767;
const debugPort = 9444;
// いまのケースの撮影結果(撮影名から PNG のデータ URL への表)を、取り出し終えるまでページ内に置く名前。
const PENDING_PNGS = '__renderLabPendingPngs';
const REPEATED_EARTH_SHOTS = new Set([
  'earth-nadir', 'earth-oblique', 'earth-limb', 'earth-low-orbit', 'earth-low-sun', 'earth-twilight',
]);
const EARTH_REPEAT_COUNT = 2;

const USAGE = 'usage: node tools/render-lab-shot.mjs [<shot-set-name> [<case-prefix>[,...]] '
  + '[--case=<caseName> [--shot=<shotName>]] [<graphics-option>=<json> ...]]';

// 撮影の組の名前 setName(省けば undefined)の書き先。名前が /^[\w.-]+$/ に合わないか . / .. なら
// 使い方を投げる。
function outDirOf(setName) {
  if (setName === undefined) return path.join(buildDir, 'shots');
  if (!/^[\w.-]+$/.test(setName) || setName === '.' || setName === '..') throw new Error(USAGE);
  return path.join(root, '.render-lab-shots', setName);
}

// 「項目=値」の並び args を描画品質設定の差分へ。= の前が空の引数があれば使い方を投げる。
function graphicsOf(args) {
  return Object.fromEntries(args.map((arg) => {
    const separator = arg.indexOf('=');
    if (separator <= 0) throw new Error(USAGE);
    return [arg.slice(0, separator), JSON.parse(arg.slice(separator + 1))];
  }));
}

async function main() {
  const outDir = outDirOf(process.argv[2]);
  const args = process.argv.slice(3);
  const caseArgs = args.filter((arg) => arg.startsWith('--case='));
  const shotArgs = args.filter((arg) => arg.startsWith('--shot='));
  if (caseArgs.length > 1 || caseArgs.some((arg) => arg.length === '--case='.length)
    || shotArgs.length > 1 || shotArgs.some((arg) => arg.length === '--shot='.length)) throw new Error(USAGE);
  const caseName = caseArgs[0]?.slice('--case='.length);
  const shotName = shotArgs[0]?.slice('--shot='.length);
  if (shotName !== undefined && (caseName === undefined || !/^[\w.-]+$/.test(shotName)
    || shotName === '.' || shotName === '..')) throw new Error(USAGE);
  const filterArgs = args.filter((arg) => !arg.startsWith('--') && !arg.includes('='));
  if (filterArgs.length > 1) throw new Error(USAGE);
  const filter = filterArgs[0]?.split(',').map((name) => name.trim()).filter(Boolean) ?? [];
  const graphics = graphicsOf(args.filter((arg) => !arg.startsWith('--') && arg.includes('=')));
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
    const availableNames = await devTools.evaluate('window.renderLab.cases');
    if (caseName !== undefined && !availableNames.includes(caseName)) {
      throw new Error(`Unknown render-lab case "${caseName}"; available cases: ${availableNames.join(', ')}`);
    }
    const names = caseName !== undefined ? [caseName] : filter.length === 0 ? availableNames : availableNames.filter(
      (name) => filter.some((prefix) => name === prefix || name.startsWith(prefix)),
    );
    const shotNames = new Set();
    for (const name of names) {
      if (shotName !== undefined) {
        // 1 枚だけ必要なとき shoot() は全撮影が終わるまで返らないので、指定撮影を直接反映して撮る。
        const dataUrl = await devTools.evaluate(
          `window.renderLab.showShot(${JSON.stringify(name)}, ${JSON.stringify(shotName)}, ${JSON.stringify(graphics)})`
          + `.then(() => window.renderLab.captureAccumulated())`,
        );
        writeFileSync(
          path.join(outDir, `${shotName}.png`), Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'),
        );
        shotNames.add(shotName);
        console.log(`shot ${shotName}`);
        continue;
      }
      // **PNG は 1 枚ずつ受け取る** — CDP の 1 メッセージが約 4 MB を超えると接続が閉じるので、ケースの
      // 全撮影をまとめて返させると、撮影の多いケースで落ちる。
      const repeatCount = name === 'earth' ? EARTH_REPEAT_COUNT : 1;
      for (let repeat = 1; repeat <= repeatCount; repeat += 1) {
        const caseShotNames = await devTools.evaluate(
          `window.renderLab.shoot(${JSON.stringify(name)}, ${JSON.stringify(graphics)}).then((pngs) => {
            window.${PENDING_PNGS} = pngs;
            return Object.keys(pngs);
          })`,
        );
        for (const shotName of caseShotNames) {
          const repeated = name === 'earth' && REPEATED_EARTH_SHOTS.has(shotName);
          if (repeat > 1 && !repeated) continue;
          const outputName = repeated ? `${shotName}-r${String(repeat).padStart(2, '0')}` : shotName;
          // 撮影名が重なると、後の撮影が先の PNG を黙って上書きする。
          if (shotNames.has(outputName)) throw new Error(`Shot name "${outputName}" (case ${name}) is used twice`);
          shotNames.add(outputName);
          const dataUrl = await devTools.evaluate(`window.${PENDING_PNGS}[${JSON.stringify(shotName)}]`);
          writeFileSync(
            path.join(outDir, `${outputName}.png`), Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'),
          );
          console.log(`shot ${outputName}`);
        }
        await devTools.evaluate(`delete window.${PENDING_PNGS}`);
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
