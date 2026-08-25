// 地球の海岸線データの取り込み: Natural Earth の 110m coastline (public domain) を
// assets-src/coastline/ へ取り込む。tools/fetch-orbit-catalog.mjs と同じく API へは
// 実行のたびに接続する取り込みツールで、生成(export-coastline.mjs)とは分離する。
//
// 実行: node tools/fetch-coastline-source.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(repoRoot, 'assets-src', 'coastline');
const outPath = join(outDir, 'ne_110m_coastline.geojson');

const SOURCE_URL =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_coastline.geojson';

const res = await fetch(SOURCE_URL);
if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
const body = await res.text();

mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, body);
console.log(`wrote ${outPath} (${body.length} bytes)`);
