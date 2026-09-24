// 指定した撮影を品質設定の内部ラスタ寸法で保存する。
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const [caseName, shotName] = process.argv.slice(2);
if (!caseName || !shotName || !/^[\w.-]+$/.test(caseName) || !/^[\w.-]+$/.test(shotName)) {
  throw new Error('usage: node tools/render-lab-native-shot.mjs <case-name> <shot-name>');
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
    `window.renderLab.shootNative(${JSON.stringify(caseName)}, ${JSON.stringify(shotName)})`,
  );
  if (fatalEvents.length) throw new Error(`Page reported errors:\n${fatalEvents.join('\n')}`);
  const output = path.join(root, '.render-lab', 'native-shots', `${caseName}-${shotName}.png`);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, Buffer.from(png.slice(png.indexOf(',') + 1), 'base64'));
  console.log(output);
} finally {
  await session.close();
}
