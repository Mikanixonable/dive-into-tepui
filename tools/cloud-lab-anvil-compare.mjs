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
// 条件ごとに触るパラメータの一覧。既定値は撮影時に cloudLab.params() から拾い、
// 各条件の前に全部これへ戻す — 前の条件の値が残り込まないようにする。
const VARIED = [
  'detrainGain', 'detrainOnset', 'detrainFull', 'detrainActivityOnset', 'detrainActivityFull',
  'detrainSpreadRadius', 'detrainSpreadWeight',
  'detrainShieldRadius', 'detrainShieldGain',
];
// パラメータの組。見比べたい軸: 発火の門(emit)、塔の届く高さの床(act)、
// 群れの盾の半径と利得(shield)、ベール全体の厚さ(gain)。
const PARAM_SETS = [
  { name: 'off', params: { detrainGain: 0 } },
  { name: 'on', params: {} },
  // 活発度の床を切る(1 以上へ押し出して常に 0) — 粒を解像した塔だけが発火する従来の振る舞い。
  { name: 'actoff', params: { detrainActivityOnset: 1.01, detrainActivityFull: 1.02 } },
  // 床の位置 — 弱い対流圏にも乗る / 強い帯だけに絞る。
  { name: 'act04-07', params: { detrainActivityOnset: 0.4, detrainActivityFull: 0.7 } },
  { name: 'act07-098', params: { detrainActivityOnset: 0.7, detrainActivityFull: 0.98 } },
  // 盾の広さの階段 — 大雑把さはこの半径が効く。
  { name: 'r20', params: { detrainShieldRadius: 20e3 } },
  { name: 'r100', params: { detrainShieldRadius: 100e3 } },
  // 盾の濃さ — 利得を落として飽和しない帯へ。
  { name: 'g4', params: { detrainShieldGain: 4 } },
  { name: 'g16', params: { detrainShieldGain: 16 } },
  // ベール全体の厚さ(円盤・尾・盾すべてに効く)。
  { name: 'thin', params: { detrainGain: 0.5 } },
  { name: 'thick', params: { detrainGain: 2 } },
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
            `window.cloudLab.setParams({ ${VARIED.map((k) => `${k}: ${defaults[k]}`).join(', ')}, ` +
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
