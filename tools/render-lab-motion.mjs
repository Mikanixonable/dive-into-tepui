// 近傍拡散補正のちらつきを、動く絵で撮る。ヘッドレス Chrome で .render-lab/ を開き、場面ごとに、カメラを止めた列・並進させる
// 列・カメラを中心に回転させる列・周回の中心を中心に回転させる列(1 フレームの動きを描画バッファの画素で段に振る)と、光源を
// 動かす列を描いて、フレームごとの全体の絵・補正(最後の拡大の出力)・前のフレームからの補正の差の PNG と、同じ表面の点の
// 補正の揺れの表を書く。差は参照の再投影で同じ表面の点どうしを引いたもの。書き先は .render-lab-shots/<組の名前>/ で、表は
// report.md、見るページは index.html。
// 先に .render-lab/ を組んでおくこと(webpack --config webpack.render-lab.config.js --mode production)。
//
// 使い方: node tools/render-lab-motion.mjs <組の名前> [--scenes=S,...] [--sequences=Q,...] [--frames=N] [--average=K]
//   --scenes は場面の名前、--sequences は列の名前(どちらも既定は全部)、--frames は列のフレーム数(既定 16)。--average を
//   渡すと、各フレームの G バッファのまま補正を seed K 個で描き直した平均の列も撮る。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';
import { motionPageHtml } from './render-lab-motion-page.mjs';
import { seedOf, table } from './screen-space-lab.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.render-lab');
const port = 8775;
const debugPort = 9452;
const USAGE = 'usage: node tools/render-lab-motion.mjs <set-name> [--scenes=S,...] [--sequences=Q,...] [--frames=N] [--average=K]';

// 撮る描画設定。映り込みの追跡は GPU によってはフレームごとに決定的でないので切る。レンズ効果は明るい面の光を、
// アンチエイリアス(値 0 はなし)は縁を広げて補正の揺れに混ぜるので切る。補正は照り返しまで描く方式で撮る。
const MOTION_GRAPHICS = { screenSpaceSpecular: false, lens: false, antialias: 0, screenSpaceDiffuse: 2 };

// 場面。light は光源を動かす列で回す観察の向きのつまみ(光源が自己発光の物だけの場面では null)。
const SCENES = [
  { name: 'bay-earth-open', caseName: 'bay', shot: 'bay-earth-open', light: 'earthAzimuthDeg' },
  { name: 'cornell-box', caseName: 'cornell-box', shot: 'cornell-box', light: 'sunAzimuthDeg' },
  { name: 'bay-dark', caseName: 'bay', shot: 'bay-dark', light: null },
];

// カメラの 1 フレームの動き [描画バッファの画素]。ラスタライズが変わる画素の 1 未満から、走査のダウンサンプリングが
// 一巡する走査の画素の幅(1/4 の解像度で 4 px)を超えるまで。
const SPEEDS_PX = [0.25, 0.5, 1, 2, 4, 8];
// 動きの向き(x は右、y は上)。画素の格子に沿う向きは走査の格子の決まった位相だけを踏むので、横から 30° 傾ける。
const DIRECTION = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];
// 光源を動かす列の、1 フレームの光源の方位の変化 [deg]。
const LIGHT_STEP_DEG = 0.5;

// 列。frame(k) は k 番目のフレームの、列の最初からのカメラの並進・カメラを中心とする回転・周回の中心を中心とする回転(周回)
// [描画バッファの画素](MotionSequence.moveCamera)と、光源のつまみの変化 [deg]。周回は、周回の中心の点を画面に留めたまま
// 面を見る向きを変える — 同じ画素の並進と同じだけ向きが変わり、側面の写る面積が変わる。
const offset = (k, speed) => DIRECTION.map((v) => k * speed * v);
const still = { translation: [0, 0], rotation: [0, 0], orbit: [0, 0], light: 0 };
const SEQUENCES = [
  { name: 'still', frame: () => still },
  ...SPEEDS_PX.map((speed) => ({ name: `translate-${speed}px`, frame: (k) => ({ ...still, translation: offset(k, speed) }) })),
  ...SPEEDS_PX.map((speed) => ({ name: `rotate-${speed}px`, frame: (k) => ({ ...still, rotation: offset(k, speed) }) })),
  ...SPEEDS_PX.map((speed) => ({ name: `orbit-${speed}px`, frame: (k) => ({ ...still, orbit: offset(k, speed) }) })),
  { name: 'light', lightOnly: true, frame: (k) => ({ ...still, light: k * LIGHT_STEP_DEG }) },
];

// 撮る画像の種類(ファイル名の頭)と、motionFrame の記録の中の場所。
const IMAGE_KINDS = [
  { id: 'capture', label: '全体', source: 'capture' },
  { id: 'single-correction', label: '補正', source: 'columns.single.correction' },
  { id: 'single-difference', label: '補正の差 ×4', source: 'columns.single.difference' },
  { id: 'averaged-correction', label: '平均の補正', source: 'columns.averaged.correction' },
  { id: 'averaged-difference', label: '平均の補正の差 ×4', source: 'columns.averaged.difference' },
];

// コマンドラインの引数。
function argumentsOf(argv) {
  const [setName, ...options] = argv;
  if (setName === undefined || !/^[\w.-]+$/.test(setName) || setName === '.' || setName === '..') throw new Error(USAGE);
  const option = (key) => options.find((arg) => arg.startsWith(`--${key}=`))?.slice(key.length + 3);
  const listOf = (key, all) => {
    const names = option(key)?.split(',') ?? all.map(({ name }) => name);
    for (const name of names) if (!all.some((item) => item.name === name)) throw new Error(`unknown ${key} ${name}`);
    return all.filter(({ name }) => names.includes(name));
  };
  return {
    outDir: path.join(root, '.render-lab-shots', setName),
    scenes: listOf('scenes', SCENES),
    sequences: listOf('sequences', SEQUENCES),
    frames: Number(option('frames') ?? 16),
    averaged: Number(option('average') ?? 0),
  };
}

