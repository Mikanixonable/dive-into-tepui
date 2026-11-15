// 実写の教師の全場面を 256 km のタイルへ分け、タイルごとの形態特徴を測って保存し、実写だけの要約を出す。
// 入力は .cloud-detail/random-teacher/manifest.json の ok の点の 4 km/px の画像。
// 出力は .cloud-detail/regime/teacher-tiles.json(条件はこの道具では足さない。conditions は空)。
// 引数なし: node tools/cloud-regime-tiles.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FEATURE_NAMES, TILE_PX, tileFeaturesFromPng } from './cloud-regime-features.mjs';
import { variogram } from './cloud-regime-metrics.mjs';

const root = path.resolve(import.meta.dirname, '..');
const teacherManifestFile = path.join(root, '.cloud-detail', 'random-teacher', 'manifest.json');
const outDir = path.join(root, '.cloud-detail', 'regime');
const outFile = path.join(outDir, 'teacher-tiles.json');

// 教師の 4 km/px の段(random-teacher の TIERS_KM_PER_PX の 4 と、画像の 512 px)。
const KM_PER_PX = 4;
// 緯度 1° の長さ [km]。cloud-detail-random-teacher.mjs の KM_PER_DEGREE と同じ値
// (そちらは export されておらず、import すると取得が走るため、値をここへ写している)。
const KM_PER_DEGREE = 111.32;
// 人が見る区分の並び。random-teacher の CATEGORIES の順。
const CATEGORY_ORDER = [
  'tropical-sea', 'temperate-sea', 'highlat-sea', 'tropical-land', 'temperate-land', 'highlat-land', 'arid-land',
];
// 表に出す線形の特徴量(orientDeg は円周量なので、分位の表には出さない)。
const TABLE_FEATURES = FEATURE_NAMES.filter((name) => name !== 'orientDeg');
const TABLE_COLUMNS_PER_BLOCK = 3;
// 表の 1 セルの幅(「0.0237 (0.000383–0.0665)」が収まる幅)。
const CELL_WIDTH = 27;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function quantile(sorted, q) {
  const position = (sorted.length - 1) * q;
  const lo = Math.floor(position);
  const hi = Math.ceil(position);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (position - lo);
}

// 有限の値だけの分位の要約。
function percentiles(values) {
  const sorted = values.filter(isNum).sort((a, b) => a - b);
  if (sorted.length === 0) return { median: null, p10: null, p90: null };
  return { median: quantile(sorted, 0.5), p10: quantile(sorted, 0.1), p90: quantile(sorted, 0.9) };
}

const sig3 = (v) => (v === null ? '—' : v.toPrecision(3));
const pad = (text, width) => text.padEnd(width);
const wide = (text, width) => text.padStart(width);

function main() {
  const manifest = JSON.parse(readFileSync(teacherManifestFile, 'utf8'));
  const points = manifest.points.filter((p) => p.status === 'ok');
  const scenes = [];
  const samples = [];
  for (const point of points) {
    const scene = `${point.category}-${String(point.slot).padStart(3, '0')}`;
    const file = point.files.find((name) => name.endsWith(`-${KM_PER_PX}km.png`));
    if (!file) throw new Error(`${scene} に ${KM_PER_PX} km/px の画像が無い`);
    const tiles = tileFeaturesFromPng(readFileSync(path.join(root, file)), KM_PER_PX, TILE_PX);
    scenes.push({ scene, category: point.category, latitude: point.latitude, longitude: point.longitude, date: point.date });
    // タイルの緯度経度は、random-teacher の BBOX(中心の緯度経度を中心に、東西は cos(緯度) で伸ばした箱)の逆変換。
    const cosLat = Math.cos((point.latitude * Math.PI) / 180);
    for (const tile of tiles) {
      samples.push({
        side: 'real',
        scene,
        tile: `r${tile.row}c${tile.col}`,
        xKm: tile.xKm,
        yKm: tile.yKm,
        lat: point.latitude + tile.yKm / KM_PER_DEGREE,
        lon: point.longitude + tile.xKm / (KM_PER_DEGREE * cosLat),
        features: tile.features,
        conditions: {},
      });
    }
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, `${JSON.stringify({
    tool: 'cloud-regime-tiles',
    generatedAt: new Date().toISOString(),
    kmPerPx: KM_PER_PX,
    tilePx: TILE_PX,
    scenes,
    samples,
  })}\n`);

  print(scenes, samples);
}

