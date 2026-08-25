// assets-src/coastline/ne_110m_coastline.geojson(fetch-coastline-source.mjs が取り込む)を、
// src/render/earth-coastline.ts が読む折れ線の配列(緯度・経度 [deg] のペア列)へ落とす。
// GeoJSON の座標は [経度, 緯度] だが、出力は [緯度, 経度] へ入れ替える
// (body-graticule.ts の latLonPoint(latDeg, lonDeg, ...) の引数順に合わせるため)。
//
// 実行: node tools/export-coastline.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = join(repoRoot, 'assets-src', 'coastline', 'ne_110m_coastline.geojson');
const outDir = join(repoRoot, 'src', 'assets');
const outPath = join(outDir, 'earth-coastline.json');

const geojson = JSON.parse(readFileSync(sourcePath, 'utf8'));

const lines = [];
for (const feature of geojson.features) {
  const { type, coordinates } = feature.geometry;
  const parts = type === 'MultiLineString' ? coordinates : [coordinates];
  for (const part of parts) lines.push(part.map(([lon, lat]) => [lat, lon]));
}

mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, JSON.stringify(lines));
console.log(`wrote ${outPath} (${lines.length} lines, ${lines.reduce((n, l) => n + l.length, 0)} points)`);
