// ESC メニューの一時停止タブと設定タブ(描画/BGM/配色)を撮る一時スクリプト。
import fs from 'node:fs';
import path from 'node:path';
import { openChromeSession, waitFor, collectFatalEvents, sleep } from '../tools/chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'scratch', 'pm-shots');
fs.mkdirSync(outDir, { recursive: true });

const { fatalEvents, onEvent } = collectFatalEvents();
const session = await openChromeSession({
  serveDir: path.join(root, 'docs'),
  port: 8791,
  debugPort: 9223,
  profilePrefix: 'pm-shot-',
  windowSize: {
    width: Number(process.env.SHOT_WIDTH ?? 1440),
    height: Number(process.env.SHOT_HEIGHT ?? 900),
  },
  onEvent,
});
const { devTools } = session;

const pressEscape = async () => {
  for (const type of ['keyDown', 'keyUp']) {
    await devTools.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  }
};

const shot = async (name) => {
  const result = await devTools.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(result.data, 'base64'));
};

try {
  await devTools.send('Page.navigate', { url: `${session.baseUrl}/?stage=00` });
  await waitFor(devTools, `document.documentElement.dataset.gameReady === 'true'`, 'game ready', 60_000);
  await pressEscape();
  await waitFor(
    devTools,
    `getComputedStyle(document.getElementById('hud-pause-menu')).display !== 'none'`,
    'pause menu open',
  );
  await sleep(400);
  await shot('01-pause-tab');

  await devTools.evaluate(
    `[...document.querySelectorAll('#hud-pause-menu .pm-tabs .w-btn')]
      .find((b) => b.textContent.includes('SETTINGS'))?.click()`,
  );
  await sleep(400);

  for (const label of ['描画', 'BGM', '配色']) {
    await devTools.evaluate(
      `[...document.querySelectorAll('#hud-pause-menu .sv-tabs .w-btn')]
        .find((b) => b.textContent.trim() === '${label}')?.click()`,
    );
    await sleep(400);
    await shot(`02-settings-${label}`);
    const metrics = await devTools.evaluate(`(() => {
      const panel = document.getElementById('hud-pause-menu');
      const tc = panel.querySelector('.pm-tab-content');
      return {
        panelH: Math.round(panel.getBoundingClientRect().height),
        panelMaxH: getComputedStyle(panel).maxHeight,
        innerH: window.innerHeight,
        tabScrollable: tc.scrollHeight > tc.clientHeight,
        tabOverflowY: getComputedStyle(tc).overflowY,
        tabClientH: Math.round(tc.clientHeight),
        tabScrollH: tc.scrollHeight,
      };
    })()`);
    console.log(`[${label}]`, JSON.stringify(metrics));
  }
} finally {
  await session.close();
}
if (fatalEvents.length) console.error('fatal:', fatalEvents.join('\n'));
console.log(`shots written to ${outDir}`);
