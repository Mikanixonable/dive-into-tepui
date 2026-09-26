// 台風の実写を NASA Worldview のスナップショットから .cloud-lab/reference/ へ取り込み、cloud-lab:compare
// が読む reference.json(名前・日付・レイヤ・BBOX・中心・ファイル)を書く。8k_clouds に台風は写って
// いないので、台風の比較の相手はここから取る。既にある画像は取り直さない。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, '.cloud-lab', 'reference');

// 取る台風。date は UTC の日付、bbox は南・西・北・東の縁 [°]、center は中心の緯度・経度 [°]。
// 先頭の Mawar だけが外洋にいて、残り 2 つは陸を含む。
const TYPHOONS = [
  { name: 'mawar', date: '2023-05-25', layer: 'VIIRS_NOAA20_CorrectedReflectance_TrueColor',
    bbox: { south: -5, west: 120, north: 35, east: 160 }, center: { latitude: 13.9, longitude: 143 } },
  { name: 'trami', date: '2018-09-26', layer: 'VIIRS_SNPP_CorrectedReflectance_TrueColor',
    bbox: { south: 5, west: 110, north: 45, east: 150 }, center: { latitude: 21.6, longitude: 129 } },
  { name: 'hagibis', date: '2019-10-09', layer: 'VIIRS_SNPP_CorrectedReflectance_TrueColor',
    bbox: { south: 0, west: 120, north: 40, east: 160 }, center: { latitude: 20, longitude: 141 } },
];
// スナップショットの 1 辺の画素数。40° の箱で 0.04°/px ≈ 4 km になり、8k_clouds(赤道 4.9 km/texel)と
// ほぼ同じ細かさ。
const SNAPSHOT_SIZE = 1024;

// Worldview Snapshots API の URL。BBOX の並びは south,west,north,east。
function snapshotUrl(typhoon) {
  const { bbox } = typhoon;
  return 'https://wvs.earthdata.nasa.gov/api/v1/snapshot?REQUEST=GetSnapshot'
    + `&TIME=${typhoon.date}T00:00:00Z&BBOX=${bbox.south},${bbox.west},${bbox.north},${bbox.east}`
    + `&CRS=EPSG:4326&LAYERS=${typhoon.layer}&WRAP=day&FORMAT=image/png`
    + `&WIDTH=${SNAPSHOT_SIZE}&HEIGHT=${SNAPSHOT_SIZE}`;
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const entries = [];
  for (const typhoon of TYPHOONS) {
    // file はリポジトリ相対。
    const file = path.posix.join('.cloud-lab', 'reference', `typhoon-${typhoon.name}.png`);
    const target = path.join(root, file);
    if (existsSync(target)) {
      console.log(`skip ${file}(既にある)`);
    } else {
      const url = snapshotUrl(typhoon);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${typhoon.name}: HTTP ${response.status} ${response.statusText} (${url})`);
      writeFileSync(target, Buffer.from(await response.arrayBuffer()));
      console.log(`fetched ${file}`);
    }
    entries.push({ ...typhoon, file });
  }
  writeFileSync(path.join(outDir, 'reference.json'), `${JSON.stringify(entries, null, 2)}\n`);
  console.log(`wrote ${path.posix.join('.cloud-lab', 'reference', 'reference.json')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
