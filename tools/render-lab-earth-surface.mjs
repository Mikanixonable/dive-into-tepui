// 既存の地球5ケースを固定viewportで撮影し、画像本文の再現情報を専用ディレクトリへ残す。
// 見た目の良否は人間が確認するため、このスクリプトは画像を自動合格にしない。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.render-lab');
const outDir = path.join(buildDir, 'earth-surface-shots');
const port = 8768;
const debugPort = 9445;
const VIEWPORT = { width: 960, height: 540 };
const EARTH_CASES = ['earth', 'earth-oblique', 'earth-polar', 'earth-polar-terminator', 'earth-terminator'];

function metricFor(caseName, bytes) {
  return { caseName, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length };
}

function normalizeMetrics(cases) {
  return {
    schemaVersion: 1,
    viewport: { width: VIEWPORT.width, height: VIEWPORT.height },
    cases: [...cases].sort((left, right) => left.caseName < right.caseName ? -1 : left.caseName > right.caseName ? 1 : 0),
  };
}

async function main() {
  const index = path.join(buildDir, 'index.html');
  if (!existsSync(index)) throw new Error(`Render-lab production build is missing: ${buildDir}`);
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir,
    port,
    debugPort,
    profilePrefix: 'tepui-render-lab-earth-surface-',
    windowSize: VIEWPORT,
    onEvent,
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    await waitFor(
      devTools,
      "(document.getElementById('error')?.textContent || typeof window.renderLab === 'object')",
      'the render lab to initialise',
    );
    const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
    if (failure) throw new Error(`Render lab failed to initialise: ${failure}`);
    const available = await devTools.evaluate('window.renderLab.cases');
    for (const name of EARTH_CASES) {
      if (!available.includes(name)) throw new Error(`Render lab case is unavailable: ${name}`);
    }

    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const metrics = [];
    for (const name of EARTH_CASES) {
      const dataUrl = await devTools.evaluate(`window.renderLab.shoot(${JSON.stringify(name)})`);
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
        throw new Error(`Render lab returned a non-PNG image for ${name}`);
      }
      const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
      if (bytes.length === 0) throw new Error(`Render lab returned an empty PNG for ${name}`);
      writeFileSync(path.join(outDir, `${name}.png`), bytes);
      metrics.push(metricFor(name, bytes));
      console.log(`shot ${name}`);
    }
    if (fatalEvents.length > 0) throw new Error(`Page reported errors during shooting:\n${fatalEvents.join('\n')}`);
    const normalized = normalizeMetrics(metrics);
    writeFileSync(path.join(outDir, 'metrics.json'), `${JSON.stringify(normalized)}\n`);
    console.log(`Wrote ${EARTH_CASES.length} PNGs and metrics.json to ${path.relative(root, outDir)}`);
  } finally {
    await session.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
