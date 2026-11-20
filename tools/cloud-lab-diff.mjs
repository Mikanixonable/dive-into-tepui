// 雲の比較レポートの履歴(.cloud-lab/history/)のうち 2 件を開き、数値の差分と距離の
// 前後判定だけを出す。比較を走らせ直さずに「前回から何が動いたか」を確かめるための
// 軽い出口で、差分・距離の定義は compare が末尾でやっているものと同じ共有部品を使う。
// 使い方: `npm run cloud-lab:diff -- [older.json newer.json]`。省略時は履歴の直近 2 件。
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { computeDistances } from './cloud-distances.mjs';
import { collectNumericDiffs, formatDiffValue, readReport } from './cloud-report-history.mjs';

const root = path.resolve(import.meta.dirname, '..');
const historyDir = path.join(root, '.cloud-lab', 'history');

const names = readdirSync(historyDir).filter((name) => name.endsWith('.json')).sort();
if (names.length < 2) {
  console.error(`履歴が ${names.length} 件しかない(${historyDir})。比較を 2 回以上走らせてから使う。`);
  process.exit(1);
}
const [olderName, newerName] = process.argv.length >= 4
  ? [process.argv[2], process.argv[3]]
  : names.slice(-2);
const older = readReport(historyDir, olderName);
const newer = readReport(historyDir, newerName);
if (!older?.sections || !newer?.sections) {
  console.error('レポートが読めない(sections を持たない)。');
  process.exit(1);
}

console.log(`=== 差分: ${olderName} → ${newerName} ===\n`);
const diffs = { compared: 0, changed: [] };
collectNumericDiffs(older.sections, newer.sections, '', diffs);
for (const { path: leaf, before, after } of diffs.changed) {
  const delta = after - before;
  console.log(`${leaf}: ${formatDiffValue(before)} → ${formatDiffValue(after)} (${delta >= 0 ? '+' : ''}${formatDiffValue(delta)})`);
}
console.log(diffs.changed.length === 0
  ? `変わった数値なし(比較した数値 ${diffs.compared})`
  : `変わった数値 ${diffs.changed.length} / ${diffs.compared}`);

// 距離は保存値でなく sections から同じ定義で計算し直す — 定義を変えても履歴と比較
// できるようにするため。相対 5% 以内は横ばい(compare と同じ幅)。
const before = computeDistances(older.sections);
const after = computeDistances(newer.sections);
console.log('\n=== 距離の変化(相対 5% 以内は横ばい) ===');
for (const [family, afterValue] of Object.entries(after.families)) {
  const priorValue = before.families[family];
  if (priorValue === undefined) {
    console.log(`${family.padEnd(18)} (前回は未計測) → ${afterValue.toFixed(3)}`);
    continue;
  }
  const delta = afterValue - priorValue;
  const verdict = Math.abs(delta) <= priorValue * 0.05 ? '横ばい' : delta < 0 ? '改善' : '悪化';
  console.log(`${family.padEnd(18)} ${priorValue.toFixed(3)} → ${afterValue.toFixed(3)}  ${verdict}`);
}
console.log(`index              ${before.index.toFixed(3)} → ${after.index.toFixed(3)}`);
