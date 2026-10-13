// CPU レイの動き参照を、ケース・カメラの列・座標・プールの積み順で撮る。
// 先に npx webpack --config webpack.render-lab.config.js --mode production を実行する。
// 使い方: node tools/render-lab-motion-vectors.mjs <組の名前> [--scenes=...] [--sequences=...] [--frames=N]
//   [--coordinates=world,floating] [--orders=stable,shuffle,churn]
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { motionVectorPageHtml } from './render-lab-motion-page.mjs';
import {
  CAMERA_MOTION_SEQUENCES, MOTION_SPEEDS_PX, motionOffsetPx,
} from './render-lab-motion-sequences.mjs';
import {
  MOTION_GRAPHICS, MOTION_VECTOR_SCENES, evaluateLong, openLabPage, openMotionLab, selectedByName,
} from './render-lab-motion-scenes.mjs';

const root = path.resolve(import.meta.dirname, '..');
const USAGE = 'usage: node tools/render-lab-motion-vectors.mjs <set-name> [--scenes=S,...] [--sequences=Q,...] [--frames=N] [--coordinates=world,floating] [--orders=stable,shuffle,churn]';
const COORDINATES = ['world', 'floating'];
const ORDERS = ['stable', 'shuffle', 'churn'];

// 各列がケースの物体を動かすかと、フレームごとのカメラ移動を持つ。
const SEQUENCES = [
  { name: 'still', moveObjects: false, frame: () => ({ translation: [0, 0], rotation: [0, 0], orbit: [0, 0] }) },
  ...CAMERA_MOTION_SEQUENCES.map((sequence) => ({
    ...sequence,
    moveObjects: false,
    frame: (k) => ({ ...sequence.frame(k), moveObjects: false }),
  })),
  { name: 'object-motion', moveObjects: true, frame: () => ({ translation: [0, 0], rotation: [0, 0], orbit: [0, 0] }) },
  {
    name: 'both',
    moveObjects: true,
    frame: (k) => ({ translation: motionOffsetPx(k, MOTION_SPEEDS_PX[1]), rotation: [0, 0], orbit: [0, 0] }),
  },
];

// CLI の指定を検査し、出力先と撮影条件を返す。
function argumentsOf(argv) {
  const [setName, ...options] = argv;
  if (setName === undefined || !/^[\w.-]+$/.test(setName) || setName === '.' || setName === '..') throw new Error(USAGE);
  const valueOf = (name) => options.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
  const select = (value, all, label) => value === undefined ? all : selectedByName(value, all, label);
  const frames = Number(valueOf('frames') ?? 4);
  if (!Number.isInteger(frames) || frames < 2) throw new Error(`invalid frames: ${valueOf('frames')}`);
  const coordinates = valueOf('coordinates')?.split(',') ?? COORDINATES;
  const orders = valueOf('orders')?.split(',') ?? ORDERS;
  for (const coordinate of coordinates) if (!COORDINATES.includes(coordinate)) throw new Error(`unknown coordinates ${coordinate}`);
  for (const order of orders) if (!ORDERS.includes(order)) throw new Error(`unknown order ${order}`);
  return {
    outDir: path.join(root, '.render-lab-shots', setName),
    scenes: select(valueOf('scenes'), MOTION_VECTOR_SCENES, 'scene'),
    sequences: select(valueOf('sequences'), SEQUENCES, 'sequence'),
    coordinates,
    orders,
    frames,
  };
}

// ケースの描画条件を置き、列が指定する物体運動と積み順を設定する。
async function setCase(devTools, scene, coordinate, order, sequence) {
  await devTools.evaluate(`window.renderLab.showShot(${JSON.stringify(scene.caseName)}, ${JSON.stringify(scene.shot)}, ${JSON.stringify(MOTION_GRAPHICS)})`);
  if (scene.hasEntities) {
    await devTools.evaluate(`window.renderLab.setCaseValue('motion', ${JSON.stringify(sequence.moveObjects)})`);
    await devTools.evaluate(`window.renderLab.setCaseValue('casingCount', ${scene.casingCount})`);
    await devTools.evaluate(`window.renderLab.setCaseValue('casingOrder', ${JSON.stringify(order)})`);
    await devTools.evaluate(`window.renderLab.setCaseValue('coordinates', ${JSON.stringify(coordinate)})`);
  }
  await devTools.evaluate('window.renderLab.resetMotionReference()');
}

