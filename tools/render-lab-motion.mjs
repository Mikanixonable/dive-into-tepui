// 近傍拡散補正のちらつきを、動く絵で撮る。ヘッドレス Chrome で .render-lab/ を開き、場面ごとに、カメラを止めた列・並進させる
// 列・カメラを中心に回転させる列・周回の中心を中心に回転させる列(1 フレームの動きを描画バッファの画素で段に振る)と、光源を
// 動かす列を描いて、フレームごとの全体の絵・補正(最後の拡大の出力)・前のフレームからの補正の差の PNG と、同じ表面の点の
// 補正の揺れの表を書く。差は参照の再投影で同じ表面の点どうしを引いたもの。補正は、そのフレームの 1 パス(single)のほかに、
// そのフレームを位相の列で描き直した平均の列(--columns)も撮れる。書き先は .render-lab-shots/<組の名前>/ で、表は
// report.md、見るページは index.html。
// 先に .render-lab/ を組んでおくこと(webpack --config webpack.render-lab.config.js --mode production)。
//
// 使い方: node tools/render-lab-motion.mjs <組の名前> [--scenes=S,...] [--sequences=Q,...] [--frames=N] [--columns=C,...] [--phases=K]
//   --scenes は場面の名前、--sequences は列の名前(どちらも既定は全部)、--frames は列のフレーム数(既定 16)。--columns は
//   平均の補正の列の名前(seed / representative / seed+representative / raster / all。既定は無し)、--phases はその列が
//   平均する位相の数(既定 32)。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { motionPageHtml } from './render-lab-motion-page.mjs';
import { CAMERA_MOTION_SEQUENCES } from './render-lab-motion-sequences.mjs';
import {
  MOTION_GRAPHICS, PHASE_SOURCES, SCENES, aggregatesOf, evaluateLong, openLabPage, openMotionLab, selectedByName,
} from './render-lab-motion-scenes.mjs';
import { table } from './screen-space-lab.mjs';

const root = path.resolve(import.meta.dirname, '..');
const port = 8775;
const debugPort = 9452;
const USAGE = 'usage: node tools/render-lab-motion.mjs <set-name> [--scenes=S,...] [--sequences=Q,...] [--frames=N] [--columns=C,...] [--phases=K]';

// そのフレームの 1 パスの補正の列の名前(tools/render-lab/motion-sequence.ts の SINGLE_COLUMN)。
const SINGLE_COLUMN = 'single';

// 光源を動かす列の、1 フレームの光源の方位の変化 [deg]。
const LIGHT_STEP_DEG = 0.5;

// 列。frame(k) は k 番目のフレームの、列の最初からのカメラの並進・カメラを中心とする回転・周回の中心を中心とする回転(周回)
// [描画バッファの画素](MotionSequence.moveCamera)と、光源のつまみの変化 [deg]。周回は、周回の中心の点を画面に留めたまま
// 面を見る向きを変える — 同じ画素の並進と同じだけ向きが変わり、側面の写る面積が変わる。
const still = { translation: [0, 0], rotation: [0, 0], orbit: [0, 0], light: 0 };
const SEQUENCES = [
  { name: 'still', frame: () => still },
  ...CAMERA_MOTION_SEQUENCES.map((sequence) => ({
    ...sequence, frame: (k) => ({ ...still, ...sequence.frame(k) }),
  })),
  { name: 'light', lightOnly: true, frame: (k) => ({ ...still, light: k * LIGHT_STEP_DEG }) },
];

// 撮る画像の種類(ファイル名の頭)と、motionFrame の記録の中の場所(JS の式)。columns は補正の列の名前(SINGLE_COLUMN を含む)。
function imageKindsOf(columns) {
  return [
    { id: 'capture', label: '全体', source: 'capture', column: null, fromFrame: 0 },
    ...columns.flatMap((column) => [
      {
        id: `${column}-correction`, label: `補正 ${column}`, source: `columns[${JSON.stringify(column)}].correction`,
        column, fromFrame: 0,
      },
      {
        id: `${column}-difference`, label: `補正の差 ×4 ${column}`, source: `columns[${JSON.stringify(column)}].difference`,
        column, fromFrame: 1,
      },
    ]),
  ];
}

// コマンドラインの引数。
function argumentsOf(argv) {
  const [setName, ...options] = argv;
  if (setName === undefined || !/^[\w.-]+$/.test(setName) || setName === '.' || setName === '..') throw new Error(USAGE);
  const option = (key) => options.find((arg) => arg.startsWith(`--${key}=`))?.slice(key.length + 3);
  const phases = Number(option('phases') ?? 32);
  const columns = (option('columns')?.split(',') ?? []).map((name) => {
    const sources = PHASE_SOURCES[name];
    if (sources === undefined) throw new Error(`unknown column ${name}: one of ${Object.keys(PHASE_SOURCES).join(', ')}`);
    return { name, sequence: { sources, count: phases } };
  });
  return {
    outDir: path.join(root, '.render-lab-shots', setName),
    scenes: selectedByName(option('scenes'), SCENES, 'scene'),
    sequences: selectedByName(option('sequences'), SEQUENCES, 'sequence'),
    frames: Number(option('frames') ?? 16),
    columns,
  };
}

