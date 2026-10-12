// 近傍拡散補正のちらつきの源ごとの寄与を、静止したカメラで撮る。ヘッドレス Chrome で .render-lab/ を開き、場面ごとに、
// 源(seed・走査の代表・ラスタライズのずれ)の位相の列を 1 つずつ(と全部同時に)回して描き直し、位相ごとの 1 パスと列の平均
// からの偏差、列の平均・画素ごとの標準偏差・最大偏差の PNG、位相を順に時定数ごとの指数移動平均で積んだ列(蓄積の模擬)と
// その隣り合うフレームの差の PNG と、源ごとの揺れの表を書く。書き先は .render-lab-shots/<組の名前>/ で、表は report.md、
// 見るページは index.html。
// 先に .render-lab/ を組んでおくこと(webpack --config webpack.render-lab.config.js --mode production)。
//
// 使い方: node tools/render-lab-jitter-sweep.mjs <組の名前> [--scenes=S,...] [--sweeps=Q,...]
//   --scenes は場面の名前、--sweeps は列の名前(どちらも既定は全部)。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { motionPageHtml } from './render-lab-motion-page.mjs';
import {
  MOTION_GRAPHICS, PHASE_SOURCES, SCENES, aggregatesOf, evaluateLong, openMotionLab, selectedByName,
} from './render-lab-motion-scenes.mjs';
import { table } from './screen-space-lab.mjs';

const root = path.resolve(import.meta.dirname, '..');
const port = 8776;
const debugPort = 9453;
const USAGE = 'usage: node tools/render-lab-jitter-sweep.mjs <set-name> [--scenes=S,...] [--sweeps=Q,...]';

// 位相の列。seed と走査の代表は本番の列(frameJitterAt)を、走査の代表の 1 巡(走査の画素の幅の 2 乗 = 16)の 2 倍まで回す。
// ラスタライズのずれは Halton(2, 3) の 16 点、全部同時は 64 組。
const SWEEPS = [
  { name: 'seed', count: 32 },
  { name: 'representative', count: 32 },
  { name: 'seed+representative', count: 32 },
  { name: 'raster', count: 16 },
  { name: 'all', count: 64 },
].map((sweep) => ({ ...sweep, sources: PHASE_SOURCES[sweep.name] }));

// 蓄積の模擬の時定数 [フレーム](1 は積まない列そのもの)と、そのうち積んだ補正の PNG も残すもの。
const TIME_CONSTANTS = [1, 2, 4, 8, 16];
const IMAGED_TIME_CONSTANTS = [2, 8];

// 撮る画像の種類(ファイル名の頭)と、jitterSweep の記録のフレームの中の場所、要約を引く補正の列の名前。
const IMAGE_KINDS = [
  { id: 'pass', label: '1 パス', source: 'pass', column: 'deviation', fromFrame: 0 },
  { id: 'deviation', label: '平均からの偏差 ×4', source: 'deviation', column: 'deviation', fromFrame: 0 },
  ...IMAGED_TIME_CONSTANTS.flatMap((n) => [
    { id: `accumulated-${n}`, label: `時定数 ${n} の蓄積`, source: `accumulated["${n}"].image`, column: `accumulated-${n}`, fromFrame: 0 },
    { id: `accumulated-${n}-difference`, label: `時定数 ${n} の蓄積の差 ×4`, source: `accumulated["${n}"].difference`, column: `accumulated-${n}`, fromFrame: 1 },
  ]),
];
// 列ごとの静止画(ファイル名)と、記録の中の場所。
const STATIC_KINDS = [
  { file: 'mean.png', label: '平均', source: 'mean' },
  { file: 'std.png', label: '標準偏差 ×4', source: 'std' },
  { file: 'max-deviation.png', label: '最大偏差 ×4', source: 'maxDeviation' },
];

// コマンドラインの引数。
function argumentsOf(argv) {
  const [setName, ...options] = argv;
  if (setName === undefined || !/^[\w.-]+$/.test(setName) || setName === '.' || setName === '..') throw new Error(USAGE);
  const option = (key) => options.find((arg) => arg.startsWith(`--${key}=`))?.slice(key.length + 3);
  return {
    outDir: path.join(root, '.render-lab-shots', setName),
    scenes: selectedByName(option('scenes'), SCENES, 'scene'),
    sweeps: selectedByName(option('sweeps'), SWEEPS, 'sweep'),
  };
}

