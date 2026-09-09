// 雲のBlue Noise/LOD診断。ケース既定のカメラ・displayTime=0・960x540を各条件で再適用し、
// 同じ入力からPNG、連続フレーム差分、既存GpuTimingsの分布を条件ごとに保存する。
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';
import { decodePng } from './png.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.render-lab');
const outDir = path.join(buildDir, 'cloud-sampling-compare');
const port = 8768;
const debugPort = 9445;
const caseName = 'earth-oblique';
const conditions = [
  { id: 'blue-on-explicit', blueNoiseEnabled: true, lodMode: 'explicit' },
  { id: 'blue-off-explicit', blueNoiseEnabled: false, lodMode: 'explicit' },
  { id: 'blue-on-fixed', blueNoiseEnabled: true, lodMode: 'fixed' },
  { id: 'blue-off-fixed', blueNoiseEnabled: false, lodMode: 'fixed' },
];

function isUnusedProteinAssetFetch(error) {
  return error.includes('Failed to fetch protein asset payload') && error.includes('404');
}

function pngFromDataUrl(dataUrl) {
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function comparePngs(firstBytes, secondBytes) {
  const first = decodePng(firstBytes);
  const second = decodePng(secondBytes);
  if (first.width !== second.width || first.height !== second.height || first.channels !== second.channels) {
    throw new Error('Frame captures have different PNG dimensions or channel counts.');
  }
  let sum = 0;
  let max = 0;
  let changedPixels = 0;
  const channels = Math.min(3, first.channels);
  for (let pixel = 0; pixel < first.width * first.height; pixel++) {
    let pixelChanged = false;
    for (let channel = 0; channel < channels; channel++) {
      const delta = Math.abs(first.data[pixel * first.channels + channel] - second.data[pixel * second.channels + channel]);
      sum += delta;
      max = Math.max(max, delta);
      pixelChanged ||= delta !== 0;
    }
    if (pixelChanged) changedPixels++;
  }
  return {
    width: first.width,
    height: first.height,
    comparedChannels: channels,
    meanAbsoluteDifference: sum / (first.width * first.height * channels),
    maxAbsoluteDifference: max,
    changedPixels,
  };
}

async function main() {
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-render-lab-cloud-sampling-', onEvent,
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    await waitFor(
      devTools,
      "(document.getElementById('error')?.textContent || typeof window.renderLab?.setCloudSampling === 'function')",
      'the render lab to initialise',
    );
    const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
    if (failure) throw new Error(`Render lab failed to initialise: ${failure}`);

    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const reports = [];
    for (const condition of conditions) {
      await devTools.evaluate(
        `window.renderLab.setCloudSampling(${JSON.stringify(condition.blueNoiseEnabled)}, ${JSON.stringify(condition.lodMode)})`,
      );
      const shot = pngFromDataUrl(await devTools.evaluate(`window.renderLab.shoot(${JSON.stringify(caseName)})`));
      // shoot()後の最初のcaptureは、条件切替後の履歴・シェーダ暖機を含みうる。1枚捨ててから
      // 連続2フレームを比較し、Blue Noiseの有無以外の初回差を比較値へ混ぜない。
      await devTools.evaluate('window.renderLab.capture()');
      const frameA = pngFromDataUrl(await devTools.evaluate('window.renderLab.capture()'));
      const frameB = pngFromDataUrl(await devTools.evaluate('window.renderLab.capture()'));
      const measurement = await devTools.evaluate(`window.renderLab.measure(${JSON.stringify(caseName)})`);
      writeFileSync(path.join(outDir, `${condition.id}.png`), shot);
      const report = {
        condition,
        input: {
          caseName,
          displayTime: 0,
          camera: 'case default',
          viewport: { width: 960, height: 540 },
          cloudField: 'same generated global climate field',
        },
        imageSha256: sha256(shot),
        frameToFrame: comparePngs(frameA, frameB),
        gpu: {
          supported: measurement.gpuSupported,
          passMs: measurement.gpuPassMs,
          frames: measurement.frames,
        },
      };
      reports.push(report);
      writeFileSync(path.join(outDir, `${condition.id}.json`), `${JSON.stringify(report, null, 2)}\n`);
      console.log(`compared ${condition.id}`);
    }
    const summary = {
      schemaVersion: 1,
      comparison: 'Blue Noise on/off × explicit/fixed LOD',
      reports,
    };
    writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    const unexpectedFatalEvents = fatalEvents.filter((error) => !isUnusedProteinAssetFetch(error));
    if (unexpectedFatalEvents.length > 0) {
      throw new Error(`Page reported errors during comparison:\n${unexpectedFatalEvents.join('\n')}`);
    }
    console.log(`Wrote ${conditions.length} condition PNGs and reports to ${path.relative(root, outDir)}`);
  } finally {
    await session.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
