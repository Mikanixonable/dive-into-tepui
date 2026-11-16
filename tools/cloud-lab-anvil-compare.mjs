// かなとこの見え方の比較撮影。同じ cap・時刻で、ベールあり(現在値)・なし・広域半径の
// 3条件を撮り、かなとこの寄与と半径の効きを見比べるため。出力は memos のセッション画像置き場。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.cloud-lab');
const outDir = path.join(root, 'memos/mikanixonable/sessions/shots/anvil-compare');
const port = 8774;
const debugPort = 9451;

const CAPS = [
  { name: 'amazon', latitude: -3, longitude: -60, radius: 6 },
  { name: 'amazon-tight', latitude: -3, longitude: -60, radius: 2 },
  { name: 'westpacific', latitude: 8, longitude: 145, radius: 6 },
  { name: 'westpacific-tight', latitude: 8, longitude: 145, radius: 2 },
  { name: 'southernocean', latitude: -55, longitude: -150, radius: 8 },
  { name: 'itcz', latitude: 5, longitude: -165, radius: 8 },
];
const HOURS = [14];
const VIEWS = ['cirrus', 'composite'];
// パラメータの組。既定値は撮影時に cloudLab.params() から拾って戻す。
const PARAM_SETS = [
  { name: 'off', params: { detrainGain: 0 } },
  { name: 'on', params: {} },
  { name: 'wide150', params: { detrainSpreadRadius: 150e3, detrainSpreadWeight: 0.3 } },
];

async function main() {
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-cloud-lab-anvilcmp-', onEvent,
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/?capture-only` });
    await waitFor(
      devTools,
      "(document.getElementById('error')?.textContent || typeof window.cloudLab === 'object')",
      'the cloud lab to initialise',
    );
    const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
    if (failure) throw new Error(`Cloud lab failed to initialise: ${failure}`);

    const defaults = await devTools.evaluate('window.cloudLab.params()');
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    for (const cap of CAPS) {
      await devTools.evaluate(
        `window.cloudLab.aimCap(${cap.latitude}, ${cap.longitude}, ${cap.radius})`);
      for (const hours of HOURS) {
        await devTools.evaluate(`window.cloudLab.setTime(${hours})`);
        for (const set of PARAM_SETS) {
          await devTools.evaluate(
            `window.cloudLab.setParams({ detrainGain: ${defaults.detrainGain}, ` +
            `detrainSpreadRadius: ${defaults.detrainSpreadRadius}, ` +
            `detrainSpreadWeight: ${defaults.detrainSpreadWeight}, ` +
            `${Object.entries(set.params).map(([k, v]) => `${k}: ${v}`).join(', ')} })`);
          for (const view of VIEWS) {
            await devTools.evaluate(`window.cloudLab.show(${JSON.stringify(view)})`);
            const dataUrl = await devTools.evaluate('window.cloudLab.capture()');
            writeFileSync(
              path.join(outDir, `${cap.name}-${view}-${set.name}-${hours}h.png`),
              Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
            console.log(`shot ${cap.name} ${view} ${set.name} at ${hours} h`);
          }
        }
      }
    }
    console.log(`Wrote PNGs to ${path.relative(root, outDir)}`);
    if (fatalEvents.length > 0) {
      console.error('fatal events:', fatalEvents);
      process.exitCode = 1;
    }
  } finally {
    await session.close();
  }
}

main();
