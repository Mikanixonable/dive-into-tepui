// 雲の実験環境の時系列撮影。各成果物に、適用した入力と計測結果の有無を manifest として添える。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.cloud-lab');
const port = 8768;
const debugPort = 9445;
const SERIES_VIEWS = ['coverage', 'cloudTop', 'translucent', 'composite'];

function outDirOf(seriesName) {
  if (seriesName === undefined) return path.join(buildDir, 'shots');
  if (!/^[\w.-]+$/.test(seriesName) || seriesName === '.' || seriesName === '..') {
    throw new Error('usage: node tools/cloud-lab-shot.mjs [<series-name>]');
  }
  return path.join(root, '.cloud-lab-shots', seriesName);
}

async function main() {
  const outDir = outDirOf(process.argv[2]);
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-cloud-lab-', onEvent,
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    await waitFor(
      devTools,
      "(document.getElementById('error')?.textContent || typeof window.cloudLab === 'object')",
      'the cloud lab to initialise',
    );
    const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
    if (failure) throw new Error(`Cloud lab failed to initialise: ${failure}`);

    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const hoursList = await devTools.evaluate('window.cloudLab.fixtureTimesHours');
    for (const hours of hoursList) {
      await devTools.evaluate(`window.cloudLab.setTime(${hours})`);
      for (const view of SERIES_VIEWS) {
        await devTools.evaluate(`window.cloudLab.show(${JSON.stringify(view)})`);
        const dataUrl = await devTools.evaluate('window.cloudLab.capture()');
        const timeLabel = String(hours).replace('.', 'p');
        writeFileSync(path.join(outDir, `${view}-${timeLabel}h.png`), Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
        console.log(`shot ${view} at ${hours} h`);
      }
    }
    writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify({
      name: process.argv[2] ?? 'unnamed',
      source: 'current-generated-cloud-field',
      fixtureInputsApplied: false,
      fixtureResults: null,
      views: SERIES_VIEWS,
      timesHours: hoursList,
    }, null, 2)}\n`);
    if (fatalEvents.length > 0) throw new Error(`Page reported errors during shooting:\n${fatalEvents.join('\n')}`);
    console.log(`Wrote ${SERIES_VIEWS.length * hoursList.length} PNGs to ${path.relative(root, outDir)}`);
  } finally {
    await session.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
