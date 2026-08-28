// 地球の標高データの取り込み: NASA Blue Marble の GEBCO 標高画像(public domain、8bit グレー、
// 0..255 が 0..6400 m)を assets-src/climate/ へ取り込む。fetch-coastline-source.mjs と同じく
// 実行のたびに接続する取り込みツールで、生成(export-climate.mjs)とは分離する。
//
// 実行: node tools/fetch-climate-source.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(repoRoot, 'assets-src', 'climate');
const outPath = join(outDir, 'gebco_08_rev_elev_21600x10800.png');

const SOURCE_URL =
  'https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73934/gebco_08_rev_elev_21600x10800.png';

const res = await fetch(SOURCE_URL);
if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
const body = Buffer.from(await res.arrayBuffer());

mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, body);
console.log(`wrote ${outPath} (${body.length} bytes)`);
