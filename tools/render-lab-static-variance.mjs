// 静止した場面(d = 0)の近傍拡散補正の揺れを、スライス数 S と履歴の上限 s の組ごとに量る。ヘッドレス Chrome で .render-lab/ を
// 開き、場面と組ごとにページを開き直して window.renderLab.staticVariance を呼び、組ごとの JSON と標準偏差の地図の PNG、白色雑音の
// 模型(1 パスの分散 σ₁²/S、蓄積の後の時間方向の分散 σ_S²/(2s − 1)、隣り合う差の分散 2σ_S²/(s(2s − 1)))で割った列を含む表を
// .render-lab-shots/<組の名前>/ へ書く(表は summary.md と標準出力)。
// 先に .render-lab/ を組んでおくこと(webpack --config webpack.render-lab.config.js --mode production)。
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SCENES, MOTION_GRAPHICS, evaluateLong, openLabPage, openMotionLab } from './render-lab-motion-scenes.mjs';
import { table } from './screen-space-lab.mjs';

const root = path.resolve(import.meta.dirname, '..');
const port = 8777;
const debugPort = 9454;
// 既定の組。1x2 は S = 1 の 1 パス σ₁ を読むためのもの(s = 1 ではジッターが止まるので s = 2 で描く)で、場面ごとに最初に撮り、
// その σ₁ で同じ場面のほかの組の地図の倍率を揃える。残りは S·s = 64 と 128 の群。
const DEFAULT_COMBOS = [
  { sliceCount: 1, historyCap: 2 },
  { sliceCount: 2, historyCap: 32 }, { sliceCount: 4, historyCap: 16 }, { sliceCount: 8, historyCap: 8 },
  { sliceCount: 2, historyCap: 64 }, { sliceCount: 4, historyCap: 32 }, { sliceCount: 8, historyCap: 16 },
];
const DEFAULT_SCENES = ['cornell-box', 'bay-earth-open'];
const USAGE = 'usage: node tools/render-lab-static-variance.mjs <set-name> [--scenes=name,...] [--combos=Sxs,...] [--frames=512] [--scale=value]';
// 表で、平均の RMS に対する比も添える量(画素ごとの比の分位は比なので添えない)。
const RMS_METRICS = [
  'passMeanRms', 'passStdRms', 'accumulatedStdRms', 'passDifferenceRms', 'accumulatedDifferenceRms', 'emaErrorRms', 'emaErrorMax',
];
const RATIO_METRICS = ['stdRatioMedian', 'stdRatioPercentile99', 'differenceRatioMedian', 'differenceRatioPercentile99'];

// コマンドライン引数から、組の名前・場面・組・読むフレームの数 K・地図の倍率(省けば 1x2 の σ₁ から)・書き先を取る。
function argumentsOf(argv) {
  const [setName, ...options] = argv;
  if (setName === undefined || !/^[\w.-]+$/.test(setName) || setName === '.' || setName === '..') throw new Error(USAGE);
  const option = (key) => options.find((arg) => arg.startsWith(`--${key}=`))?.slice(key.length + 3);
  const sceneNames = option('scenes')?.split(',') ?? DEFAULT_SCENES;
  for (const name of sceneNames) if (!SCENES.some((scene) => scene.name === name)) throw new Error(`unknown scene ${name}`);
  const scenes = SCENES.filter((scene) => sceneNames.includes(scene.name));
  const combos = option('combos') === undefined ? DEFAULT_COMBOS : option('combos').split(',').map((entry) => {
    const match = /^(\d+)x(\d+)$/.exec(entry);
    if (!match) throw new Error(`invalid combo ${entry}; expected Sxs`);
    return { sliceCount: Number(match[1]), historyCap: Number(match[2]) };
  });
  if (combos.length === 0 || combos.some(({ sliceCount, historyCap }) => sliceCount < 1 || historyCap < 1)) {
    throw new Error('combos must be positive integers');
  }
  const frames = Number(option('frames') ?? 512);
  if (!Number.isInteger(frames) || frames < 2) throw new Error('--frames must be an integer greater than 1');
  const scale = option('scale') === undefined ? null : Number(option('scale'));
  if (scale !== null && (!Number.isFinite(scale) || scale < 0)) throw new Error('--scale must be finite and nonnegative');
  if (scale === null && !combos.some(isReference)) throw new Error('--scale is required when --combos omits 1x2');
  return { setName, scenes, combos, frames, scale, outDir: path.join(root, '.render-lab-shots', setName) };
}