function print(scenes, samples) {
  const lines = [];
  lines.push(`実写の教師: ${scenes.length} 場面・${samples.length} タイル(${TILE_PX} px = ${TILE_PX * KM_PER_PX} km)`);
  lines.push('');
  lines.push('区分ごとの形態特徴: 中央値 (p10–p90)');
  const categoryOf = new Map(scenes.map((s) => [s.scene, s.category]));
  const categories = CATEGORY_ORDER.filter((c) => scenes.some((s) => s.category === c));
  for (let start = 0; start < TABLE_FEATURES.length; start += TABLE_COLUMNS_PER_BLOCK) {
    const block = TABLE_FEATURES.slice(start, start + TABLE_COLUMNS_PER_BLOCK);
    lines.push(pad('区分', 16) + block.map((f) => wide(f, CELL_WIDTH)).join(''));
    for (const category of categories) {
      const rows = samples.filter((s) => categoryOf.get(s.scene) === category);
      const cells = block.map((f) => {
        const { median, p10, p90 } = percentiles(rows.map((s) => s.features[f]));
        return wide(`${sig3(median)} (${sig3(p10)}–${sig3(p90)})`, CELL_WIDTH);
      });
      lines.push(pad(category, 16) + cells.join(''));
    }
    lines.push('');
  }

  // 全場面のバリオグラム。各帯の γ を全分散で割る。
  const totals = {};
  for (const feature of TABLE_FEATURES) {
    const values = samples.map((s) => s.features[feature]).filter(isNum);
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    totals[feature] = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  }
  const variogramRows = Object.fromEntries(TABLE_FEATURES.map((feature) => [feature, variogram(samples, feature)]));
  const bands = variogramRows[TABLE_FEATURES[0]];
  lines.push('バリオグラム γ(r) ÷ 全分散(場面内の対。帯 [km])');
  lines.push(pad('特徴量', 14) + bands.map((b) => wide(`${b.fromKm}–${b.toKm}`, 11)).join(''));
  lines.push(pad('対の数', 14) + bands.map((b) => wide(String(b.pairs), 11)).join(''));
  for (const feature of TABLE_FEATURES) {
    const cells = variogramRows[feature].map((b) => wide(sig3(b.gamma !== null && totals[feature] > 0
      ? b.gamma / totals[feature] : null), 11));
    lines.push(pad(feature, 14) + cells.join(''));
  }
  lines.push('');

  // 場面内の分散 ÷ 全分散。1 つの場面の中で形がどれだけ変わるか。
  lines.push('場面内の分散 ÷ 全分散(1 場面の中で形がどれだけ変わるか)');
  const sceneOf = new Map();
  for (const s of samples) {
    if (!sceneOf.has(s.scene)) sceneOf.set(s.scene, []);
    sceneOf.get(s.scene).push(s);
  }
  for (const feature of TABLE_FEATURES) {
    const values = samples.map((s) => s.features[feature]).filter(isNum);
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    let within = 0;
    for (const group of sceneOf.values()) {
      const local = group.map((s) => s.features[feature]).filter(isNum);
      const localMean = local.reduce((s, v) => s + v, 0) / local.length;
      within += local.reduce((s, v) => s + (v - localMean) ** 2, 0);
    }
    const total = values.reduce((s, v) => s + (v - mean) ** 2, 0);
    lines.push(`${pad(feature, 14)}${wide((within / total).toFixed(3), 8)}`);
  }
  console.log(lines.join('\n'));
}

main();
