// 保存済みの比較レポート全体へ、現在の距離定義を適用し直す。
// .cloud-lab/history/ の元ファイルは触らず、距離だけを計算し直した複製を
// .cloud-lab/history-polar-masked/ へ同じファイル名で書く。zonal 以外の家族が
// 保存値と 1 つでも違えば失敗して終了する (定義の変更が zonal だけに及ぶことの検査)。

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { computeDistances } from './cloud-distances.mjs';

const root = path.resolve(import.meta.dirname, '..');
const historyDir = path.join(root, '.cloud-lab', 'history');
const outDir = path.join(root, '.cloud-lab', 'history-polar-masked');

const names = readdirSync(historyDir).filter((name) => name.endsWith('.json')).sort();
mkdirSync(outDir, { recursive: true });
let mismatchedFamilies = 0;
let rewritten = 0;
for (const name of names) {
  const report = JSON.parse(readFileSync(path.join(historyDir, name), 'utf8'));
  const distances = computeDistances(report.sections);
  const stored = report.distances?.families ?? {};
  for (const [family, value] of Object.entries(distances.families)) {
    if (family === 'zonal') continue;
    if (stored[family] !== undefined && stored[family] !== value) {
      console.error(`${name}: ${family} が保存値 ${stored[family]} と再計算値 ${value} で違う`);
      mismatchedFamilies++;
    }
  }
  const rederived = {
    ...report,
    distances,
    meta: {
      ...report.meta,
      polarMask: {
        applied: true,
        definition: 'zonal excludes bands entirely poleward of |lat| 70 deg',
        rederivedBy: 'tools/cloud-rederive-distances.mjs',
        rederivedAt: new Date().toISOString(),
      },
    },
  };
  writeFileSync(path.join(outDir, name), `${JSON.stringify(rederived, null, 2)}\n`);
  rewritten++;
  const oldZonal = stored.zonal;
  console.log(
    `${name}  zonal ${oldZonal === undefined ? '(未計測)' : oldZonal.toFixed(3)} → `
    + `${distances.families.zonal.toFixed(3)}  index ${report.distances?.index?.toFixed(3) ?? '(未計測)'} → ${distances.index.toFixed(3)}`,
  );
}
console.log(`\n${rewritten} 件を ${outDir} へ書き出した。zonal 以外の家族の不一致: ${mismatchedFamilies} 件`);
if (mismatchedFamilies > 0) process.exit(1);
