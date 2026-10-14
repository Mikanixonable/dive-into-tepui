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
const MOTION_SAMPLE_STEP = 4;

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
    // 物はフレーム 1 の姿勢で止まる — フレーム 2 が、動いていた物が止まった最初のフレーム。
    name: 'object-stop', moveObjects: true, motionStopFrame: 1,
    frame: () => ({ translation: [0, 0], rotation: [0, 0], orbit: [0, 0] }),
  },
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
  await devTools.evaluate('window.renderLab.setFrame(0)');
  if (scene.hasEntities) {
    await devTools.evaluate(`window.renderLab.setCaseValue('motion', ${JSON.stringify(sequence.moveObjects)})`);
    await devTools.evaluate(`window.renderLab.setCaseValue('casingCount', ${scene.casingCount})`);
    if (scene.debrisCount !== undefined) {
      await devTools.evaluate(`window.renderLab.setCaseValue('debrisCount', ${scene.debrisCount})`);
    }
    await devTools.evaluate(`window.renderLab.setCaseValue('casingOrder', ${JSON.stringify(order)})`);
    await devTools.evaluate(`window.renderLab.setCaseValue('coordinates', ${JSON.stringify(coordinate)})`);
    await devTools.evaluate(`window.renderLab.setCaseValue('motionStopFrame', ${sequence.motionStopFrame ?? -1})`);
  }
  await devTools.evaluate('window.renderLab.resetMotionReference()');
}

// 1 条件の全フレームを描き、PNG とフレーム別指標を保存する。
async function motionGridOf(devTools, label) {
  return evaluateLong(devTools, `Promise.all([
    window.renderLab.readFloat('motion'), window.renderLab.readFloat('depth'),
  ]).then(([motion, depth]) => {
    const step = ${MOTION_SAMPLE_STEP};
    const values = [];
    const covered = [];
    for (let y = 0; y < motion.height; y += step) {
      for (let x = 0; x < motion.width; x += step) {
        const pixel = y * motion.width + x;
        const offset = pixel * 4;
        values.push(motion.rgba[offset], motion.rgba[offset + 1]);
        const isCovered = depth.rgba[offset] > 0;
        covered.push(isCovered ? 1 : 0);
      }
    }
    return {
      width: motion.width, height: motion.height, values, covered,
      eligible: window.__motionVector.comparisonSamples,
    };
  })`, label);
}

function percentileOf(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? 0;
}

function compareCoordinateMotions(worldFrames, floatingFrames) {
  const errors = [];
  let expectedCount = 0;
  let comparedCount = 0;
  let worldRejectedFloatingValueCount = 0;
  let worldValueFloatingRejectedCount = 0;
  let coverageMismatchCount = 0;
  let aboveLimitCount = 0;
  for (let frame = 0; frame < worldFrames.length; frame++) {
    const world = worldFrames[frame];
    const floating = floatingFrames[frame];
    if (world.width !== floating.width || world.height !== floating.height
      || world.values.length !== floating.values.length) {
      coverageMismatchCount++;
      continue;
    }
    const worldEligible = new Set(world.eligible);
    const floatingEligible = new Set(floating.eligible);
    for (let sample = 0; sample < world.covered.length; sample++) {
      if (!world.covered[sample] && !floating.covered[sample]) continue;
      if (world.covered[sample] !== floating.covered[sample]) {
        coverageMismatchCount++;
        continue;
      }
      const worldX = world.values[2 * sample];
      const worldY = world.values[2 * sample + 1];
      const floatingX = floating.values[2 * sample];
      const floatingY = floating.values[2 * sample + 1];
      const worldRejected = Math.max(Math.abs(worldX), Math.abs(worldY)) >= 1000;
      const floatingRejected = Math.max(Math.abs(floatingX), Math.abs(floatingY)) >= 1000;
      const worldSampleEligible = worldEligible.has(sample);
      const floatingSampleEligible = floatingEligible.has(sample);
      if (worldSampleEligible !== floatingSampleEligible) {
        coverageMismatchCount++;
        continue;
      }
      if (!worldSampleEligible) continue;
      expectedCount++;
      if (worldRejected && !floatingRejected) worldRejectedFloatingValueCount++;
      else if (!worldRejected && floatingRejected) worldValueFloatingRejectedCount++;
      if (worldRejected || floatingRejected) continue;
      comparedCount++;
      const dx = (floatingX - worldX) * world.width;
      const dy = (floatingY - worldY) * world.height;
      const movement = Math.hypot(worldX * world.width, worldY * world.height);
      const error = Math.hypot(dx, dy);
      errors.push(error);
      if (error > 2 ** -10 * movement + 0.01) aboveLimitCount++;
    }
  }
  return {
    expectedCount, comparedCount, worldRejectedFloatingValueCount, worldValueFloatingRejectedCount,
    coverageMismatchCount, rms: errors.length === 0 ? 0
      : Math.sqrt(errors.reduce((sum, value) => sum + value * value, 0) / errors.length),
    p999: percentileOf(errors, 0.999), max: Math.max(0, ...errors), aboveLimitCount,
  };
}

