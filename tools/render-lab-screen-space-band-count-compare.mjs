import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RUNS, recordOf } from './screen-space-chain-runs.mjs';
import { pageHtml } from './screen-space-band-count-page.mjs';
import { buildComparison } from './screen-space-band-count-maps.mjs';
import { SCALES } from './screen-space-chain-scale-rms.mjs';

function argument(name) {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function runList(name) {
  return (argument(name) ?? '').split(',').filter(Boolean);
}

const runs = runList('runs');
if (runs.length < 2) throw new Error('usage: --runs=run-a,run-b [--control=x,y] [--out=path]');
for (const run of runs) {
  if (!existsSync(path.join(RUNS, run, 'record.json'))) throw new Error(`run missing: ${run}`);
}
const controls = runList('control').filter((run) => existsSync(path.join(RUNS, run, 'record.json')));
const output = path.resolve(argument('out') ?? path.join(RUNS, 's24-band-count'));
mkdirSync(output, { recursive: true });
const comparison = buildComparison(runs, controls, output, pageHtml);

function numericText(value) {
  return Number.isFinite(value) ? value.toPrecision(3) : '—';
}

function rgbRms(values) {
  if (!Array.isArray(values) || values.length !== 3) return null;
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / 3);
}

function overallRms(metrics, kind) {
  const values = SCALES.map((scale) => rgbRms(metrics?.scaleRms?.[kind]?.[String(scale)])).filter(Number.isFinite);
  return values.length ? Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) : null;
}

function ratioCell(value, reference) {
  if (!Number.isFinite(value)) return '—';
  if (!Number.isFinite(reference) || reference === 0) return numericText(value);
  return `${numericText(value)} (${(value / reference).toPrecision(3)})`;
}

function runHeaders(scene, runsToShow) {
  return runsToShow.map((run) => ` ${run} (N=${scene.counts[run] ?? recordOf(run).conditions.tier.bandCount}) `);
}

function metricTable(scene, metric, label, runsToShow, metricsByRun, counts) {
  const baselineRun = runsToShow.reduce((best, run) => best === null || counts[run] < counts[best] ? run : best, null);
  const lines = [`### ${label}`, '', `| scale |${runHeaders(scene, runsToShow).join('|')}|`,
    `| ---: |${runsToShow.map(() => ' ---: ').join('|')}|`];
  for (const scale of SCALES) {
    const baseline = rgbRms(metricsByRun[baselineRun]?.scaleRms?.[metric]?.[String(scale)]);
    const cells = runsToShow.map((run) => ratioCell(
      rgbRms(metricsByRun[run]?.scaleRms?.[metric]?.[String(scale)]), baseline));
    lines.push(`| ${scale} | ${cells.join(' | ')} |`);
  }
  const referenceTotal = overallRms(metricsByRun[baselineRun], metric);
  const totals = runsToShow.map((run) => ratioCell(overallRms(metricsByRun[run], metric), referenceTotal));
  lines.push(`| 全体 RMS | ${totals.join(' | ')} |`);
  return lines.join('\n');
}

function inspectionTable(scene) {
  const rows = scene.runs.map((run) => {
    const result = scene.bandSumInspection[run];
    const passes = scene.records[run]?.conditions?.passes;
    const mean = result?.meanAbsoluteDifference;
    const maximum = result?.maximumDifference;
    return `| ${run} (N=${scene.counts[run]}) | ${numericText(mean)} | ${numericText(maximum)} | ${passes ?? '—'} |`;
  });
  return [
    '### 帯和の検査', '', '| run | 帯和の差の平均絶対値 | 最大 | パス数 |', '| --- | ---: | ---: | ---: |',
    ...rows,
  ].join('\n');
}

function bandTable(scene) {
  const maxBands = Math.max(0, ...scene.runs.map((run) => scene.bands[run]?.length ?? 0));
  const totals = Object.fromEntries(scene.runs.map((run) => [run, (scene.bands[run] ?? []).reduce((sum, value) => sum + value, 0)]));
  const lines = ['', '### 帯ごとの |収束先| 輝度和', '', `| 帯 | ${scene.runs.join(' | ')} |`,
    `| ---: | ${scene.runs.map(() => '---:').join(' | ')} |`];
  for (let band = 0; band < maxBands; band++) {
    lines.push(`| ${band} | ${scene.runs.map((run) => numericText(scene.bands[run]?.[band])).join(' | ')} |`);
  }
  const share = scene.runs.map((run) => {
    const coarsest = scene.bands[run]?.at(-1);
    return Number.isFinite(coarsest) && totals[run] > 0 ? `${(100 * coarsest / totals[run]).toPrecision(3)}%` : '—';
  });
  lines.push(`| 最も粗い帯の割合 | ${share.join(' | ')} |`);
  return lines.join('\n');
}

function controlTables(scene) {
  const runsToShow = Object.keys(scene.controls);
  if (runsToShow.length === 0) return 'control run の数値がありません。';
  const metrics = Object.fromEntries(runsToShow.map((run) => [run, scene.controls[run].metrics]));
  return [
    '### control (手順22 より前の式・ジッター無し)',
    metricTable(scene, 'structure', 'structure', runsToShow, metrics, scene.controlCounts),
    metricTable(scene, 'noise', 'noise', runsToShow, metrics, scene.controlCounts),
  ].join('\n\n');
}

function reportScene(scene) {
  return [
    `## ${scene.name}`,
    '',
    inspectionTable(scene),
    '',
    ...['structure', 'noise', 'noiseSeed', 'noiseRaster'].map((metric) =>
      metricTable(scene, metric, metric, scene.runs, scene.metrics, scene.counts)),
    '',
    controlTables(scene),
    bandTable(scene),
  ].join('\n\n');
}

const summary = [
  '# 帯数比較',
  '',
  `runs: ${runs.join(', ')}`,
  `controls: ${controls.join(', ') || 'なし'}`,
  '',
  ...comparison.scenes.map(reportScene),
].join('\n');
writeFileSync(path.join(output, 'summary.md'), summary, 'utf8');
console.log(`${comparison.scenes.length} scenes, ${comparison.html.length} HTML characters; page ${output}.html`);