// σ₁ を読む組か。
function isReference({ sliceCount, historyCap }) { return sliceCount === 1 && historyCap === 2; }

function comboName({ sliceCount, historyCap }) { return `${sliceCount}x${historyCap}`; }

// 開き直したページで場面 scene を組 combo の描画設定で置き、frames フレームを量る。pngScale は地図の倍率(null なら組の 1 パスの σ)。
async function shoot(devTools, scene, combo, frames, pngScale) {
  const graphics = { ...MOTION_GRAPHICS, screenSpaceSliceCount: combo.sliceCount, screenSpaceHistoryCap: combo.historyCap };
  await devTools.evaluate(`window.renderLab.showShot(${JSON.stringify(scene.caseName)}, ${JSON.stringify(scene.shot)}, ${JSON.stringify(graphics)})`);
  const summary = await evaluateLong(devTools, `window.renderLab.staticVariance(${combo.sliceCount}, ${combo.historyCap}, ${frames},
    ${JSON.stringify(pngScale)}).then((record) => {
      window.__staticVarianceRecord = record;
      return record.summary;
    })`, `${scene.name}/${comboName(combo)}`);
  // PNG は 1 枚ずつ受け取る(CDP の 1 メッセージの大きさの上限)。
  const images = {};
  for (const [kind, property] of [['accumulatedStd', 'accumulatedStdPng'], ['passStd', 'passStdPng']]) {
    images[kind] = await devTools.evaluate(`window.__staticVarianceRecord.${property}`);
  }
  await devTools.evaluate('delete window.__staticVarianceRecord');
  return { scene: scene.name, ...combo, summary, images };
}

