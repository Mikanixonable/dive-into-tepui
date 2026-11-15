// 実写の教師(ランダム抽出の場面)の各 256 km タイルへ、その日時の気象条件を付けて保存する。
// 場面は区分を順に 1 つずつ取る順で取得し、キャッシュ済みの場面は取り直さない。枠切れで止まったら、
// そこまでの場面から出力を作って終わる。使い方: node tools/cloud-regime-teacher.mjs [--max-scenes=N]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  NODE_SPACING_KM,
  QuotaExceeded,
  conditionsAt,
  fetchSceneNodes,
  isSceneCached,
  offsetToLatLon,
} from './cloud-regime-reanalysis.mjs';
import { cloudinessAt, landFractionAt } from './cloud-translucent-gibs.mjs';

const root = path.resolve(import.meta.dirname, '..');
const MANIFEST = path.join(root, '.cloud-detail', 'random-teacher', 'manifest.json');
const OUT_DIR = path.join(root, '.cloud-detail', 'regime');
const OUT_FILE = path.join(OUT_DIR, 'teacher-conditions.json');
// タイルの一辺 [km](64 px × 4 km/px)と、場面の格子(8×8)。
const TILE_KM = 256;
const TILES_PER_SIDE = 8;
const CONDITION_NAMES = [
  'slp', 'cyclonic', 'lift', 'advection', 'front', 'humidLow', 'humidUp', 'stability',
  'windLow', 'windLowDir', 'windUp', 'windUpDir', 'shear', 'lat', 'land', 'meanCloudiness',
];

const maxArg = process.argv.find((arg) => arg.startsWith('--max-scenes='));
const maxScenes = maxArg ? Number(maxArg.split('=')[1]) : Infinity;

// 区分を順に 1 つずつ取る並び。区分の中は目録の順。
function orderScenes(points) {
  const byCategory = new Map();
  for (const point of points) {
    if (point.status !== 'ok') continue;
    const id = `${point.category}-${String(point.slot).padStart(3, '0')}`;
    if (!byCategory.has(point.category)) byCategory.set(point.category, []);
    byCategory.get(point.category).push({ scene: id, category: point.category, latitude: point.latitude, longitude: point.longitude, date: point.date });
  }
  const lists = [...byCategory.values()];
  const ordered = [];
  for (let k = 0; ; k++) {
    const row = lists.filter((list) => k < list.length).map((list) => list[k]);
    if (row.length === 0) break;
    ordered.push(...row);
  }
  return ordered;
}

function percentile(sorted, p) {
  const at = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(at);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

function correlation(pairs) {
  const n = pairs.length;
  if (n < 2) return null;
  const mx = pairs.reduce((s, [x]) => s + x, 0) / n;
  const my = pairs.reduce((s, [, y]) => s + y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
}

const fmt = (v) => (v == null ? 'null' : Number(v).toFixed(3));

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const scenes = orderScenes(manifest.points);

// 未取得の場面を、上限に達するまで取る。キャッシュ済みは数えない。
let fetched = 0;
let quotaMessage = null;
for (const scene of scenes) {
  if (isSceneCached(scene.scene)) continue;
  if (fetched >= maxScenes) break;
  try {
    await fetchSceneNodes(scene);
    fetched += 1;
  } catch (error) {
    if (error instanceof QuotaExceeded) {
      quotaMessage = error.message;
      break;
    }
    throw error;
  }
}

// キャッシュにある全場面から出力を作り直す(取得はしない)。
const cachedScenes = scenes.filter((scene) => isSceneCached(scene.scene));
const outScenes = [];
const outTiles = [];
for (const scene of cachedScenes) {
  const { utc, nodes } = await fetchSceneNodes(scene);
  outScenes.push({ scene: scene.scene, category: scene.category, latitude: scene.latitude, longitude: scene.longitude, date: scene.date, utc });
  for (let row = 0; row < TILES_PER_SIDE; row++) {
    for (let col = 0; col < TILES_PER_SIDE; col++) {
      const xKm = (col - (TILES_PER_SIDE - 1) / 2) * TILE_KM;
      const yKm = ((TILES_PER_SIDE - 1) / 2 - row) * TILE_KM;
      const { lat, lon } = offsetToLatLon(scene.latitude, scene.longitude, xKm, yKm);
      const conditions = {
        ...conditionsAt(nodes, xKm, yKm),
        cao: null,
        pw: null,
        lat,
        land: landFractionAt(lat, lon),
        meanCloudiness: cloudinessAt(lat, lon),
      };
      outTiles.push({ scene: scene.scene, tile: `r${row}c${col}`, xKm, yKm, lat, lon, conditions });
    }
  }
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  OUT_FILE,
  JSON.stringify({
    tool: 'cloud-regime-teacher',
    generatedAt: new Date().toISOString(),
    source: 'open-meteo historical-forecast',
    nodeSpacingKm: NODE_SPACING_KM,
    scenes: outScenes,
    tiles: outTiles,
  }),
);

const remaining = scenes.length - cachedScenes.length;
console.log(`場面: 取得 ${fetched} 件(今回) / 保存 ${outScenes.length} 場面・${outTiles.length} タイル / 全 ${scenes.length} 場面`);
console.log(`出力: ${OUT_FILE}`);
console.log('\n条件の分位 (p5 p25 p50 p75 p95):');
for (const name of CONDITION_NAMES) {
  const values = outTiles.map((t) => t.conditions[name]).filter((v) => v != null).sort((a, b) => a - b);
  if (values.length === 0) {
    console.log(`  ${name.padEnd(15)} (欠測のみ)`);
    continue;
  }
  const ps = [5, 25, 50, 75, 95].map((p) => fmt(percentile(values, p)));
  console.log(`  ${name.padEnd(15)} ${ps.join('  ')}   n=${values.length}`);
}

const pairsWith = (a, b) =>
  outTiles.map((t) => [t.conditions[a], t.conditions[b]]).filter(([x, y]) => x != null && y != null);
const corrLiftHumid = correlation(pairsWith('lift', 'humidLow'));
const corrLiftSlp = correlation(
  outTiles
    .map((t) => [t.conditions.lift, t.conditions.slp == null ? null : -t.conditions.slp])
    .filter(([x, y]) => x != null && y != null),
);
console.log('\n検算(上昇が正なら両方正):');
console.log(`  corr(lift, humidLow) = ${fmt(corrLiftHumid)}`);
console.log(`  corr(lift, -slp)     = ${fmt(corrLiftSlp)}`);

console.log('');
if (quotaMessage) console.log(`枠切れ。残り ${remaining} 場面 (${quotaMessage.split('\n')[0]})`);
else console.log(`残り ${remaining} 場面`);
