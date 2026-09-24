// 描画テスト環境の計測。ヘッドレス Chrome で .render-lab/ を開き、選んだ軸の構図 × 描画設定の段の組ごとに
// window.renderLab.measure() を呼んで、パス別 GPU 時間のうち軸が読む行を表にする。
//
// 使い方: node tools/render-lab-measure.mjs [巡回数] [軸](既定は 2 と atmosphere)。熱によるドリフトを
// 差と切り分けるため、同じ組を巡回数だけ巡り、偶数回目は逆順で回す。結果は巡ごとの値と、その中央値で出す。
import path from 'node:path';
import { openChromeSession, sleep } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.render-lab');
const port = 8769;
const debugPort = 9446;

const USAGE = 'usage: node tools/render-lab-measure.mjs [巡回数] [軸]';

// 測る軸。framings の angles はケース既定の観察の向きへ重ねる。variants の graphics は setGraphicsOption へ
// 渡す描画設定の差分で、差分に無い鍵は直前に測った段の値のまま残る。rows は result.gpuPassMs の行名
// (src/render/gpu-timings.ts の GPU_PASS_LABELS)。
const AXES = {
  // 値は大気の品質(src/render/graphics-settings.ts の ATMOSPHERE_QUALITY)。
  atmosphere: {
    framings: [
      { label: 'earth', caseName: 'earth', angles: {} },
      { label: 'earth-mars', caseName: 'earth-mars', angles: {} },
      { label: 'earth-mars d=-2', caseName: 'earth-mars', angles: { cameraDistanceLog: -2 } },
    ],
    variants: [
      { label: 'オフ', graphics: { atmosphere: 0 } },
      { label: '低', graphics: { atmosphere: 1 } },
      { label: '中', graphics: { atmosphere: 2 } },
      { label: '高', graphics: { atmosphere: 3 } },
    ],
    rows: ['大気'],
  },
  // 値は src/render/graphics-settings.ts の screenSpaceDiffuse / screenSpaceQuality の選択肢。
  'screen-space': {
    statistic: 'p50',
    framings: [{ label: 'bay', caseName: 'bay', angles: {} }],
    variants: [
      { label: 'オフ', graphics: { screenSpaceDiffuse: 0 } },
      { label: '遮蔽・低', graphics: { screenSpaceDiffuse: 1, screenSpaceQuality: 0 } },
      { label: '遮蔽・中', graphics: { screenSpaceDiffuse: 1, screenSpaceQuality: 1 } },
      { label: '遮蔽・高', graphics: { screenSpaceDiffuse: 1, screenSpaceQuality: 2 } },
      { label: '遮蔽と照り返し・低', graphics: { screenSpaceDiffuse: 2, screenSpaceQuality: 0 } },
      { label: '遮蔽と照り返し・中', graphics: { screenSpaceDiffuse: 2, screenSpaceQuality: 1 } },
      { label: '遮蔽と照り返し・高', graphics: { screenSpaceDiffuse: 2, screenSpaceQuality: 2 } },
    ],
    rows: ['照り返し源', '近傍拡散走査', '近傍拡散復元', 'マテリアル'],
    ratioRows: ['照り返し源', '近傍拡散走査', '近傍拡散復元'],
    ratioLabel: '近傍拡散合計',
  },
};

// 軸の rows に含めると、ratioRows の中央値の和をこの行の中央値で割った比の列が表に付く。
const RATIO_DENOMINATOR_ROW = 'マテリアル';

// 小数 digits 桁の文字列にする。null(読めなかった値)は — にする。
function formatFixed(value, digits) {
  return value === null ? '—' : value.toFixed(digits);
}

// null を除いた値の中央値。1つも残らなければ null。
function medianOf(values) {
  const sorted = values.filter((value) => value !== null).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const half = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2;
}

// 組ごとに、rows の各行の中央値と巡ごとの値を markdown の表で出す。measurements の runs の各要素は
// 1巡ぶんの、rows と同じ並びの計測値 [ms](読めなかった行は null)。
function printTable(axis, measurements) {
  const { rows, ratioRows = [axis.rows[0]], ratioLabel = ratioRows[0] } = axis;
  const statistic = axis.statistic ?? 'avg';
  const denominatorIndex = rows.indexOf(RATIO_DENOMINATOR_ROW);
  const header = [
    '構図 / 段',
    ...rows.map((row) => `${row} GPU 中央値 [ms]`),
    ...(denominatorIndex < 0 ? [] : [`${ratioLabel} / ${RATIO_DENOMINATOR_ROW}`]),
    ...rows.map((row) => `${row} 巡ごとの ${statistic}`),
  ];
  console.log(`\n| ${header.join(' | ')} |`);
  console.log(`|${' --- |'.repeat(header.length)}`);
  for (const [key, { runs }] of measurements) {
    const valuesByRow = rows.map((_, i) => runs.map((run) => run[i]));
    const medians = valuesByRow.map(medianOf);
    const parts = ratioRows.map((row) => medians[rows.indexOf(row)] ?? null);
    const numerator = parts.every((part) => part !== null)
      ? parts.reduce((sum, part) => sum + part, 0) : null;
    const denominator = medians[denominatorIndex];
    const ratioCells = denominatorIndex < 0 ? [] : [
      formatFixed(numerator === null || denominator === null ? null : numerator / denominator, 3),
    ];
    const cells = [
      key,
      ...medians.map((median) => formatFixed(median, 3)),
      ...ratioCells,
      ...valuesByRow.map((values) => values.map((value) => formatFixed(value, 2)).join(' / ')),
    ];
    console.log(`| ${cells.join(' | ')} |`);
  }
}

async function main() {
  const passes = Math.max(1, Number(process.argv[2] ?? 2));
  const axisName = process.argv[3] ?? 'atmosphere';
  if (!Object.hasOwn(AXES, axisName)) {
    console.error(`${USAGE}\n軸: ${Object.keys(AXES).join(' | ')}`);
    process.exit(1);
  }
  const axis = AXES[axisName];
  const statistic = axis.statistic ?? 'avg';

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

    const measurements = new Map();
    const combos = [];
    for (const framing of axis.framings) for (const variant of axis.variants) combos.push({ framing, variant });
    for (const pass of Array.from(
      { length: passes }, (_, index) => (index % 2 === 0 ? combos : [...combos].reverse()),
    )) {
      for (const { framing, variant } of pass) {
        for (const [option, value] of Object.entries(variant.graphics)) {
          await devTools.evaluate(
            `window.renderLab.setGraphicsOption(${JSON.stringify(option)}, ${JSON.stringify(value)})`,
          );
        }
        const result = await devTools.evaluate(
          `window.renderLab.measure(${JSON.stringify(framing.caseName)}, ${JSON.stringify(framing.angles)})`,
        );
        const key = `${framing.label} / ${variant.label}`;
        const values = axis.rows.map((row) => result.gpuSupported ? result.gpuPassMs[row]?.[statistic] ?? null : null);
        const entry = measurements.get(key) ?? { supported: result.gpuSupported, runs: [] };
        entry.runs.push(values);
        measurements.set(key, entry);
        const rowLog = axis.rows.map((row, i) => `${row}=${formatFixed(values[i], 3)}ms`).join(' ');
        console.log(`measured ${key}  ${rowLog} cpu=${result.cpuRenderMs.avg.toFixed(3)}ms`);
      }
    }

    printTable(axis, measurements);
    console.log(`\ngpuSupported: ${[...measurements.values()].every((m) => m.supported)}`);
  } finally {
    await session.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