// 記録 1 つの JSON と地図の PNG を書く。
function saveRecord(outDir, record) {
  const directory = path.join(outDir, record.scene);
  mkdirSync(directory, { recursive: true });
  const name = comboName(record);
  writeFileSync(path.join(directory, `${name}.json`), `${JSON.stringify({
    scene: record.scene, sliceCount: record.sliceCount, historyCap: record.historyCap, ...record.summary,
  }, null, 2)}\n`);
  for (const [kind, dataUrl] of Object.entries(record.images)) {
    writeFileSync(path.join(directory, `${name}-${kind}.png`), Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
  }
}

const number = (value) => (Number.isFinite(value) ? value.toExponential(4) : String(value));

// 場面ごとの表(組の数値・模型で割った列)と、S ごとの 128 の群 / 64 の群の比の表。
function summaryMarkdown(records) {
  const sections = [
    '# 静止した場面の時間方向の揺れ', '',
    `読んだフレームの数 K = ${records[0]?.summary.frames ?? '—'}。値は面のある画素の q = 露出係数·ΔE/π で、RMS は画素と rgb の成分にわたる。`,
    '地図の表示値は q の標準偏差 × 倍率(場面ごとに 1x2 の 1 パスの σ₁ の 4 倍を 1 にする)。', '',
  ];
  for (const scene of [...new Set(records.map((record) => record.scene))]) {
    const rows = records.filter((record) => record.scene === scene);
    const sigma1 = rows.find(isReference)?.summary.passStdRms ?? Number.NaN;
    sections.push(`## ${scene}`, '');
    const columns = ['S×s', '面画素', 'K', 'meanRms', ...RMS_METRICS.flatMap((metric) => [metric, `${metric}/meanRms`]), ...RATIO_METRICS,
      'passStd·√S/σ₁', 'accStd·√(S(2s−1))/σ₁', 'accDiff·√(Ss(2s−1)/2)/σ₁', '時間 s'];
    sections.push(...table(columns, rows.map(({ sliceCount: S, historyCap: s, summary }) => [
      `${S}x${s}`, summary.surfaceCount, summary.frames, number(summary.meanRms),
      ...RMS_METRICS.flatMap((metric) => [number(summary[metric]), number(summary[metric] / summary.meanRms)]),
      ...RATIO_METRICS.map((metric) => number(summary[metric])),
      number(summary.passStdRms * Math.sqrt(S) / sigma1),
      number(summary.accumulatedStdRms * Math.sqrt(S * (2 * s - 1)) / sigma1),
      number(summary.accumulatedDifferenceRms * Math.sqrt(S * s * (2 * s - 1) / 2) / sigma1),
      (summary.elapsedMs / 1000).toFixed(1),
    ])), '');

    // 群の比。模型の予測は時間方向の分散が (2s₆₄ − 1)/(2s₁₂₈ − 1)、隣り合う差の分散が s₆₄(2s₆₄ − 1)/(s₁₂₈(2s₁₂₈ − 1))。
    const group = (product) => rows.filter((record) => record.sliceCount * record.historyCap === product);
    const spread = (members) => {
      const stds = members.map((record) => record.summary.accumulatedStdRms);
      return stds.length === 0 ? Number.NaN : Math.max(...stds) / Math.min(...stds);
    };
    sections.push(`群の中の accumulatedStdRms の最大 / 最小: 64 の群 ${number(spread(group(64)))}、128 の群 ${number(spread(group(128)))}`, '');
    sections.push(...table(['S', 'σ_t² の比(実測 / 予測)', '差² の比(実測 / 予測)'], [2, 4, 8].map((S) => {
      const low = group(64).find((record) => record.sliceCount === S);
      const high = group(128).find((record) => record.sliceCount === S);
      if (low === undefined || high === undefined) return [S, '—', '—'];
      const stdRatio = (high.summary.accumulatedStdRms / low.summary.accumulatedStdRms) ** 2;
      const differenceRatio = (high.summary.accumulatedDifferenceRms / low.summary.accumulatedDifferenceRms) ** 2;
      const stdPrediction = (2 * low.historyCap - 1) / (2 * high.historyCap - 1);
      const differencePrediction = low.historyCap * (2 * low.historyCap - 1) / (high.historyCap * (2 * high.historyCap - 1));
      return [S, `${number(stdRatio)} / ${number(stdPrediction)}`, `${number(differenceRatio)} / ${number(differencePrediction)}`];
    })), '');
  }
  return `${sections.join('\n')}\n`;
}

async function main() {
  const { setName, scenes, combos, frames, scale, outDir } = argumentsOf(process.argv.slice(2));
  mkdirSync(outDir, { recursive: true });
  const { session, devTools, fatalEvents } = await openMotionLab({ port, debugPort, profilePrefix: 'tepui-static-variance-' });
  const records = [];
  try {
    for (const scene of scenes) {
      // σ₁ を読む組を先に撮り、その倍率を同じ場面のほかの組へ渡す。
      const ordered = [...combos.filter(isReference), ...combos.filter((combo) => !isReference(combo))];
      let pngScale = scale;
      for (const combo of ordered) {
        // 読み戻しの器が溜まらないよう、組ごとにページを開き直す。
        await openLabPage(session);
        const record = await shoot(devTools, scene, combo, frames, pngScale);
        pngScale ??= record.summary.pngScale;
        records.push(record);
        saveRecord(outDir, record);
        console.log(`shot ${scene.name}/${comboName(combo)}: ${(record.summary.elapsedMs / 1000).toFixed(1)} s`);
      }
    }
    if (fatalEvents.length > 0) throw new Error(`Page reported errors during shooting:\n${fatalEvents.join('\n')}`);
  } finally {
    await session.close();
  }
  const report = summaryMarkdown(records);
  writeFileSync(path.join(outDir, 'summary.md'), report);
  // 画像は PNG で書いたので、まとめの JSON には入れない。
  const summaries = records.map(({ scene, sliceCount, historyCap, summary }) => ({ scene, sliceCount, historyCap, summary }));
  writeFileSync(path.join(outDir, `${setName}.json`), `${JSON.stringify(summaries, null, 2)}\n`);
  console.log(report);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
