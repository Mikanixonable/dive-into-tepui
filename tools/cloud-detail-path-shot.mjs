// 局所残差タイルの位相だけを反転し、中間描画経路ごとの画像差を確認する。
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';
import { decodePng } from './png.mjs';

const root = path.resolve(import.meta.dirname, '..');
const targets = ['material', 'atmosphere', 'shadow'];
const { fatalEvents, onEvent } = collectFatalEvents();
const session = await openChromeSession({
  serveDir: path.join(root, '.render-lab'), port: 8789, debugPort: 9466,
  profilePrefix: 'tepui-cloud-detail-path-', onEvent,
});
try {
  const { devTools } = session;
  await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
  await waitFor(devTools,
    "(document.getElementById('error')?.textContent || typeof window.renderLab?.shootNative === 'function')",
    'render lab capture API');
  const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
  if (failure) throw new Error(failure);
  const outputDir = path.join(root, '.render-lab', 'cloud-detail-path-shots');
  mkdirSync(outputDir, { recursive: true });
  for (const target of targets) {
    let firstPhase = null;
    let invertedPhase = null;
    for (const phaseDeg of [0, 180, 0]) {
      const diagnostic = { wavelengthKm: 2, directionDeg: 0, phaseDeg, composition: 'coverage-residual' };
      await devTools.evaluate(`window.renderLab.shootNative('earth',
        'cloud-detail-residual-200km-north-diagnostic', {}, ${JSON.stringify(diagnostic)})`);
      const png = await devTools.evaluate(`(async () => {
        window.renderLab.setTarget(${JSON.stringify(target)});
        let previous = await window.renderLab.capture();
        for (let attempt = 0; attempt < 6; attempt += 1) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const current = await window.renderLab.capture();
          if (current === previous) return current;
          previous = current;
        }
        throw new Error('debug target did not settle');
      })()`);
      if (fatalEvents.length) throw new Error(fatalEvents.join('\n'));
      const bytes = Buffer.from(png.slice(png.indexOf(',') + 1), 'base64');
      if (phaseDeg === 0 && firstPhase !== null) {
        if (!bytes.equals(firstPhase)) throw new Error(`${target}: same phase is not reproducible`);
        continue;
      }
      if (phaseDeg === 0) firstPhase = bytes;
      else invertedPhase = bytes;
      const output = path.join(outputDir, `${target}-${phaseDeg}deg.png`);
      writeFileSync(output, bytes);
    }
    if (firstPhase === null || invertedPhase === null) throw new Error(`${target}: missing phase pair`);
    const first = decodePng(firstPhase);
    const inverted = decodePng(invertedPhase);
    if (first.width !== inverted.width || first.height !== inverted.height
      || first.channels !== inverted.channels) throw new Error(`${target}: incompatible phase images`);
    let changedBytes = 0;
    let maximumDifference = 0;
    for (let index = 0; index < first.data.length; index += 1) {
      const difference = Math.abs(first.data[index] - inverted.data[index]);
      if (difference > 0) changedBytes += 1;
      maximumDifference = Math.max(maximumDifference, difference);
    }
    if (changedBytes === 0) throw new Error(`${target}: cloud detail did not reach the debug target`);
    console.log(JSON.stringify({ target, changedBytes, maximumDifference,
      width: first.width, height: first.height, samePhaseReproduced: true }));
  }
} finally {
  await session.close();
}
