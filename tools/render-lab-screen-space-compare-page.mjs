// 手順8-15の候補(run)を比べるページ・合成シート・数値の要約を書き直す。撮影はしない。
// 使い方: node tools/render-lab-screen-space-compare-page.mjs [--runs=before-a,x,...]
// 省くと記録のあるすべての run。出力は OUTPUT の compare.html・compare-summary.md・compare-sheets/<ケース>/。
// 先に収束した4帯の PNG(bands/converged-*)を作る。1パスの帯は render-lab-screen-space-one-pass-bands.mjs が書いたものを使う。
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { writeConvergedBands } from './screen-space-chain-bands.mjs';
import { metricsOf, OUTPUT, runLabels } from './screen-space-chain-runs.mjs';
import { SCENES } from './screen-space-chain-setup.mjs';
import { imageFileOf, KINDS } from './screen-space-compare-kinds.mjs';
import { pageHtml } from './screen-space-compare-page.mjs';
import { writeSheets } from './screen-space-compare-sheets.mjs';
import { summaryMarkdown } from './screen-space-compare-summary.mjs';
import { alphaTableOf, bandTableOf, conditionTablesOf, invariantTableOf, roiTablesOf } from './screen-space-compare-tables.mjs';

const runsArgument = process.argv.find((arg) => arg.startsWith('--runs='));
const requestedRuns = runsArgument === undefined ? runLabels() : runsArgument.slice('--runs='.length).split(',');

// 画像の種類 id → run → { 1: ページからのパス, 4: 同 } 。無い画像は含めない。
function filesOf(scene, runs) {
  const files = {};
  for (const kind of KINDS) {
    for (const run of runs) {
      const paths = {};
      for (const zoom of kind.zoomable ? [1, 4] : [1]) {
        const file = imageFileOf(kind, run, scene, zoom);
        if (file !== null) paths[zoom] = `runs/${run}/${scene}/${file}`;
      }
      if (paths[1] !== undefined) (files[kind.id] ??= {})[run] = paths;
    }
  }
  return files;
}

const scenes = [];
for (const { name } of SCENES) {
  const runs = requestedRuns.filter((run) => metricsOf(run, name) !== null);
  if (runs.length === 0) continue;
  for (const run of runs) {
    if (writeConvergedBands(run, name) === null) console.warn(`${run}/${name}: converged band means are missing in the cache`);
  }
  const hasOnePassBands = runs.some((run) => imageFileOf(KINDS.find(({ id }) => id === 'one-pass-band-0'), run, name) !== null);
  const hasOcclusion = runs.some((run) => metricsOf(run, name).occlusionOnlyBandSum);
  scenes.push({
    name, runs, files: filesOf(name, runs), conditions: conditionTablesOf(name, runs), roiTables: roiTablesOf(name, runs),
    bandTables: [bandTableOf(name, runs, 'converged'), ...(hasOnePassBands ? [bandTableOf(name, runs, 'one-pass')] : [])],
    invariantTables: [invariantTableOf(name, runs, 'onePassBandSum', '帯和の不変条件(照り返し込み)'),
      ...(hasOcclusion ? [invariantTableOf(name, runs, 'occlusionOnlyBandSum', '帯和の不変条件(遮蔽のみ)')] : [])],
    alphaTable: alphaTableOf(name, runs),
  });
  writeSheets(name, runs, path.join(OUTPUT, 'compare-sheets', name));
}

writeFileSync(path.join(OUTPUT, 'compare.html'), pageHtml(scenes));
writeFileSync(path.join(OUTPUT, 'compare-summary.md'), summaryMarkdown(scenes, requestedRuns));
console.log(path.join(OUTPUT, 'compare.html'));