// 列 sweep を場面 scene で撮り、PNG を dir へ書いて、列の要約とフレームごとの補正の列ごとの差の要約を返す。
async function shootSweep(devTools, sweep, dir) {
  const sequence = { sources: sweep.sources, count: sweep.count };
  const { summary, frames } = await evaluateLong(devTools, `window.renderLab.jitterSweep(${JSON.stringify(sequence)},
    ${JSON.stringify(TIME_CONSTANTS)}, ${JSON.stringify(IMAGED_TIME_CONSTANTS)}).then((record) => {
      window.__sweepRecord = record;
      return {
        summary: record.summary,
        frames: record.frames.map((frame) => ({
          deviation: frame.deviationSummary,
          ...Object.fromEntries(Object.entries(frame.accumulated).map(([n, { summary }]) => ['accumulated-' + n, summary])),
        })),
      };
    })`, `the ${sweep.name} sweep`);
  try {
    // **PNG は 1 枚ずつ受け取る** — CDP の 1 メッセージが約 4 MB を超えると接続が閉じる。
    const pull = async (expression, file) => {
      const dataUrl = await devTools.evaluate(`window.__sweepRecord.${expression} ?? null`);
      if (dataUrl !== null) writeFileSync(path.join(dir, file), Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
    };
    for (const kind of STATIC_KINDS) await pull(kind.source, kind.file);
    for (let k = 0; k < sweep.count; k++) {
      for (const kind of IMAGE_KINDS) await pull(`frames[${k}].${kind.source}`, `${kind.id}-${String(k).padStart(3, '0')}.png`);
    }
  } finally {
    await devTools.evaluate('delete window.__sweepRecord');
  }
  return { summary, frames };
}

async function main() {
  const { outDir, scenes, sweeps } = argumentsOf(process.argv.slice(2));
  const { session, devTools, fatalEvents } = await openMotionLab({ port, debugPort, profilePrefix: 'tepui-render-lab-sweep-' });
  const records = [];
  const statics = [];
  try {
    rmSync(outDir, { recursive: true, force: true });
    for (const scene of scenes) {
      await devTools.evaluate(`window.renderLab.showShot(${JSON.stringify(scene.caseName)}, ${JSON.stringify(scene.shot)},
        ${JSON.stringify(MOTION_GRAPHICS)})`);
      for (const sweep of sweeps) {
        const dir = path.join(outDir, scene.name, sweep.name);
        mkdirSync(dir, { recursive: true });
        const { summary, frames } = await shootSweep(devTools, sweep, dir);
        records.push({ scene: scene.name, sequence: sweep.name, frames: sweep.count, summaries: frames, summary });
        statics.push(...STATIC_KINDS.map(({ file, label }) => ({
          scene: scene.name, sequence: sweep.name, label, file: `${scene.name}/${sweep.name}/${file}`,
        })));
        console.log(`shot ${scene.name}/${sweep.name}`);
      }
    }
    if (fatalEvents.length > 0) throw new Error(`Page reported errors during shooting:\n${fatalEvents.join('\n')}`);
  } finally {
    await session.close();
  }

  const columns = ['deviation', ...TIME_CONSTANTS.map((n) => `accumulated-${n}`)];
  const aggregates = aggregatesOf(records, columns);
  const format = (v) => (v === null ? '—' : v.toFixed(3));
  const report = [
    `# ちらつきの源ごとの寄与(${new Date().toISOString()})`, '',
    '静止したカメラで源の位相の列を回した、面のある画素での q = 露出係数·ΔE/π の成分の値。σ は画素ごとの標準偏差の RMS、√2σ / 平均は',
    '位置関係が動いて位相が変わったときに見込まれる隣り合うフレームの差 / 値。最大偏差 / σ は画素ごとの比の中央値と 99.9% 分位',
    '(白色雑音で約 2、1 回だけの輝点で √N)。平行移動の割合は、格子のずらしの位相ごとの偏差のうち平均の平行移動で説明できる割合。', '',
    ...table(
      ['場面', '列', '位相', '平均 RMS', 'σ RMS', '√2σ / 平均', '最大偏差 RMS', '最大偏差 / σ 中央値', '同 99.9%', '平行移動の割合'],
      records.map(({ scene, sequence, frames, summary: s }) => [
        scene, sequence, frames, s.meanRms.toExponential(2), s.stdRms.toExponential(2),
        (Math.SQRT2 * s.stdRms / s.meanRms).toFixed(3), s.maxDeviationRms.toExponential(2),
        s.hotSpotRatioMedian.toFixed(2), s.hotSpotRatioPercentile.toFixed(2), format(s.translationExplained),
      ]),
    ), '',
    '## 蓄積の模擬', '',
    '位相を順に時定数 N の指数移動平均(新しいフレームの重み 1 / min(k + 1, N))で積んだ列の、隣り合うフレームの差 RMS / 列の平均の RMS',
    '(N = 1 は積まない列)。差のあるフレーム(2 枚目から)の二乗平均。', '',
    ...table(
      ['場面', '列', ...TIME_CONSTANTS.map((n) => `N = ${n}`)],
      records.map(({ scene, sequence }) => [
        scene, sequence,
        ...TIME_CONSTANTS.map((n) => aggregates.find((a) => a.scene === scene && a.sequence === sequence && a.column === `accumulated-${n}`)
          ?.ratio.toFixed(3) ?? '—'),
      ]),
    ),
  ].join('\n');
  writeFileSync(path.join(outDir, 'report.md'), `${report}\n`);
  writeFileSync(path.join(outDir, 'metrics.json'), JSON.stringify(records, null, 1));
  writeFileSync(path.join(outDir, 'index.html'), motionPageHtml(records, aggregates, IMAGE_KINDS, statics, 'ちらつきの源ごとの寄与'));
  console.log(report);
  console.log(`Wrote ${path.relative(root, path.join(outDir, 'index.html'))}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
