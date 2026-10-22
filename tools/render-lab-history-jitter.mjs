// 近傍拡散補正の履歴読みジッターを、render-lab の同じ場面で測り、数値と画像を保存する。
// usage: node tools/render-lab-history-jitter.mjs <set-name> [<case-name>=cornell-box [<shot-name>=cornell-box]]
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { evaluateLong, openLabPage, openMotionLab } from './render-lab-motion-scenes.mjs';

const root = path.resolve(import.meta.dirname, '..');
const outputRoot = path.join(root, '.render-lab-shots');
const port = 8767;
const debugPort = 9444;
const REFERENCE_FRAMES = 128;

function outputDirectoryOf(setName) {
  if (setName === undefined || !/^[\w.-]+$/.test(setName) || setName === '.' || setName === '..') {
    throw new Error('usage: node tools/render-lab-history-jitter.mjs <set-name> [<case-name>=cornell-box [<shot-name>=cornell-box]]');
  }
  return path.join(outputRoot, setName);
}

async function main() {
  const [, , setName, caseName = 'cornell-box', shotName = 'cornell-box', ...extra] = process.argv;
  if (extra.length > 0) throw new Error('usage: node tools/render-lab-history-jitter.mjs <set-name> [<case-name>=cornell-box [<shot-name>=cornell-box]]');
  const outputDirectory = outputDirectoryOf(setName);
  const { session, devTools, fatalEvents } = await openMotionLab({
    port, debugPort, profilePrefix: 'tepui-history-jitter-',
  });
  try {
    await openLabPage(session);
    const availableCases = await devTools.evaluate('window.renderLab.cases');
    if (!availableCases.includes(caseName)) {
      throw new Error(`Unknown render-lab case "${caseName}"; available cases: ${availableCases.join(', ')}`);
    }

    // shot 名が無いと showShot が明示的なエラーを返す。長い構築や撮影は個別の CDP 要求で完了を待つ。
    await evaluateLong(
      devTools,
      `window.renderLab.showShot(${JSON.stringify(caseName)}, ${JSON.stringify(shotName)})`
        + `.then(() => window.renderLab.captureAccumulated()).then(() => true)`,
      `capture ${caseName}/${shotName}`,
    );
    const comparison = await evaluateLong(
      devTools,
      `window.renderLab.compareHistoryAccumulation(${REFERENCE_FRAMES})`,
      `compare history accumulation for ${caseName}/${shotName}`,
    );

    rmSync(outputDirectory, { recursive: true, force: true });
    mkdirSync(outputDirectory, { recursive: true });
    const imageKeys = new Set(comparison.results.flatMap(({ referenceImageKey, imageKey }) => [
      referenceImageKey, imageKey,
    ]));
    for (const key of imageKeys) {
      // 画像は個別に取得する。CDP の 1 応答が約 4 MB を超えると接続が閉じる。
      const dataUrl = await devTools.evaluate(
        `window.renderLab.historyAccumulationComparisonImage(${JSON.stringify(key)})`,
      );
      writeFileSync(
        path.join(outputDirectory, `${key}.png`),
        Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'),
      );
    }
    const report = {
      caseName,
      shotName,
      requestedReferenceFrames: comparison.requestedReferenceFrames,
      results: comparison.results,
    };
    writeFileSync(path.join(outputDirectory, 'metrics.json'), `${JSON.stringify(report)}\n`);
    if (fatalEvents.length > 0) throw new Error(`Page reported errors during comparison:\n${fatalEvents.join('\n')}`);
    console.log(`Wrote history jitter metrics and ${imageKeys.size} PNGs to ${path.relative(root, outputDirectory)}`);
  } finally {
    await session.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
