// 描画テスト環境の計測。ヘッドレス Chrome で .render-lab/ を開き、構図 × 大気の段の組ごとに
// window.renderLab.measure() を呼んで、パス別 GPU 時間の「大気」行を表にする。続けて
// earth ケースで積雲の精細さ 粗/標準/精細 × 巻雲の精細さ 粗/標準/精細 の組を測り、雲の 3 パス
// (cloudSurface・cloudAtmosphere・cloudShadow)の GPU 時間を表に出す。
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
];

// 大気の品質(src/render/graphics-settings.ts の ATMOSPHERE_QUALITY)。
const QUALITIES = [['オフ', 0], ['低', 1], ['中', 2], ['高', 3]];

// 雲の段の組。積雲の精細さは src/render/opaque-cloud-surface-renderer.ts の CUMULUS_DETAIL、
// 巻雲の精細さは src/render/cloud/cloud-detail.ts の CIRRUS_DETAIL。大気は「高」、雲と雲の影と
// 巻雲はオンに固定して、3 パスが全部描く状態で測る。
const CLOUD_DETAIL_TIERS = [['粗', 1], ['標準', 2], ['精細', 3]];
const CIRRUS_TIERS = [['巻雲粗', 0], ['巻雲標準', 1], ['巻雲精細', 2]];
const CLOUD_PASSES = [['表面雲', 'cloudSurface'], ['大気(雲あり)', 'cloudAtmosphere'], ['雲影', 'cloudShadow']];

// 巡ごとの標本から中央値を出す。
function medianOf(runs) {
  const avgs = runs.map((run) => run).sort((a, b) => a - b);
  return avgs.length % 2 === 1
    ? avgs[(avgs.length - 1) / 2]
    : (avgs[avgs.length / 2 - 1] + avgs[avgs.length / 2]) / 2;
}

async function main() {
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-render-lab-m-',
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    for (let i = 0; i < 600; i++) {
      if (await devTools.evaluate('typeof window.renderLab?.measure === "function"')) break;
      await sleep(200);
    }

    const adapter = await devTools.evaluate(
      '(async () => { const a = await navigator.gpu.requestAdapter(); const i = a.info ?? {};'
      + ' return [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(" / "); })()',
    );
    console.log(`adapter: ${adapter}`);

    const passes = Math.max(1, Number(process.argv[2] ?? 2));

    const rows = new Map();
    const combos = [];
    for (const framing of FRAMINGS) for (const [qLabel, q] of QUALITIES) combos.push({ framing, qLabel, q });
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
      const median = medianOf(runs.map((run) => run.gpu.avg));
      console.log(`| ${key} | ${median.toFixed(3)} | ${runs.map((run) => run.gpu.avg.toFixed(2)).join(' / ')} |`);
    }
    console.log(`\ngpuSupported: ${[...rows.values()].every((r) => r.supported)}`);

    // 雲の段。earth ケース・大気「高」固定で、積雲の精細さ × 巻雲の組を測る。
    const cloudCombos = [];
    for (const [detailLabel, detail] of CLOUD_DETAIL_TIERS) {
      for (const [cirrusLabel, cirrus] of CIRRUS_TIERS) {
        cloudCombos.push({ detailLabel, detail, cirrusLabel, cirrus });
      }
    }
    const cloudRows = new Map();
    for (const pass of Array.from(
      { length: passes }, (_, index) => (index % 2 === 0 ? cloudCombos : [...cloudCombos].reverse()),
    )) {
      for (const { detailLabel, detail, cirrusLabel, cirrus } of pass) {
        await devTools.evaluate(`window.renderLab.setGraphicsOption('atmosphere', 3)`);
        await devTools.evaluate(`window.renderLab.setGraphicsOption('clouds', true)`);
        await devTools.evaluate(`window.renderLab.setGraphicsOption('cloudShadow', true)`);
        await devTools.evaluate(`window.renderLab.setGraphicsOption('cumulusDetail', ${detail})`);
        await devTools.evaluate(`window.renderLab.setGraphicsOption('cirrus', true)`);
        await devTools.evaluate(`window.renderLab.setGraphicsOption('cirrusDetail', ${cirrus})`);
        const result = await devTools.evaluate('window.renderLab.measure("earth", {})');
        const key = `積雲${detailLabel} × ${cirrusLabel}`;
        const entry = cloudRows.get(key) ?? { supported: result.gpuSupported, runs: [] };
        entry.runs.push(CLOUD_PASSES.map(([label]) => result.gpuPassMs[label].avg));
        cloudRows.set(key, entry);
        console.log(`measured earth ${key}  ${CLOUD_PASSES.map(([label], i) => `${label}=${entry.runs.at(-1)[i].toFixed(3)}ms`).join(' ')}`);
      }
    }

    console.log('\n| earth の雲の段 | 表面雲 [ms] | 大気(雲あり) [ms] | 雲影 [ms] | 3 パス計 [ms] |');
    console.log('| --- | --- | --- | --- | --- |');
    for (const [key, { runs }] of cloudRows) {
      const medians = CLOUD_PASSES.map((_, i) => medianOf(runs.map((run) => run[i])));
      const total = medians.reduce((sum, v) => sum + v, 0);
      console.log(`| ${key} | ${medians.map((v) => v.toFixed(3)).join(' | ')} | ${total.toFixed(3)} |`);
    }
    console.log(`\ngpuSupported: ${[...cloudRows.values()].every((r) => r.supported)}`);
  } finally {
    await session.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