// 1 条件の全フレームを描き、PNG とフレーム別指標を保存する。
async function shootSequence(devTools, scene, sequence, coordinate, order, frames, directory) {
  const metrics = [];
  await setCase(devTools, scene, coordinate, order, sequence);
  try {
    for (let frame = 0; frame < frames; frame++) {
      const movement = sequence.frame(frame);
      await devTools.evaluate(`window.renderLab.moveCamera(${JSON.stringify(movement.translation)}, ${JSON.stringify(movement.rotation)}, ${JSON.stringify(movement.orbit)})`);
      const staticWorld = !sequence.moveObjects && order !== 'churn';
      const summary = await evaluateLong(devTools,
        `window.renderLab.motionVectorFrame(${frame}, ${staticWorld}).then((record) => {
          window.__motionVector = record;
          return record.metrics;
        })`,
        `${scene.name}/${sequence.name}/${coordinate}/${order}/${frame}`);
      for (const kind of ['motion', 'difference']) {
        const dataUrl = await devTools.evaluate(`window.__motionVector.${kind}Png`);
        writeFileSync(path.join(directory, `${kind}-${String(frame).padStart(3, '0')}.png`),
          Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
      }
      metrics.push({ frame, ...summary });
      await devTools.evaluate('delete window.__motionVector');
    }
  } finally {
    await devTools.evaluate('window.renderLab.resetMotion()');
    await devTools.evaluate('window.renderLab.resetMotionReference()');
  }
  return metrics;
}

// 1 条件のフレーム別指標から、撮影組に記録する要約を作る。
function aggregatesOf(records) {
  return records.map((record) => {
    const metrics = record.metrics;
    const selfCount = metrics.reduce((sum, item) => sum + item.selfCheckCount, 0);
    const gpuCount = metrics.reduce((sum, item) => sum + item.gpuDifferenceCount, 0);
    const slotCount = metrics.reduce((sum, item) => sum + item.slotErrorCount, 0);
    const surfaceCount = metrics.reduce((sum, item) => sum + item.surfaceCount, 0);
    return {
      ...record,
      sampleCount: metrics.reduce((sum, item) => sum + item.sampleCount, 0),
      surfaceCount,
      entityOutlineFraction: weightedFraction(metrics, 'entityOutlineFraction', surfaceCount),
      depthOutlineFraction: weightedFraction(metrics, 'depthOutlineFraction', surfaceCount),
      outlineFraction: weightedFraction(metrics, 'outlineFraction', surfaceCount),
      depthRatioMax: maxMetric(metrics, 'depthRatioMax'),
      rasterToleranceRatioP999: maxMetric(metrics, 'rasterToleranceRatioP999'),
      rasterToleranceRatioMax: maxMetric(metrics, 'rasterToleranceRatioMax'),
      rasterToleranceAboveLimitCount: sumMetric(metrics, 'rasterToleranceAboveLimitCount'),
      depthRatioAboveLimitCount: sumMetric(metrics, 'depthRatioAboveLimitCount'),
      depthRatioAboveLimitNormalizedMax: maxMetric(metrics, 'depthRatioAboveLimitNormalizedMax'),
      noHistoryCount: sumMetric(metrics, 'noHistoryCount'),
      selfCheckRms: pooledRms(metrics, 'selfCheckRms', 'selfCheckCount', selfCount),
      selfCheckP999: maxMetric(metrics, 'selfCheckP999'),
      selfCheckMax: maxMetric(metrics, 'selfCheckMax'),
      selfCheckAboveLimitCount: sumMetric(metrics, 'selfCheckAboveLimitCount'),
      gpuDifferenceRms: pooledRms(metrics, 'gpuDifferenceRms', 'gpuDifferenceCount', gpuCount),
      gpuDifferenceP999: maxMetric(metrics, 'gpuDifferenceP999'),
      gpuDifferenceMax: maxMetric(metrics, 'gpuDifferenceMax'),
      gpuDifferenceNormalizedMax: maxMetric(metrics, 'gpuDifferenceNormalizedMax'),
      slotErrorRms: pooledRms(metrics, 'slotErrorRms', 'slotErrorCount', slotCount),
      slotErrorMax: maxMetric(metrics, 'slotErrorMax'),
    };
  });
}

// フレーム別割合を面のある標本数で重み付けする。
function weightedFraction(metrics, key, surfaceCount) {
  return surfaceCount === 0 ? 0
    : metrics.reduce((sum, item) => sum + item[key] * item.surfaceCount, 0) / surfaceCount;
}

// 指標列の最大値を返す。
function maxMetric(metrics, key) {
  return Math.max(0, ...metrics.map((item) => item[key]));
}

// 指標列の合計を返す。
function sumMetric(metrics, key) {
  return metrics.reduce((sum, item) => sum + item[key], 0);
}

// フレーム別 RMS を標本数でまとめる。
function pooledRms(metrics, rmsKey, countKey, count) {
  return count === 0 ? 0
    : Math.sqrt(metrics.reduce((sum, item) => sum + item[rmsKey] ** 2 * item[countKey], 0) / count);
}

// 検算 A/B/C と輪郭・番号比較を場面、列、座標、積み順ごとの表にする。
function reportOf(aggregates, frames) {
  const header = [
    '場面', '列', '座標', '積み順', '標本', '面', '実体輪郭率', '深度輪郭率', '輪郭率',
    'ρ 最大', 'ρ/ρmax 99.9%', 'ρ/ρmax 最大', 'ρ/ρmax >1', 'ρ>1e-4', 'そのρ/ρmax 最大',
    '前なし', 'A RMS [px]', 'A 99.9% [px]', 'A 最大 [px]', 'A >1e-6',
    'C RMS [px]', 'C 99.9% [px]', 'C 最大 [px]', 'C/(動き·ρ) 最大', '番号 RMS [px]', '番号 最大 [px]',
  ];
  const rows = aggregates.map((item) => [
    item.scene, item.sequence, item.coordinates, item.order, item.sampleCount, item.surfaceCount,
    item.entityOutlineFraction.toExponential(2), item.depthOutlineFraction.toExponential(2), item.outlineFraction.toExponential(2),
    item.depthRatioMax.toExponential(2), item.rasterToleranceRatioP999.toExponential(2),
    item.rasterToleranceRatioMax.toExponential(2), item.rasterToleranceAboveLimitCount,
    item.depthRatioAboveLimitCount, item.depthRatioAboveLimitNormalizedMax.toExponential(2), item.noHistoryCount,
    item.selfCheckRms.toExponential(2), item.selfCheckP999.toExponential(2), item.selfCheckMax.toExponential(2),
    item.selfCheckAboveLimitCount, item.gpuDifferenceRms.toExponential(2), item.gpuDifferenceP999.toExponential(2),
    item.gpuDifferenceMax.toExponential(2), item.gpuDifferenceNormalizedMax.toExponential(2),
    item.slotErrorRms.toExponential(2), item.slotErrorMax.toExponential(2),
  ]);
  return [
    `# 動きの参照 (${new Date().toISOString()})`, '',
    `フレーム数 ${frames}。画素は 4 px 間隔。輪郭は実体境界と深度二階差を別々に集計。`,
    'A は CPU 行列写像と実体行列写像、B は ρ とラスタライズ丸め上限、C は GPU 深度参照とレイ参照の比較。',
    '99.9% は条件内のフレームごとの分位の最大。', '',
    `| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`), '',
  ].join('\n');
}

