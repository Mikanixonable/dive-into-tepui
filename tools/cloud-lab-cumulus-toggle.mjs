// 最初の applyShot で雲場が空になる一過性の問題の内部状態を読む。
// 適用のたびに雲のフラグ・active uniform・cap 配置・焼き世代を吐き出し、
// 空のフレームと雲のあるフレームで何が違うかを見る。
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.cloud-lab');
const outDir = path.join(buildDir, 'shots-toggle');
const port = 8775;
const debugPort = 9453;

const STEPS = [
  ['a-shot-cirrus', 'wpac-itcz-0h-4km-cirrus', {}],
  ['b-wpac-both', 'wpac-itcz-0h-4km-both', {}],
  ['c-shot-cirrus-again', 'wpac-itcz-0h-4km-cirrus', {}],
];

// lab 内部の状態を JSON で引く式。TS private は実行時のプロパティ名を変えない。
const DUMP = `(() => {
  const v = window.cloudLabDetail.labView;
  const earth = v['earth'];
  const clouds = earth?.['clouds'];
  const pipeline = v['pipeline'];
  const pass = pipeline?.['atmospherePass'];
  const layer = pass?.['layer'];
  const cloudLayers = layer?.['cloudLayers'];
  const renderer = cloudLayers?.['clouds'];
  const source = clouds?.['source'];
  const cap = clouds?.['cap'];
  const placement = cap?.['placement'];
  return JSON.stringify({
    cloudsVisible: clouds?.cloudsVisible,
    cumulusEnabled: clouds?.cumulusEnabled,
    cirrusEnabled: clouds?.cirrusEnabled,
    active: renderer?.['active']?.value,
    capCenter: placement?.center?.toArray?.()?.map((x) => x.toFixed(3)),
    capSinRadius: placement?.sinRadius?.toFixed?.(4),
    generation: source?.generation,
    olderTime: source?.['olderTime'],
    lastDisplayTime: source?.['lastDisplayTime'],
    lastProjectionRevision: source?.['lastBakedProjectionRevision'],
    projectionRevision: source?.['projection']?.revision,
    graphicsClouds: v['graphics']?.current?.clouds,
    graphicsCumulus: v['graphics']?.current?.cumulus,
    graphicsCirrus: v['graphics']?.current?.cirrus,
  });
})()`;

async function main() {
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-cloud-lab-toggle-', onEvent,
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/detail.html` });
    await waitFor(devTools, "typeof window.cloudLabDetail === 'object'", 'cloud lab detail');
    // 初期の showSelection() の撮影が終わるまで待つ — cloudLabDetail は撮影の完了を待たずに
    // 公開されるので、待たないと初期撮影がこちらの applyShot へ割り込む。
    for (let i = 0; i < 10; i++) {
      console.log('status:', await devTools.evaluate(
        "document.getElementById('status')?.textContent ?? ''"));
      await new Promise((r) => setTimeout(r, 1000));
    }
    mkdirSync(outDir, { recursive: true });
    for (const [label, shot, graphics] of STEPS) {
      await devTools.evaluate(
        `window.cloudLabDetail.applyShot(${JSON.stringify(shot)}, ${JSON.stringify(graphics)})`,
      );
      console.log(label, 'after apply:', await devTools.evaluate(DUMP));
      let png = '';
      for (let i = 0; i < 4; i++) png = await devTools.evaluate('window.cloudLabDetail.capture()');
      console.log(label, 'after captures:', await devTools.evaluate(DUMP));
      const file = path.join(outDir, `${label}.png`);
      writeFileSync(file, Buffer.from(png.split(',')[1], 'base64'));
      console.log('wrote', file);
    }
  } finally {
    await session.close();
  }
  if (fatalEvents.length > 0) {
    console.error('--- fatal events ---');
    for (const e of fatalEvents) console.error(e);
  }
}

await main();
