// 描画テスト環境の計測。ヘッドレス Chrome で .render-lab/ を開き、構図 × 大気の段の組ごとに
// window.renderLab.measure() を呼んで、パス別 GPU 時間の「大気」行を表にする。
//
// 熱によるドリフトを差と切り分けるため、同じ組を複数回巡り、偶数回目は逆順で回す。巡る回数は
// 第 1 引数(既定 2)。結果は巡ごとの平均と、その中央値で出す。
import path from 'node:path';
import { openChromeSession, sleep } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.render-lab');
const port = 8769;
const debugPort = 9446;

// 測る構図。angles はケース既定の観察の向きへ重ねる。
const FRAMINGS = [
  { label: 'earth', caseName: 'earth', angles: {} },
  { label: 'earth-mars', caseName: 'earth-mars', angles: {} },
  { label: 'earth-mars d=-2', caseName: 'earth-mars', angles: { cameraDistanceLog: -2 } },
  { label: 'far', caseName: 'far', angles: {} },
];

// 大気の品質(src/render/graphics-settings.ts の ATMOSPHERE_QUALITY)。
const QUALITIES = [['オフ', 0], ['低', 1], ['中', 2], ['高', 3]];

async function main() {
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-render-lab-m-',
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    for (let i = 0; i < 600; i++) {
      if (await devTools.evaluate('typeof window.renderLab === "object"')) break;
      await sleep(200);
    }

    const adapter = await devTools.evaluate(
      '(async () => { const a = await navigator.gpu.requestAdapter(); const i = a.info ?? {};'
      + ' return [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(" / "); })()',
    );
    console.log(`adapter: ${adapter}`);

    const rows = new Map();
    const combos = [];
    for (const framing of FRAMINGS) for (const [qLabel, q] of QUALITIES) combos.push({ framing, qLabel, q });
    const passes = Math.max(1, Number(process.argv[2] ?? 2));
    for (const pass of Array.from(
      { length: passes }, (_, index) => (index % 2 === 0 ? combos : [...combos].reverse()),
    )) {
      for (const { framing, qLabel, q } of pass) {
        await devTools.evaluate(`window.renderLab.setGraphicsOption('atmosphere', ${q})`);
        const result = await devTools.evaluate(
          `window.renderLab.measure(${JSON.stringify(framing.caseName)}, ${JSON.stringify(framing.angles)})`,
        );
        const key = `${framing.label} / ${qLabel}`;
        const atmosphere = result.gpuPassMs['大気'];
        const entry = rows.get(key) ?? { supported: result.gpuSupported, runs: [] };
        entry.runs.push({ gpu: atmosphere, cpu: result.cpuRenderMs });
        rows.set(key, entry);
        console.log(`measured ${key}  gpu=${atmosphere.avg.toFixed(3)}ms cpu=${result.cpuRenderMs.avg.toFixed(3)}ms`);
      }
    }

    console.log('\n| 構図 / 段 | 大気 GPU 中央値 [ms] | 巡ごとの avg |');
    console.log('| --- | --- | --- |');
    for (const [key, { runs }] of rows) {
      const avgs = runs.map((run) => run.gpu.avg).sort((a, b) => a - b);
      const median = avgs.length % 2 === 1
        ? avgs[(avgs.length - 1) / 2]
        : (avgs[avgs.length / 2 - 1] + avgs[avgs.length / 2]) / 2;
      console.log(`| ${key} | ${median.toFixed(3)} | ${runs.map((run) => run.gpu.avg.toFixed(2)).join(' / ')} |`);
    }
    console.log(`\ngpuSupported: ${[...rows.values()].every((r) => r.supported)}`);
  } finally {
    await session.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
