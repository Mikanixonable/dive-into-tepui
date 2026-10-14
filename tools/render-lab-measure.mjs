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

function poolMedianOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function poolStandardDeviation(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

async function measurePoolMotion(rounds, buildDirs) {
  if (buildDirs.length !== 3) throw new Error('pool-motion requires three build directories');
  const labels = ['(0) 手順4前 669abbfa1', '(1) 4-3 revert 704bbe234', '(2) 作業ツリー 4-4'];
  const sessions = [];
  try {
    for (const [index, buildDir] of buildDirs.entries()) {
      const session = await openChromeSession({
        serveDir: path.resolve(buildDir), port: port + index, debugPort: debugPort + index,
        profilePrefix: `tepui-render-lab-pool-${index}-`,
      });
      sessions.push(session);
      await session.devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
      for (let wait = 0; wait < 600; wait++) {
        if (await session.devTools.evaluate('typeof window.renderLab?.measureCurrent === "function"')) break;
        await sleep(200);
      }
      await session.devTools.evaluate(
        `window.renderLab.showShot("casing-pool", "casing-pool", `
        + `${JSON.stringify({ screenSpaceOcclusion: true, screenSpaceIndirect: true })})`,
      );
      for (const [key, value] of Object.entries({ casingCount: 260, debrisCount: 600, casingOrder: 'stable', motion: false })) {
        await session.devTools.evaluate(`window.renderLab.setCaseValue(${JSON.stringify(key)}, ${JSON.stringify(value)})`);
      }
    }

    const samples = sessions.map(() => []);
    for (let round = 0; round < rounds; round++) {
      const order = round % 2 === 0 ? [0, 1, 2] : [2, 1, 0];
      for (const index of order) {
        const devTools = sessions[index].devTools;
        const result = await devTools.evaluate('window.renderLab.measureCurrent(6, 30)');
        const cpu = await devTools.evaluate('window.renderLab.measurePoolRebuild(300)');
        samples[index].push({
          gbuffer: result.gpuPassMs['Gバッファ'].p50,
          cloud: result.gpuPassMs['表面雲'].p50,
          material: result.gpuPassMs['マテリアル'].p50,
          poolCpu: poolMedianOf(cpu.poolRebuildMs),
          previousCpu: poolMedianOf(cpu.previousMatricesMs),
        });
        console.log(`round ${round + 1}/${rounds} ${labels[index]}: G=${samples[index].at(-1).gbuffer.toFixed(3)} ms`);
      }
    }

    const summaries = samples.map((runs) => Object.fromEntries(
      ['gbuffer', 'cloud', 'material', 'poolCpu', 'previousCpu'].map((key) => [key, poolMedianOf(runs.map((run) => run[key]))]),
    ));
    const poolCpuTotals = samples.map((runs, index) => poolMedianOf(runs.map((run) =>
      run.poolCpu + (index === 2 ? run.previousCpu : 0))));
    const poolCpuIncrement = poolCpuTotals[2] - poolCpuTotals[1];
    const deltaByRound = samples[2].map((run, index) => run.gbuffer - samples[1][index].gbuffer);
    const delta = poolMedianOf(deltaByRound);
    const deltaSe = poolStandardDeviation(deltaByRound) / Math.sqrt(rounds);
    const rows = ['gbuffer', 'cloud', 'material'].map((key) => `| ${key} GPU p50 [ms] | ${summaries[0][key].toFixed(3)} | ${summaries[1][key].toFixed(3)} | ${summaries[2][key].toFixed(3)} |`);
    rows.push(`| (2) − (1) G バッファ増分 [ms] | — | — | ${delta.toFixed(3)} ± ${deltaSe.toFixed(3)} SE |`);
    rows.push(`| (2) − (1) / (2) マテリアル | — | — | ${(delta / summaries[2].material).toFixed(3)} |`);
    rows.push(`| pool begin/push/end CPU p50 [ms] | ${summaries[0].poolCpu.toFixed(9)} | ${summaries[1].poolCpu.toFixed(9)} | ${summaries[2].poolCpu.toFixed(9)} |`);
    rows.push(`| writePoolMatrices CPU p50 [ms] | 0 | 0 | ${summaries[2].previousCpu.toFixed(9)} |`);
    rows.push(`| pool積み直し+前行列 CPU p50 [ms] | ${poolCpuTotals.map((value) => value.toFixed(9)).join(' | ')} |`);
    rows.push(`| (2)−(1) CPU 増分 [ms] | — | — | ${poolCpuIncrement.toFixed(9)} |`);
    rows.push(`| 今行列 / 前行列送信 [B/frame] | 285440 / 0 | 285440 / 0 | 285440 / 55040 |`);
    console.log('\n| 測定 | (0) | (1) | (2) |\n| --- | ---: | ---: | ---: |\n' + rows.join('\n'));
    for (const key of ['gbuffer', 'cloud', 'material', 'poolCpu', 'previousCpu']) {
      console.log(`${key} per-build range/stddev [ms]: ${samples.map((runs) => {
        const values = runs.map((run) => run[key]);
        return `${Math.min(...values).toFixed(3)}–${Math.max(...values).toFixed(3)} / ${poolStandardDeviation(values).toFixed(3)}`;
      }).join(' ; ')}`);
    }
    const materialDeltaByRound = samples[2].map((run, index) => run.material - samples[1][index].material);
    const materialDelta = poolMedianOf(materialDeltaByRound);
    console.log(`material increment (2)-(1) per round median/SE [ms]: ${materialDelta.toFixed(3)} ± ${(poolStandardDeviation(materialDeltaByRound) / Math.sqrt(rounds)).toFixed(3)}`);
    console.log(`measurement rounds (${rounds}) order: alternate 0→1→2 / 2→1→0; per build G/material [ms]: ${samples.map((runs) => runs.map((run) => `${run.gbuffer.toFixed(3)}/${run.material.toFixed(3)}`).join(',')).join(' ; ')}`);
    console.log(`G increment target: ${delta <= summaries[2].material * 0.05}; CPU increment target: ${poolCpuIncrement <= 0.1}`);
  } finally {
    await Promise.all(sessions.map((session) => session.close()));
  }
}

// 測る軸。framings の angles はケース既定の観察の向きへ重ねる。variants の graphics は setGraphicsOption へ
// 渡す描画設定の差分で、差分に無い鍵は直前に測った段の値のまま残る。rows は result.gpuPassMs の行名
// (src/render/gpu-timings.ts の GPU_PASS_LABELS)。
const AXES = {
  // 値は src/render/graphics-settings.ts の atmosphere と atmosphereSampleBudget(低・中・高はプリセットの標本数)。
  atmosphere: {
    framings: [
      { label: 'earth', caseName: 'earth', angles: {} },
      { label: 'earth-mars', caseName: 'earth-mars', angles: {} },
      { label: 'earth-mars d=-2', caseName: 'earth-mars', angles: { cameraDistanceLog: -2 } },
    ],
    variants: [
      { label: 'オフ', graphics: { atmosphere: false } },
      { label: '低', graphics: { atmosphere: true, atmosphereSampleBudget: 8 } },
      { label: '中', graphics: { atmosphere: true, atmosphereSampleBudget: 16 } },
      { label: '高', graphics: { atmosphere: true, atmosphereSampleBudget: 24 } },
    ],
    rows: ['大気'],
  },
  // 値は src/render/graphics-settings.ts の screenSpaceOcclusion / screenSpaceIndirect と、screenSpaceSliceCount /
  // screenSpaceStepCount(低・中・高はプリセットの値)。有無はノブより先に書く — オフの分野へノブを書くと分野が
  // 点き、直前の段の値が残らない。
  'screen-space': {
    statistic: 'p50',
    framings: [{ label: 'bay', caseName: 'bay', angles: {} }],
    variants: [
      { label: 'オフ', graphics: { screenSpaceOcclusion: false } },
      {
        label: '遮蔽・低',
        graphics: {
          screenSpaceOcclusion: true, screenSpaceIndirect: false, screenSpaceSliceCount: 2, screenSpaceStepCount: 3,
        },
      },
      {
        label: '遮蔽・中',
        graphics: {
          screenSpaceOcclusion: true, screenSpaceIndirect: false, screenSpaceSliceCount: 4, screenSpaceStepCount: 5,
        },
      },
      {
        label: '遮蔽・高',
        graphics: {
          screenSpaceOcclusion: true, screenSpaceIndirect: false, screenSpaceSliceCount: 4, screenSpaceStepCount: 6,
        },
      },
      {
        label: '遮蔽と照り返し・低',
        graphics: {
          screenSpaceOcclusion: true, screenSpaceIndirect: true, screenSpaceSliceCount: 2, screenSpaceStepCount: 3,
        },
      },
      {
        label: '遮蔽と照り返し・中',
        graphics: {
          screenSpaceOcclusion: true, screenSpaceIndirect: true, screenSpaceSliceCount: 4, screenSpaceStepCount: 5,
        },
      },
      {
        label: '遮蔽と照り返し・高',
        graphics: {
          screenSpaceOcclusion: true, screenSpaceIndirect: true, screenSpaceSliceCount: 4, screenSpaceStepCount: 6,
        },
      },
    ],
    rows: [
      '近傍拡散写しと源', '近傍拡散走査', '近傍拡散代表縮小', '近傍拡散帯縮小', '近傍拡散合流', '近傍拡散拡大', 'マテリアル',
    ],
    ratioRows: ['近傍拡散写しと源', '近傍拡散走査', '近傍拡散代表縮小', '近傍拡散帯縮小', '近傍拡散合流', '近傍拡散拡大'],
    ratioLabel: '近傍拡散合計',
  },
  // 値は src/render/graphics-settings.ts の screenSpaceSpecular と、screenSpaceSpecularScale / screenSpaceSpecularStepCount
  // (低・中・高はプリセットの値)/ screenSpaceSpecularDenoise。有無はノブより先に書く。構図は映り込みの出る金属面 —
  // 材質の格子の既定の向き(leo-metal)と、荷室の金属の板(bay-metal。向きは tools/render-lab/bay-cases.ts の
  // METAL_VIEW と同じ)。
  reflection: {
    statistic: 'p50',
    framings: [
      { label: 'leo-metal', caseName: 'materials', angles: {} },
      {
        label: 'bay-metal',
        caseName: 'bay',
        angles: {
          cameraAzimuthDeg: 30, cameraElevationDeg: 20, cameraDistanceLog: Math.log10(6.5 / 11.6),
          earthAzimuthDeg: 130, earthElevationDeg: -12,
        },
      },
    ],
    variants: [
      { label: 'オフ', graphics: { screenSpaceSpecular: false } },
      {
        label: '低',
        graphics: {
          screenSpaceSpecular: true, screenSpaceSpecularScale: 0.5, screenSpaceSpecularStepCount: 16,
          screenSpaceSpecularDenoise: true,
        },
      },
      {
        label: '中',
        graphics: {
          screenSpaceSpecular: true, screenSpaceSpecularScale: 0.5, screenSpaceSpecularStepCount: 32,
          screenSpaceSpecularDenoise: true,
        },
      },
      {
        label: '高',
        graphics: {
          screenSpaceSpecular: true, screenSpaceSpecularScale: 1, screenSpaceSpecularStepCount: 48,
          screenSpaceSpecularDenoise: true,
        },
      },
      {
        label: '中・ぼかしオフ',
        graphics: {
          screenSpaceSpecular: true, screenSpaceSpecularScale: 0.5, screenSpaceSpecularStepCount: 32,
          screenSpaceSpecularDenoise: false,
        },
      },
    ],
    rows: ['ライティング', 'マテリアル', '映り込み', '映り込みの均し', '陰影の合成'],
    ratioRows: ['映り込み', '映り込みの均し', '陰影の合成'],
    ratioLabel: '映り込み合計',
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
  if (axisName === 'pool-motion') {
    await measurePoolMotion(passes, process.argv.slice(4));
    return;
  }
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
