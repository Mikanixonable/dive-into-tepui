// 雲描画の GPU 負荷の計測。ヘッドレス Chrome で .render-lab/ を開き、雲が見える構図の撮影ごとに
// window.renderLab.measureShot() を呼んで、雲関連のパス(雲の生成・表面雲・大気(雲あり)・雲影)と
// 比較用の「大気」・全パス合計・CPU render 時間を表にする。同じ構図を雲なしでも測り、雲に帰るぶんを
// 差で出せるようにする。計測は表示時刻を 60fps で進めて行うので、「雲の生成」は 1 フレームあたりの
// 焼き直しの時間として読める。
//
// 熱によるドリフトを差と切り分けるため、同じ組を複数回巡り、偶数回目は逆順で回す。巡る回数は
// 第 1 引数(既定 2)。結果は巡ごとの平均と、その中央値で出す。
import path from 'node:path';
import { openChromeSession, sleep } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.render-lab');
const port = 8770;
const debugPort = 9447;

// 測る構図。ケース名と撮影名の組で、撮影が持つ観察の向きと描画品質設定の差分を当てて測る。
const FRAMINGS = [
  { label: '全球(極)', caseName: 'earth', shot: 'earth-polar' },
  { label: '低軌道', caseName: 'earth', shot: 'earth-low-orbit' },
  { label: '真下', caseName: 'earth', shot: 'earth-nadir' },
  { label: '地平線', caseName: 'earth', shot: 'earth' },
  { label: '斜視', caseName: 'earth', shot: 'earth-oblique' },
  { label: 'LEO(自機)', caseName: 'leo', shot: 'leo' },
];

// 雲の有無。なしは同じ構図の比較基準 — 大気は「大気(雲あり)」ではなく「大気」行へ載る。
const CLOUD_MODES = [['あり', true], ['なし', false]];

// 表へ出す GPU パス(GPU_PASS_LABELS のラベル)。
const REPORT_PASSES = ['雲の生成', '表面雲', '大気(雲あり)', '大気', '雲影'];

// 巡回ごとの値の中央値。
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length % 2 === 1
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
}

const fmt = (value) => value.toFixed(3);

async function main() {
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-render-lab-mc-',
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    for (let i = 0; i < 600; i++) {
      if (await devTools.evaluate('typeof window.renderLab?.measureShot === "function"')) break;
      await sleep(200);
    }

    const adapter = await devTools.evaluate(
      '(async () => { const a = await navigator.gpu.requestAdapter(); const i = a.info ?? {};'
      + ' return [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(" / "); })()',
    );
    console.log(`adapter: ${adapter}`);

    const rows = new Map();
    const combos = [];
    for (const framing of FRAMINGS) {
      for (const [cloudsLabel, clouds] of CLOUD_MODES) combos.push({ framing, cloudsLabel, clouds });
    }
    const passes = Math.max(1, Number(process.argv[2] ?? 2));
    for (const pass of Array.from(
      { length: passes }, (_, index) => (index % 2 === 0 ? combos : [...combos].reverse()),
    )) {
      for (const { framing, cloudsLabel, clouds } of pass) {
        const result = await devTools.evaluate(
          `window.renderLab.measureShot(${JSON.stringify(framing.caseName)}, ${JSON.stringify(framing.shot)},`
          + ` ${JSON.stringify({ clouds })})`,
        );
        const key = `${framing.label} / 雲${cloudsLabel}`;
        const entry = rows.get(key) ?? { supported: result.gpuSupported, runs: [] };
        entry.runs.push({
          gpu: result.gpuPassMs,
          bakeCpu: result.gpuPassRenderCallCpuMs['雲の生成'],
          total: result.gpuPassTotalMs,
          cpu: result.cpuRenderMs,
        });
        rows.set(key, entry);
        const bake = result.gpuPassMs['雲の生成'];
        console.log(
          `measured ${key}  bake=${fmt(bake.avg)}ms total=${fmt(result.gpuPassTotalMs.avg)}ms`
          + ` cpu=${fmt(result.cpuRenderMs.avg)}ms`,
        );
      }
    }

    console.log(`\n| 構図 / 雲 | ${REPORT_PASSES.join(' | ')} | 全パス計 | CPU render | 生成 CPU |`);
    console.log(`| --- |${' --- |'.repeat(REPORT_PASSES.length + 3)}`);
    for (const [key, { runs }] of rows) {
      const cells = REPORT_PASSES.map((label) => fmt(median(runs.map((run) => run.gpu[label].avg))));
      const total = fmt(median(runs.map((run) => run.total.avg)));
      const cpu = fmt(median(runs.map((run) => run.cpu.avg)));
      const bakeCpu = fmt(median(runs.map((run) => run.bakeCpu.avg)));
      console.log(`| ${key} | ${cells.join(' | ')} | ${total} | ${cpu} | ${bakeCpu} |`);
    }

    // 構図ごとの全パス内訳。雲あり/なしの中央値を並べ、雲に帰るぶんが雲の計測対象外のパスへ
    // どれだけ漏れているかを読めるようにする。
    console.log('\n| 構図 | パス | 雲あり [ms] | 雲なし [ms] | 差 [ms] |');
    console.log('| --- | --- | --- | --- | --- |');
    const framingsByKey = new Map();
    for (const [key] of rows) {
      const [framing] = key.split(' / ');
      framingsByKey.set(framing, true);
    }
    for (const framing of [...framingsByKey.keys()]) {
      const on = rows.get(`${framing} / 雲あり`);
      const off = rows.get(`${framing} / 雲なし`);
      if (on === undefined || off === undefined) continue;
      const labels = Object.keys(on.runs[0].gpu);
      for (const label of labels) {
        const onMs = median(on.runs.map((run) => run.gpu[label].avg));
        const offMs = median(off.runs.map((run) => run.gpu[label].avg));
        if (Math.max(onMs, offMs) < 0.02) continue;
        console.log(`| ${framing} | ${label} | ${fmt(onMs)} | ${fmt(offMs)} | ${fmt(onMs - offMs)} |`);
      }
    }

    console.log('\n巡ごとの avg [ms](雲の生成 / 全パス計 / CPU render):');
    for (const [key, { runs }] of rows) {
      const perRun = runs.map(
        (run) => `${fmt(run.gpu['雲の生成'].avg)} / ${fmt(run.total.avg)} / ${fmt(run.cpu.avg)}`,
      );
      console.log(`  ${key}: ${perRun.join('  |  ')}`);
    }
    console.log(`\ngpuSupported: ${[...rows.values()].every((r) => r.supported)}`);
  } finally {
    await session.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
