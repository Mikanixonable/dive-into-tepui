// 自発的な上昇セルの面の偏りの前後撮影。対流の活発度と雲の写しのビューを、面の項を切った
// 状態(mountainActivity/warmSeaActivity = 0、項の追加前と同じ活発度)と既定値の 2 組で撮り、
// .cloud-lab/activity-shots/{before,after}/ へ書く。ヘッドレス Chrome で .cloud-lab/ を開き、
// window.cloudLab の setParams で一つのセッションの中で焼き直して撮る。
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.cloud-lab');
const outDir = path.join(buildDir, 'activity-shots');
const port = 8778;
const debugPort = 9455;
// 撮る時刻 [h] と写しの列。convectiveActivity で活発度そのもの、cumulus/coverage/
// convectiveDepth/composite で写した雲を見る。
const SHOT_HOURS = [0, 25];
const VIEWS = ['convectiveActivity', 'cumulus', 'coverage', 'convectiveDepth', 'composite'];

// 面の項を切った組(before)と、いまの調整値そのものの組(after)。
const SETS = [
  ['before', { mountainActivity: 0, warmSeaActivity: 0 }],
  ['after', null], // null = 撮影の開始時に読んだ既定値へ戻す
];

async function main() {
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-cloud-lab-', onEvent,
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
    for (const [name, params] of SETS) {
      await devTools.evaluate(`window.cloudLab.setParams(${JSON.stringify(params ?? defaults)})`);
      const dir = path.join(outDir, name);
      mkdirSync(dir, { recursive: true });
      for (const hours of SHOT_HOURS) {
        await devTools.evaluate(`window.cloudLab.setTime(${hours})`);
        for (const view of VIEWS) {
          await devTools.evaluate(`window.cloudLab.show(${JSON.stringify(view)})`);
          const dataUrl = await devTools.evaluate('window.cloudLab.capture()');
          writeFileSync(path.join(dir, `${view}-${hours}h.png`), Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
          console.log(`shot ${name}/${view} at ${hours} h`);
        }
      }
    }
    if (fatalEvents.length > 0) throw new Error(`Page reported errors during shooting:\n${fatalEvents.join('\n')}`);
    console.log(`Wrote ${SETS.length * VIEWS.length * SHOT_HOURS.length} PNGs to ${path.relative(root, outDir)}`);
  } finally {
    await session.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