// 列 sequence を場面 scene で frames フレーム撮り、PNG を dir へ書いて、フレームごとの列ごとの要約の並びを返す。
async function shootSequence(devTools, scene, sequence, frames, averagedSeeds, dir) {
  const call = (expression) => devTools.evaluate(`window.renderLab.${expression}`);
  const base = scene.light === null ? null : (await call('viewAngles()'))[scene.light];
  await call('resetMotion()');
  const summaries = [];
  try {
    for (let k = 0; k < frames; k++) {
      const { translation, rotation, orbit, light } = sequence.frame(k);
      await call(`moveCamera(${JSON.stringify(translation)}, ${JSON.stringify(rotation)}, ${JSON.stringify(orbit)})`);
      if (base !== null) await call(`setView(${JSON.stringify({ [scene.light]: base + light })})`);
      // 平均の列を撮ると seed は列の最後のものになるので、フレームごとに本番の seed へ戻す。
      await call('setScanSeed(0, 0)');
      const columnSummaries = await devTools.evaluate(`window.renderLab.motionFrame(${JSON.stringify(averagedSeeds)})
        .then((record) => {
          window.__motionRecord = record;
          return Object.fromEntries(Object.entries(record.columns).map(([column, { summary }]) => [column, summary]));
        })`);
      // **PNG は 1 枚ずつ受け取る** — CDP の 1 メッセージが約 4 MB を超えると接続が閉じる。
      for (const kind of IMAGE_KINDS) {
        const dataUrl = await devTools.evaluate(`window.__motionRecord.${kind.source.replaceAll('.', '?.')} ?? null`);
        if (dataUrl === null) continue;
        writeFileSync(path.join(dir, `${kind.id}-${String(k).padStart(3, '0')}.png`),
          Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
      }
      summaries.push(columnSummaries);
    }
  } finally {
    await devTools.evaluate('delete window.__motionRecord');
    await call('resetMotion()');
    if (base !== null) await call(`setView(${JSON.stringify({ [scene.light]: base })})`);
  }
  return summaries;
}

// 撮影の記録 records の、場面と列と補正の列 columns ごとの、差のあるフレームを均した揺れ。RMS は二乗の平均の平方根、
// 分位はフレームの平均、最大はフレームの最大。差のあるフレームが無い組は含めない。
function aggregatesOf(records, columns) {
  return records.flatMap(({ scene, sequence, summaries }) => columns.flatMap((column) => {
    const pairs = summaries.map((s) => s[column]).filter((s) => s !== null && s !== undefined);
    if (pairs.length === 0) return [];
    const mean = (values) => values.reduce((sum, v) => sum + v, 0) / pairs.length;
    const differenceRms = Math.sqrt(mean(pairs.map((s) => s.differenceRms ** 2)));
    const valueRms = Math.sqrt(mean(pairs.map((s) => s.valueRms ** 2)));
    return [{
      scene, sequence, column, pairs: pairs.length,
      reprojectedFraction: mean(pairs.map((s) => s.reprojectedFraction)),
      differenceRms, valueRms, ratio: differenceRms / valueRms,
      differencePercentile: mean(pairs.map((s) => s.differencePercentile)),
      differenceMax: Math.max(...pairs.map((s) => s.differenceMax)),
    }];
  }));
}

async function main() {
  const { outDir, scenes, sequences, frames, averaged } = argumentsOf(process.argv.slice(2));
  const averagedSeeds = averaged > 0 ? Array.from({ length: averaged }, (_, k) => seedOf(k)) : null;
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-render-lab-motion-', onEvent,
  });
  const records = [];
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    await waitFor(devTools,
      "(document.getElementById('error')?.textContent || typeof window.renderLab?.motionFrame === 'function')",
      'the render lab to initialise');
    const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
    if (failure) throw new Error(`Render lab failed to initialise: ${failure}`);

    rmSync(outDir, { recursive: true, force: true });
    for (const scene of scenes) {
      await devTools.evaluate(`window.renderLab.showShot(${JSON.stringify(scene.caseName)}, ${JSON.stringify(scene.shot)},
        ${JSON.stringify(MOTION_GRAPHICS)})`);
      for (const sequence of sequences) {
        if (sequence.lightOnly && scene.light === null) continue;
        const dir = path.join(outDir, scene.name, sequence.name);
        mkdirSync(dir, { recursive: true });
        const summaries = await shootSequence(devTools, scene, sequence, frames, averagedSeeds, dir);
        records.push({ scene: scene.name, sequence: sequence.name, frames, summaries });
        console.log(`shot ${scene.name}/${sequence.name}`);
      }
    }
    if (fatalEvents.length > 0) throw new Error(`Page reported errors during shooting:\n${fatalEvents.join('\n')}`);
  } finally {
    await session.close();
  }

  const aggregates = aggregatesOf(records, averagedSeeds === null ? ['single'] : ['single', 'averaged']);
  const report = [
    `# 補正の揺れ(${new Date().toISOString()}、seed の平均 ${averaged})`, '',
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
  const kinds = IMAGE_KINDS.filter(({ id }) => averagedSeeds !== null || !id.startsWith('averaged'));
  writeFileSync(path.join(outDir, 'index.html'), motionPageHtml(records, aggregates, kinds));
  console.log(report);
  console.log(`Wrote ${path.relative(root, path.join(outDir, 'index.html'))}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
