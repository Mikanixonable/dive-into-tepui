// デザインリファレンスの土台を、ゲームの実ソースから書き出す。
//
//   node build.mjs            src/ から themes.js と tepui-base.css を書き出す
//   node build.mjs --capture  加えて docs/ のビルドを起動し、現行画面を current/ へ撮り直す
//                             (先に `npm run build` を済ませておく)
//
// 書き出すもの:
//   themes.js        配色プリセットごとの CSS 変数(src/theme.ts の themeCssVariables の出力そのもの)
//   tepui-base.css   共通 UI の CSS(src/hud/style/common-ui-style.ts が注入する、レイアウト寸法・
//                    ガラス面・状態・ウィジェット11種)と、HUD のレイアウト寸法
//                    (src/game/hud/style/layout-tokens.ts: レール幅・行の最小高さ・ブレークポイント別の値)
//   current/*.jpg    現行画面のスクリーンショット(--capture のときだけ)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const here = import.meta.dirname;
let repoRoot = here;
while (!fs.existsSync(path.join(repoRoot, 'package.json'))) repoRoot = path.dirname(repoRoot);
const { build } = await import(pathToFileURL(path.join(repoRoot, 'node_modules/esbuild/lib/main.js')).href);

// --- themes.js と tepui-base.css -------------------------------------------------------------
// injectCommonUiStyle は document.head へ <style> を足すだけなので、その呼び出しを受け止める
// 最小の document を置いて、注入される CSS 文字列を取り出す。
const entry = `
  import { THEME_PRESETS, themeCssVariables } from './src/theme';
  import { injectCommonUiStyle } from './src/hud/style/common-ui-style';
  import { LAYOUT_TOKENS_STYLE } from './src/game/hud/style/layout-tokens';
  const styles = [];
  globalThis.document = {
    createElement: () => ({ textContent: '' }),
    head: { appendChild: (el) => styles.push(el.textContent) },
  };
  injectCommonUiStyle();
  export const css = styles.join('\\n') + '\\n' + LAYOUT_TOKENS_STYLE;
  export const themes = THEME_PRESETS.map((p) => ({
    id: p.id, name: p.name, description: p.description, tone: p.tone, vars: themeCssVariables(p),
  }));
`;
const result = await build({
  stdin: { contents: entry, resolveDir: repoRoot, loader: 'ts' },
  bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'error',
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`;
const { css, themes } = await import(moduleUrl);
const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
const stamp = `src/ @ ${commit} から foundation/build.mjs が生成。手で編集しない。`;

fs.writeFileSync(path.join(here, 'themes.js'),
  `// ${stamp}\n// 配色プリセットごとの CSS 変数。既定は src/theme.ts の DEFAULT_THEME_ID と同じ。\n`
  + `window.TEPUI_THEMES = ${JSON.stringify(themes, null, 1)};\n`
  + `window.TEPUI_DEFAULT_THEME = 'fluorescent-red-blue';\n`);
fs.writeFileSync(path.join(here, 'tepui-base.css'), `/* ${stamp} */\n${css}\n`);
console.log(`themes.js (${themes.length} presets), tepui-base.css (${css.length} chars) @ ${commit}`);

// --- 現行画面の撮影 ---------------------------------------------------------------------------
if (process.argv.includes('--capture')) {
  const { openChromeSession, sleep, waitFor, collectFatalEvents } = await import(
    pathToFileURL(path.join(repoRoot, 'tools/chrome-session.mjs')).href);
  const outDir = path.join(here, 'current');
  fs.mkdirSync(outDir, { recursive: true });

  const scenarios = [
    { size: { width: 1600, height: 900 }, query: '?stage=1', shots: ['combat', 'map', 'pause', 'help', 'property'] },
    { size: { width: 844, height: 390 }, query: '?stage=1', shots: ['combat', 'map'], suffix: '-phone' },
  ];
  for (const scenario of scenarios) {
    const { fatalEvents, onEvent } = collectFatalEvents();
    const session = await openChromeSession({
      serveDir: path.join(repoRoot, 'docs'), port: 8771, debugPort: 9241, profilePrefix: 'tepui-ref-',
      windowSize: scenario.size, onEvent,
    });
    const dt = session.devTools;
    const key = async (k, code, keyCode) => {
      await dt.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: keyCode });
      await dt.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: keyCode });
    };
    const shot = async (name) => {
      const { data } = await dt.send('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
      fs.writeFileSync(path.join(outDir, `${name}${scenario.suffix ?? ''}.jpg`), Buffer.from(data, 'base64'));
    };
    try {
      await dt.send('Page.navigate', { url: `${session.baseUrl}/${scenario.query}` });
      await waitFor(dt, `document.documentElement.dataset.gameReady === 'true'`, 'game ready', 90_000);
      await sleep(2500);
      await key('t', 'KeyT', 84); await sleep(800);
      if (scenario.shots.includes('combat')) await shot('combat');
      if (scenario.shots.includes('property')) {
        // 敵一覧の単独行を右クリックすると、その敵のプロパティウィンドウが開く。
        const at = await dt.evaluate(`(() => {
          const r = document.querySelector('#hud-enemies .contact-row')?.getBoundingClientRect();
          return r ? { x: r.left + 24, y: r.top + r.height / 2 } : null;
        })()`);
        if (at) {
          for (const type of ['mousePressed', 'mouseReleased']) {
            await dt.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'right', buttons: 2, clickCount: 1 });
          }
        }
        await sleep(900);
        await shot('property');
        await key('Escape', 'Escape', 27); await sleep(500);
      }
      await key('m', 'KeyM', 77); await sleep(1500);
      if (scenario.shots.includes('map')) await shot('map');
      if (scenario.shots.includes('pause')) {
        await key('Escape', 'Escape', 27); await sleep(800);
        await shot('pause');
        await key('Escape', 'Escape', 27); await sleep(500);
      }
      if (scenario.shots.includes('help')) {
        await key('h', 'KeyH', 72); await sleep(800);
        await shot('help');
        await key('Escape', 'Escape', 27); await sleep(500);
      }
      if (fatalEvents.length > 0) console.warn('page errors:', fatalEvents.slice(0, 3));
    } finally {
      await session.close();
    }
  }
  fs.writeFileSync(path.join(outDir, 'SOURCE.txt'), `${stamp}\n撮影: ${new Date().toISOString()}\n`);
  console.log(`captured into ${path.relative(repoRoot, outDir)}`);
}