// 列 sequence を場面 scene で frames フレーム撮り、PNG を dir へ書いて、フレームごとの列ごとの要約の並びを返す。
async function shootSequence(devTools, scene, sequence, frames, columns, kinds, dir) {
  const call = (expression) => devTools.evaluate(`window.renderLab.${expression}`);
  await call('resetMotion()');
  const summaries = [];
  try {
    for (let k = 0; k < frames; k++) {
      const { translation, rotation, orbit, light } = sequence.frame(k);
      await call(`moveCamera(${JSON.stringify(translation)}, ${JSON.stringify(rotation)}, ${JSON.stringify(orbit)})`);
      if (scene.light !== null) await call(`moveLight(${JSON.stringify({ [scene.light]: light })})`);
      const columnSummaries = await evaluateLong(devTools, `window.renderLab.motionFrame(${JSON.stringify(columns)})
        .then((record) => {
          window.__motionRecord = record;
          return Object.fromEntries(Object.entries(record.columns).map(([column, { summary }]) => [column, summary]));
        })`, `frame ${k} of ${sequence.name}`);
      // **PNG は 1 枚ずつ受け取る** — CDP の 1 メッセージが約 4 MB を超えると接続が閉じる。
      for (const kind of kinds) {
        const dataUrl = await devTools.evaluate(`window.__motionRecord.${kind.source} ?? null`);
        if (dataUrl === null) continue;
        writeFileSync(path.join(dir, `${kind.id}-${String(k).padStart(3, '0')}.png`),
          Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
      }
      summaries.push(columnSummaries);
    }
  } finally {
    await devTools.evaluate('delete window.__motionRecord');
    await call('resetMotion()');
  }
  return summaries;
}

async function main() {
  const { outDir, scenes, sequences, frames, columns } = argumentsOf(process.argv.slice(2));
  const columnNames = [SINGLE_COLUMN, ...columns.map(({ name }) => name)];
  const kinds = imageKindsOf(columnNames);
  const { session, devTools, fatalEvents } = await openMotionLab({ port, debugPort, profilePrefix: 'tepui-render-lab-motion-' });
  const records = [];
  try {
    rmSync(outDir, { recursive: true, force: true });
    for (const scene of scenes) {
      // 場面ごとにページを開き直す — 1 つのページで撮り続けると、読み戻しの器が溜まって確保に失敗する。
      await openLabPage(session);
      await devTools.evaluate(`window.renderLab.showShot(${JSON.stringify(scene.caseName)}, ${JSON.stringify(scene.shot)},
        ${JSON.stringify(MOTION_GRAPHICS)})`);
      for (const sequence of sequences) {
        if (sequence.lightOnly && scene.light === null) continue;
        const dir = path.join(outDir, scene.name, sequence.name);
        mkdirSync(dir, { recursive: true });
        const summaries = await shootSequence(devTools, scene, sequence, frames, columns, kinds, dir);
        records.push({ scene: scene.name, sequence: sequence.name, frames, summaries });
        console.log(`shot ${scene.name}/${sequence.name}`);
      }
    }
    if (fatalEvents.length > 0) throw new Error(`Page reported errors during shooting:\n${fatalEvents.join('\n')}`);
  } finally {
    await session.close();
  }

  const aggregates = aggregatesOf(records, columnNames);
  const report = [
    `# 補正の揺れ(${new Date().toISOString()}、平均の列 ${columns.map(({ name, sequence }) => `${name}×${sequence.count}`).join(' ') || '無し'})`, '',
    '差は同じ表面の点の補正の隣り合うフレームの差、値は補正そのもの。どちらも q = 露出係数·ΔE/π の成分の RMS で、再投影のある',
    '画素について差のあるフレームを均したもの。分位と最大は画素の成分の |差| の最大の 99% 分位(フレームの平均)と最大。', '',
    ...table(
      ['場面', '列', '補正', '差の数', '再投影の割合', '差 RMS', '値 RMS', '差 / 値', '|差| 99%', '|差| 最大'],
      aggregates.map((a) => [
        a.scene, a.sequence, a.column, a.pairs, a.reprojectedFraction.toFixed(3), a.differenceRms.toExponential(2),
        a.valueRms.toExponential(2), a.ratio.toFixed(3), a.differencePercentile.toExponential(2),
        a.differenceMax.toExponential(2),
      ]),
    ),
  ].join('\n');
  writeFileSync(path.join(outDir, 'report.md'), `${report}\n`);
  writeFileSync(path.join(outDir, 'metrics.json'), JSON.stringify(records, null, 1));
  writeFileSync(path.join(outDir, 'index.html'), motionPageHtml(records, aggregates, kinds));
  console.log(report);
  console.log(`Wrote ${path.relative(root, path.join(outDir, 'index.html'))}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