async function shootSequence(devTools, scene, sequence, coordinate, order, frames, directory) {
  const metrics = [];
  const motionGrids = [];
  await setCase(devTools, scene, coordinate, order, sequence);
  try {
    for (let frame = 0; frame < frames; frame++) {
      const movement = sequence.frame(frame);
      await devTools.evaluate(`window.renderLab.moveCamera(${JSON.stringify(movement.translation)}, ${JSON.stringify(movement.rotation)}, ${JSON.stringify(movement.orbit)})`);
      const staticWorld = !sequence.moveObjects && order !== 'churn';
      const summary = await evaluateLong(devTools,
        `window.renderLab.motionVectorFrame(${frame}, ${staticWorld}, false, ${frame === 1}).then((record) => {
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
      motionGrids.push(await motionGridOf(devTools, `${scene.name}/${sequence.name}/${coordinate}/${frame}/grid`));
      await devTools.evaluate('delete window.__motionVector');
    }
    const gapFrame = frames + 1;
    const lastMovement = sequence.frame(frames - 1);
    await devTools.evaluate(`window.renderLab.moveCamera(${JSON.stringify(lastMovement.translation)}, ${JSON.stringify(lastMovement.rotation)}, ${JSON.stringify(lastMovement.orbit)})`);
    const gapSummary = await evaluateLong(devTools,
      `window.renderLab.motionVectorFrame(${gapFrame}, false, true, false).then((record) => {
        window.__motionVector = record;
        return record.metrics;
      })`,
      `${scene.name}/${sequence.name}/${coordinate}/${order}/gap`);
    const gapDataUrl = await devTools.evaluate('window.__motionVector.motionPng');
    writeFileSync(path.join(directory, `motion-gap-${String(gapFrame).padStart(3, '0')}.png`),
      Buffer.from(gapDataUrl.slice(gapDataUrl.indexOf(',') + 1), 'base64'));
    metrics.push({ frame: gapFrame, ...gapSummary });
    motionGrids.push(await motionGridOf(devTools, `${scene.name}/${sequence.name}/${coordinate}/${gapFrame}/grid`));
    await devTools.evaluate('delete window.__motionVector');
  } finally {
    await devTools.evaluate('window.renderLab.resetMotion()');
    await devTools.evaluate('window.renderLab.resetMotionReference()');
  }
  return { metrics, motionGrids };
}

// 1 条件のフレーム別指標から、撮影組に記録する要約を作る。
function aggregatesOf(records) {
  return records.map((record) => {
    const metrics = record.metrics;
    const selfCount = metrics.reduce((sum, item) => sum + item.selfCheckCount, 0);
    const gpuCount = metrics.reduce((sum, item) => sum + item.gpuDifferenceCount, 0);
    const motionCount = metrics.reduce((sum, item) => sum + item.gpuMotionCount, 0);
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
      gpuMotionRms: pooledRms(metrics, 'gpuMotionRms', 'gpuMotionCount', motionCount),
      gpuMotionP999: maxMetric(metrics, 'gpuMotionP999'),
      gpuMotionMax: maxMetric(metrics, 'gpuMotionMax'),
      gpuMotionAboveLimitCount: sumMetric(metrics, 'gpuMotionAboveLimitCount'),
      rejectedPixelCount: sumMetric(metrics, 'rejectedPixelCount'),
      rejectedPixelMismatchCount: sumMetric(metrics, 'rejectedPixelMismatchCount'),
      expectedRejectedGpuValueCount: sumMetric(metrics, 'expectedRejectedGpuValueCount'),
      expectedValueGpuRejectedCount: sumMetric(metrics, 'expectedValueGpuRejectedCount'),
      nonFiniteGpuMovementCount: sumMetric(metrics, 'nonFiniteGpuMovementCount'),
      comparisonExpectedCount: sumMetric(metrics, 'comparisonExpectedCount'),
      comparisonCount: sumMetric(metrics, 'comparisonCount'),
      sameFrameMismatchCount: sumMetric(metrics, 'sameFrameMismatchCount'),
      fullNoHistorySurfacePixelCount: sumMetric(metrics, 'fullNoHistorySurfacePixelCount'),
      fullNoHistoryMismatchCount: sumMetric(metrics, 'fullNoHistoryMismatchCount'),
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
    '前なし', '動き RMS [px]', '動き 99.9% [px]', '動き 最大 [px]', '許容超過', '棄却不一致', '同番不一致',
    'A RMS [px]', 'A 99.9% [px]', 'A 最大 [px]', 'A >1e-6',
    'C RMS [px]', 'C 99.9% [px]', 'C 最大 [px]', 'C/(動き·ρ) 最大', '番号 RMS [px]', '番号 最大 [px]',
    'expectedRejectButGpuValue', 'expectedValueButGpuReject', 'nonFiniteGpuSamples', 'motionExpectedSamples', 'motionComparedSamples',
    'fullNoHistorySurfacePixels', 'fullNoHistoryMismatchPixels',
    'worldFloatingRmsPx', 'worldFloatingP999Px', 'worldFloatingMaxPx', 'worldFloatingAboveLimit',
    'worldFloatingRejectMismatch', 'worldFloatingCoverageMismatch', 'worldFloatingExpected', 'worldFloatingCompared',
  ];
  const rows = aggregates.map((item) => [
    item.scene, item.sequence, item.coordinates, item.order, item.sampleCount, item.surfaceCount,
    item.entityOutlineFraction.toExponential(2), item.depthOutlineFraction.toExponential(2), item.outlineFraction.toExponential(2),
    item.depthRatioMax.toExponential(2), item.rasterToleranceRatioP999.toExponential(2),
    item.rasterToleranceRatioMax.toExponential(2), item.rasterToleranceAboveLimitCount,
    item.depthRatioAboveLimitCount, item.depthRatioAboveLimitNormalizedMax.toExponential(2), item.noHistoryCount,
    item.gpuMotionRms.toExponential(2), item.gpuMotionP999.toExponential(2), item.gpuMotionMax.toExponential(2),
    item.gpuMotionAboveLimitCount, item.rejectedPixelMismatchCount, item.sameFrameMismatchCount,
    item.selfCheckRms.toExponential(2), item.selfCheckP999.toExponential(2), item.selfCheckMax.toExponential(2),
    item.selfCheckAboveLimitCount, item.gpuDifferenceRms.toExponential(2), item.gpuDifferenceP999.toExponential(2),
    item.gpuDifferenceMax.toExponential(2), item.gpuDifferenceNormalizedMax.toExponential(2),
    item.slotErrorRms.toExponential(2), item.slotErrorMax.toExponential(2),
    item.expectedRejectedGpuValueCount, item.expectedValueGpuRejectedCount,
    item.nonFiniteGpuMovementCount,
    item.comparisonExpectedCount, item.comparisonCount,
    item.fullNoHistorySurfacePixelCount, item.fullNoHistoryMismatchCount,
    item.coordinateDifference?.rms ?? '', item.coordinateDifference?.p999 ?? '',
    item.coordinateDifference?.max ?? '', item.coordinateDifference?.aboveLimitCount ?? '',
    item.coordinateDifference === null || item.coordinateDifference === undefined ? ''
      : item.coordinateDifference.worldRejectedFloatingValueCount + item.coordinateDifference.worldValueFloatingRejectedCount,
    item.coordinateDifference?.coverageMismatchCount ?? '',
    item.coordinateDifference?.expectedCount ?? '', item.coordinateDifference?.comparedCount ?? '',
  ]);
  const surfaceRows = aggregates.flatMap((record) => {
    const first = record.metrics.find((item) => item.frame === 0)?.surfaceCount ?? 0;
    return record.metrics.map((item) => [
      record.scene, record.sequence, record.coordinates, record.order, item.frame, item.surfaceCount,
      first === 0 ? 0 : item.surfaceCount / first,
    ]);
  });
  return [
    `# 動きの参照 (${new Date().toISOString()})`, '',
    `フレーム数 ${frames}。通常の照合は 4 px 間隔、タンパク質の棄却確認は全画素。輪郭は実体境界と深度二階差を別々に集計。`,
    'G バッファ動きとレイ参照の差、同じ番号での読み戻し一致、棄却印の照合を記録。A/B/C は 4-2 の参照自己検算。',
    '99.9% は条件内のフレームごとの分位の最大。', '',
    `| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`), '',
    '## 面数のフレーム推移', '',
    'frame 0 に対する面画素数の比を示す。連続フレームで比が 1 から落ちないことを条件ごとに確認する。', '',
    '| 場面 | 列 | 座標 | 積み順 | frame | surfaceCount | frame 0 比 |',
    '| --- | --- | --- | --- | ---: | ---: | ---: |',
    ...surfaceRows.map((row) => `| ${row.slice(0, 6).join(' | ')} | ${row[6].toFixed(6)} |`), '',
  ].join('\n');
}

// 全ケース・列・座標・積み順を撮り、指標と閲覧ページを出力する。
async function main() {
  const { outDir, scenes, sequences, coordinates, orders, frames } = argumentsOf(process.argv.slice(2));
  const { session, devTools, fatalEvents } = await openMotionLab({
    port: 8775, debugPort: 9453, profilePrefix: 'tepui-render-lab-motion-vectors-',
  });
  const records = [];
  const worldMotionFrames = new Map();
  try {
    rmSync(outDir, { recursive: true, force: true });
    for (const scene of scenes) {
      await openLabPage(session);
      const runs = scene.runs ?? [{ sequences: sequences.map(({ name }) => name), coordinates }];
      for (const run of runs) {
        for (const sequence of sequences.filter(({ name }) => run.sequences.includes(name))) {
        for (const coordinate of run.coordinates.filter((value) => coordinates.includes(value))) {
          for (const order of orders.filter((value) => scene.orders.includes(value))) {
            const directory = path.join(outDir, scene.name, sequence.name, coordinate, order);
            mkdirSync(directory, { recursive: true });
            const { metrics, motionGrids } = await shootSequence(devTools, scene, sequence, coordinate, order, frames, directory);
            const pairKey = `${scene.name}/${sequence.name}/${order}`;
            let coordinateDifference = null;
            if (coordinate === 'world') worldMotionFrames.set(pairKey, motionGrids);
            if (coordinate === 'floating') {
              const worldFrames = worldMotionFrames.get(pairKey);
              if (worldFrames !== undefined) coordinateDifference = compareCoordinateMotions(worldFrames, motionGrids);
            }
            records.push({
              scene: scene.name, sequence: sequence.name, coordinates: coordinate, order, frames, metrics,
              coordinateDifference,
            });
            console.log(`shot ${scene.name}/${sequence.name}/${coordinate}/${order}`);
          }
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
  const failures = aggregates.filter((item) => item.rejectedPixelMismatchCount !== 0
    || item.comparisonExpectedCount !== item.comparisonCount
    || item.fullNoHistoryMismatchCount !== 0
    || item.gpuMotionAboveLimitCount !== 0
    || item.sameFrameMismatchCount !== 0
    || (item.coordinateDifference !== null && item.coordinateDifference !== undefined
      && (item.coordinateDifference.worldRejectedFloatingValueCount !== 0
        || item.coordinateDifference.worldValueFloatingRejectedCount !== 0
        || item.coordinateDifference.coverageMismatchCount !== 0
        || item.coordinateDifference.expectedCount !== item.coordinateDifference.comparedCount
        || item.coordinateDifference.aboveLimitCount !== 0)));
  if (failures.length > 0) {
    throw new Error(`Motion-vector validation failed in ${failures.map((item) =>
      `${item.scene}/${item.sequence}/${item.coordinates}/${item.order}`
        + ` (rejection mismatch ${item.rejectedPixelMismatchCount}; comparisons ${item.comparisonCount}/${item.comparisonExpectedCount})`).join(', ')}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
