// 指定した撮影を品質設定の内部ラスタ寸法で保存する。
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const [caseName, shotName, mode, wavelengthArg, directionArg, scaleArg] = process.argv.slice(2);
const waveMode = ['wave', 'wave-invert', 'wave-residual', 'wave-residual-invert'].includes(mode);
const wave = waveMode ? {
  wavelengthKm: Number(wavelengthArg), directionDeg: Number(directionArg),
  phaseDeg: mode.endsWith('-invert') ? 180 : 0,
  composition: mode.startsWith('wave-residual') ? 'coverage-residual' : 'absolute',
} : undefined;
const scaleValue = mode === 'base' ? wavelengthArg : scaleArg;
const scale = scaleValue === undefined ? undefined : Number(scaleValue);
if (!caseName || !shotName || !/^[\w.-]+$/.test(caseName) || !/^[\w.-]+$/.test(shotName)
  || (mode !== undefined && mode !== 'base' && !waveMode)
  || (mode === 'base' && (directionArg !== undefined || scaleArg !== undefined
    || (scale !== undefined && (!Number.isFinite(scale) || scale <= 0))))
  || (waveMode && (!Number.isFinite(wave.wavelengthKm) || wave.wavelengthKm <= 0
    || !Number.isFinite(wave.directionDeg) || (scale !== undefined && (!Number.isFinite(scale) || scale <= 0))))) {
  throw new Error('usage: node tools/render-lab-native-shot.mjs <case-name> <shot-name> [base [resolution-scale] | wave|wave-invert|wave-residual|wave-residual-invert <wavelength-km> <direction-deg> [resolution-scale]]');
}

const { fatalEvents, onEvent } = collectFatalEvents();
const session = await openChromeSession({
  serveDir: path.join(root, '.render-lab'), port: 8787, debugPort: 9464,
  profilePrefix: 'tepui-render-lab-native-', onEvent,
});
try {
  const { devTools } = session;
  await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
  await waitFor(
    devTools,
    "(document.getElementById('error')?.textContent || typeof window.renderLab?.shootNative === 'function')",
    'the render lab to initialise',
  );
  const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
  if (failure) throw new Error(`Render lab failed to initialise: ${failure}`);
  const png = await devTools.evaluate(
    `window.renderLab.shootNative(${JSON.stringify(caseName)}, ${JSON.stringify(shotName)}, ${JSON.stringify(
      scale === undefined ? {} : { resolutionScale: scale },
    )}, ${JSON.stringify(mode === 'base' ? null : wave)})`,
  );
  if (fatalEvents.length) throw new Error(`Page reported errors:\n${fatalEvents.join('\n')}`);
  const suffix = mode === 'base' ? `-base${scale === undefined ? '' : `-${scale}scale`}` : waveMode
    ? `-${mode}-${wavelengthArg}km-${directionArg}deg${scale === undefined ? '' : `-${scale}scale`}` : '';
  const output = path.join(root, '.render-lab', 'native-shots', `${caseName}-${shotName}${suffix}.png`);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, Buffer.from(png.slice(png.indexOf(',') + 1), 'base64'));
  console.log(output);
} finally {
  await session.close();
}
