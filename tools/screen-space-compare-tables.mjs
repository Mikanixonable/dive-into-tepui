// 手順8-15の候補比較の表。撮影条件・ROI・帯の大きさ・帯和の不変条件・A の検査値を、候補(run)を列に並べた
// { title, header, rows }(セルは文字列)で返す。ページと要約が同じ表を描く。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BASELINE_RUN, metricsOf } from './screen-space-chain-runs.mjs';
import { bandsDirOf } from './screen-space-chain-bands.mjs';
import { fixed } from './screen-space-lab.mjs';

const jsonOrNull = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);
const columnName = (run, scene) => `${run} (${metricsOf(run, scene).conditions.passes}パス)`;
const sci = (value) => (value === null || value === undefined ? '—' : value.toExponential(2));

// 候補ごとに値 valueOf(metrics) を並べた表の行。値が無ければ —。
const rowOf = (label, runs, scene, valueOf) => [label, ...runs.map((run) => valueOf(metricsOf(run, scene)) ?? '—')];

// 撮影条件の表。全候補で同じ値の条件は fixed([[名前, 値]])、候補で違う値は differing の表へ分ける。
export function conditionTablesOf(scene, runs) {
  const conditionRows = [
    ['解像度', (m) => m.conditions.viewport.join('×')],
    ['走査解像度', (m) => m.conditions.scanResolution.join('×')],
    ['スライス×片側の歩', (m) => `${m.conditions.tier.sliceCount}×${m.conditions.tier.stepCount}`],
    ['帯数', (m) => m.conditions.tier.bandCount],
    ['κ (bandScale)', (m) => m.conditions.tier.bandScale],
    ['パス数', (m) => m.conditions.passes],
    ['雑音のパス', (m) => `白色雑音 ${m.conditions.noisePasses.first}〜${m.conditions.noisePasses.first + m.conditions.noisePasses.count - 1}`],
    ['帯和検査のパス', (m) => `白色雑音 ${m.conditions.invariantPass}`],
    ['1パス像の seed', (m) => `blue-noise [${m.blueNoiseSeed}]`],
    ['A の条件', () => '1パスの補正項・クレイは実際の A、収束・迂回の補正項・クレイは A=1'],
    ['走査ソース署名', (m) => m.scanSourceSignature],
    ['ケース署名', (m) => m.sceneSourceSignature],
    ['撮影日時', (m) => m.captureStartedAt],
  ];
  const fixedRows = [], differingRows = [];
  for (const [label, valueOf] of conditionRows) {
    const row = rowOf(label, runs, scene, valueOf);
    if (new Set(row.slice(1)).size === 1) fixedRows.push([label, String(row[1])]);
    else differingRows.push(row.map(String));
  }
  return { fixed: fixedRows, differing: { title: '候補ごとに違う値', header: ['', ...runs], rows: differingRows } };
}

// ROI ごとの構造誤差 RMS・前後半残留/構造・1パス雑音 RMS の表(3枚)。セルは「値 (基準比)」。
export function roiTablesOf(scene, runs) {
  const baseline = metricsOf(BASELINE_RUN, scene);
  const metrics = [
    { title: '構造誤差 RMS', read: (roi) => roi.structureRms, text: (v) => fixed(v, 5) },
    { title: '前後半残留 / 構造誤差', read: (roi) => roi.residualToStructureRatio, text: (v) => `${fixed(100 * v, 1)}%` },
    { title: '1パス雑音 RMS', read: (roi) => roi.noiseRms, text: (v) => fixed(v, 5) },
  ];
  const roiNames = Object.keys((baseline ?? metricsOf(runs[0], scene)).rois);
  return metrics.map(({ title, read, text }) => ({
    title: `${scene} ${title}(括弧内は ${BASELINE_RUN} 比)`,
    header: ['ROI', ...runs.map((run) => columnName(run, scene))],
    rows: roiNames.map((name) => [name, ...runs.map((run) => {
      const roi = metricsOf(run, scene).rois[name];
      if (roi === undefined) return '—';
      const base = baseline?.rois[name];
      const ratio = base === undefined || read(base) === 0 ? '—' : `×${fixed(read(roi) / read(base), 2)}`;
      return `${text(read(roi))} (${ratio})`;
    })]),
  }));
}

// 帯ごとの Σ絶対値・正の和・負の和と、Σ|値| で重みを付けた平均の帯番号。kind は 'converged' か 'one-pass'。
export function bandTableOf(scene, runs, kind) {
  const summaries = runs.map((run) => jsonOrNull(path.join(bandsDirOf(run, scene), `${kind}-bands.json`)));
  const rows = [];
  for (const band of [0, 1, 2, 3]) {
    for (const [label, key] of [['Σ絶対値', 'sumAbs'], ['正の和', 'positiveSum'], ['負の和', 'negativeSum']]) {
      rows.push([`帯${band} ${label}`, ...summaries.map((s) => (s === null ? '—' : fixed(s.bands[band][key], 2)))]);
    }
  }
  rows.push(['平均の帯番号 Σk·E_k / ΣE_k', ...summaries.map((s) => (s === null ? '—' : fixed(s.meanBandNumber, 3)))]);
  return { title: `${scene} ${kind === 'converged' ? '収束した' : '1パスの'}4帯の大きさ`, header: ['', ...runs], rows };
}

// 帯和の不変条件(raw − 4帯和)。field は metrics の 'onePassBandSum' か 'occlusionOnlyBandSum'。
export function invariantTableOf(scene, runs, field, title) {
  const rows = [
    rowOf('平均絶対差', runs, scene, (m) => sci(m[field]?.meanAbsolute)),
    rowOf('RMS', runs, scene, (m) => sci(m[field]?.rms)),
    rowOf('最大絶対差', runs, scene, (m) => sci(m[field]?.maximumAbsolute)),
    rowOf('最大 / 許容(丸め幅の和)', runs, scene, (m) => fixed(m[field]?.maximumToleranceRatio, 3)),
    rowOf('丸め幅を超えた数', runs, scene, (m) => m[field]?.roundingExceeded?.count),
    rowOf('差の地図', runs, scene, (m) => m[field]?.differenceMap),
  ];
  return { title: `${scene} ${title}`, header: ['', ...runs], rows };
}

// A の検査値。
export function alphaTableOf(scene, runs) {
  return { title: `${scene} A の検査値`, header: ['', ...runs], rows: [
    rowOf('帯 RGB を変えたときの A の変化', runs, scene, (m) => sci(m.alphaChangeFromRgb)),
    rowOf('独立1パス間の A の変動', runs, scene, (m) => sci(m.alphaVariationAcrossNoisePasses)),
    rowOf('帯和検査と表示 seed の A の差', runs, scene, (m) => sci(m.onePassInvariantAlphaMaximumDifference)),
    rowOf('基準との1パス A の最大差', runs, scene, (m) => sci(m.onePassAlphaMaximumDifference)),
    rowOf('基準と違う画素数', runs, scene, (m) => m.onePassAlphaDifferentPixels),
  ] };
}
