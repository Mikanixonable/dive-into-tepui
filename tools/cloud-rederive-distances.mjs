// 保存済みの比較レポート全体へ、現在の距離定義を適用し直す。
// .cloud-lab/history/ の元ファイルは触らず、距離だけを計算し直した複製を
// .cloud-lab/history-polar-masked/ へ同じファイル名で書く。zonal 以外の家族が
// 保存値と 1 つでも違えば失敗して終了する (定義の変更が zonal だけに及ぶことの検査)。
// MODIS の雲頂参照がある場合は、保存済みレポートの生成側 cloudTop 節と組み合わせて
// cloudTop 家族も後から計算する — 生成側は時刻 0 のモデル状態で実写の日付に依らないため、
// 参照の日付 (2026-11-08) との組み合わせが正当である。参照が無ければ cloudTop は付かない。

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { computeDistances } from './cloud-distances.mjs';

const root = path.resolve(import.meta.dirname, '..');
const historyDir = path.join(root, '.cloud-lab', 'history');
const outDir = path.join(root, '.cloud-lab', 'history-polar-masked');

const cloudtopManifestPath = path.join(root, '.cloud-lab', 'reference-cloudtop', 'manifest.json');
const cloudTopReference = existsSync(cloudtopManifestPath)
  ? (() => {
    const manifest = JSON.parse(readFileSync(cloudtopManifestPath, 'utf8'));
    return {
      layer: manifest.layer,
      date: manifest.date,
      colormap: manifest.colormap,
      entries: manifest.frames.flatMap((frame) => frame.stats.map((entry) => ({
        region: frame.region, part: entry.part, stats: entry.stats,
      }))),
    };
  })()
  : null;
if (cloudTopReference === null) {
  console.log('MODIS の雲頂参照が無いため cloudTop 家族は付けない — npm run cloud-lab:reference-cloudtop で取り込む');
}

const names = readdirSync(historyDir).filter((name) => name.endsWith('.json')).sort();
mkdirSync(outDir, { recursive: true });
let mismatchedFamilies = 0;
let rewritten = 0;
for (const name of names) {
  const report = JSON.parse(readFileSync(path.join(historyDir, name), 'utf8'));
  const sections = cloudTopReference === null
    ? report.sections
    : { ...report.sections, cloudTopReference };
  const distances = computeDistances(sections);
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
    sections,
    distances,
    meta: {
      ...report.meta,
      polarMask: {
        applied: true,
        definition: 'zonal excludes bands entirely poleward of |lat| 70 deg',
        rederivedBy: 'tools/cloud-rederive-distances.mjs',
        rederivedAt: new Date().toISOString(),
      },
      ...(cloudTopReference === null ? {} : {
        cloudTop: {
          applied: true,
          layer: cloudTopReference.layer,
          date: cloudTopReference.date,
          rederivedBy: 'tools/cloud-rederive-distances.mjs',
          rederivedAt: new Date().toISOString(),
        },
      }),
    },
  };
  writeFileSync(path.join(outDir, name), `${JSON.stringify(rederived, null, 2)}\n`);
  rewritten++;
  const oldZonal = stored.zonal;
  console.log(
    `${name}  zonal ${oldZonal === undefined ? '(未計測)' : oldZonal.toFixed(3)} → `
    + `${distances.families.zonal.toFixed(3)}  index ${report.distances?.index?.toFixed(3) ?? '(未計測)'} → ${distances.index.toFixed(3)}`
    + `${distances.families.cloudTop === undefined ? '' : `  cloudTop ${distances.families.cloudTop.toFixed(3)}`}`,
  );
}
console.log(`\n${rewritten} 件を ${outDir} へ書き出した。zonal 以外の家族の不一致: ${mismatchedFamilies} 件`);
if (mismatchedFamilies > 0) process.exit(1);