// 全ケース・列・座標・積み順を撮り、指標と閲覧ページを出力する。
async function main() {
  const { outDir, scenes, sequences, coordinates, orders, frames } = argumentsOf(process.argv.slice(2));
  const { session, devTools, fatalEvents } = await openMotionLab({
    port: 8775, debugPort: 9453, profilePrefix: 'tepui-render-lab-motion-vectors-',
  });
  const records = [];
  try {
    rmSync(outDir, { recursive: true, force: true });
    for (const scene of scenes) {
      await openLabPage(session);
      for (const sequence of sequences) {
        for (const coordinate of coordinates) {
          for (const order of orders.filter((value) => scene.orders.includes(value))) {
            const directory = path.join(outDir, scene.name, sequence.name, coordinate, order);
            mkdirSync(directory, { recursive: true });
            const metrics = await shootSequence(devTools, scene, sequence, coordinate, order, frames, directory);
            records.push({
              scene: scene.name, sequence: sequence.name, coordinates: coordinate, order, frames, metrics,
            });
            console.log(`shot ${scene.name}/${sequence.name}/${coordinate}/${order}`);
          }
        }
      }
    }
    if (fatalEvents.length > 0) throw new Error(`Page reported errors during shooting:\n${fatalEvents.join('\n')}`);
  } finally {
    await session.close();
  }

  const aggregates = aggregatesOf(records);
  const report = reportOf(aggregates, frames);
  writeFileSync(path.join(outDir, 'report.md'), report);
  writeFileSync(path.join(outDir, 'metrics.json'), JSON.stringify(records, null, 1));
  writeFileSync(path.join(outDir, 'index.html'), motionVectorPageHtml(records));
  console.log(report);
  console.log(`Wrote ${path.relative(root, path.join(outDir, 'index.html'))}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
