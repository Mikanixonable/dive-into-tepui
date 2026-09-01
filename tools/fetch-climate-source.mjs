// 地球の気候データの取り込み: どちらも public domain の NASA 配布物を assets-src/climate/ へ置く。
//   - 標高: NASA Blue Marble の GEBCO 標高画像(8bit グレー、0..255 が 0..6400 m)
//   - 雲量: NASA Earth Observations の Aqua/MODIS 月平均雲量(8bit グレー、0..254 が 0..1、
//     255 は観測なし)。年ごと・季節ごとの偏りを均すため、複数年の全月を取り込む。
// fetch-coastline-source.mjs と同じく実行のたびに接続する取り込みツールで、生成
// (export-climate.mjs)とは分離する。
//
// 実行: node tools/fetch-climate-source.mjs
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(repoRoot, 'assets-src', 'climate');
const cloudFractionDir = join(outDir, 'cloud-fraction');

const ELEVATION_URL =
  'https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73934/gebco_08_rev_elev_21600x10800.png';
const CLOUD_FRACTION_URL = (month) =>
  `https://neo.gsfc.nasa.gov/archive/gs/MYDAL2_M_CLD_FR/MYDAL2_M_CLD_FR_${month}.PNG`;
const CLOUD_FRACTION_YEAR_FIRST = 2016;
const CLOUD_FRACTION_YEAR_LAST = 2020;
// 1 ファイルあたりの試行回数。
const ATTEMPT_LIMIT = 5;

// url を path へ落とす。既にあるものは飛ばす — 雲量は 60 ファイル 300 MB あり、配信側は途中で
// 接続を切ることがある。その場で数回試し、諦めたあとももう一度走らせれば続きから拾える。
async function download(url, path) {
  if (existsSync(path)) return;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const body = Buffer.from(await res.arrayBuffer());
      writeFileSync(path, body);
      console.log(`wrote ${path} (${body.length} bytes)`);
      return;
    } catch (cause) {
      if (attempt === ATTEMPT_LIMIT) throw new Error(`fetch failed: ${url}`, { cause });
    }
  }
}

mkdirSync(cloudFractionDir, { recursive: true });
await download(ELEVATION_URL, join(outDir, 'gebco_08_rev_elev_21600x10800.png'));
for (let year = CLOUD_FRACTION_YEAR_FIRST; year <= CLOUD_FRACTION_YEAR_LAST; year++) {
  for (let month = 1; month <= 12; month++) {
    const name = `${year}-${String(month).padStart(2, '0')}`;
    await download(CLOUD_FRACTION_URL(name), join(cloudFractionDir, `${name}.png`));
  }
}
