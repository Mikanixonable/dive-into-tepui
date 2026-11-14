// 実写の赤外の時系列を NASA GIBS WMS から .cloud-lab/reference-motion/ へ取り込み、
// cloud-lab:motion-report が読む manifest.json を書く。緯度帯と海陸を散らした 13 箱について
// 2 つの時期の 48 時間を 1 時間刻みで取る。箱は緯度経度ではなく km の正方形 (2000 km 四方、
// 2 km/px、1000 px)。既にあるフレームは取り直さない。GIBS が返した真っ黒と取得の失敗は
// 欠測として manifest に記録し、直前のフレームで埋めずに飛ばす。
// 同じ層の帯 13 カラーマップ (cloud-brightness-temperature が読む) も併せて保存する。
//
// 実行: npm run cloud-lab:reference-motion
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng } from './png.mjs';
import { COLORMAP_URL } from './cloud-brightness-temperature.mjs';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, '.cloud-lab', 'reference-motion');

const WMS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi';
const LAYERS = {
  himawari: 'Himawari_AHI_Band13_Clean_Infrared',
  goesEast: 'GOES-East_ABI_Band13_Clean_Infrared',
  goesWest: 'GOES-West_ABI_Band13_Clean_Infrared',
};
// 箱は (中心緯度, 中心経度, 層)。層は観測円盤に入るものを選ぶ。アフリカの熱帯の陸は
// どの層の円盤にも入らないため、南米の熱帯の陸へ替えた。
const BOXES = [
  { name: 'midlat-nwpac', cls: 'midlat-sea', lat: 40, lon: 160, layer: 'himawari' },
  { name: 'midlat-npac-east', cls: 'midlat-sea', lat: 40, lon: -140, layer: 'goesWest' },
  { name: 'midlat-natl', cls: 'midlat-sea', lat: 45, lon: -40, layer: 'goesEast' },
  { name: 'japan', cls: 'japan', lat: 35, lon: 138, layer: 'himawari' },
  { name: 'midlat-sindian', cls: 'midlat-sea', lat: -45, lon: 80, layer: 'himawari' },
  { name: 'midlat-spac', cls: 'midlat-sea', lat: -45, lon: -150, layer: 'goesWest' },
  { name: 'subtrop-nwpac', cls: 'subtropics', lat: 25, lon: 150, layer: 'himawari' },
  { name: 'subtrop-sepac', cls: 'subtropics', lat: -25, lon: -90, layer: 'goesEast' },
  { name: 'tropics-wpac', cls: 'tropics-sea', lat: 0, lon: 150, layer: 'himawari' },
  { name: 'tropics-atl', cls: 'tropics-sea', lat: 5, lon: -30, layer: 'goesEast' },
  { name: 'tropics-epac', cls: 'tropics-sea', lat: 0, lon: -100, layer: 'goesEast' },
  { name: 'tropics-samerica', cls: 'tropics-land', lat: -10, lon: -60, layer: 'goesEast' },
  { name: 'highlat-natl', cls: 'high-lat', lat: 60, lon: -20, layer: 'goesEast' },
];
// 時期 (UTC 0 時からの 48 時間)。GIBS の best は直近の数か月しか残らず、2026-09 より前の日付は
// 全画素 0 の画像になるため、2026-09-20 以降を選ぶ。
const START_DATES = ['2026-09-20', '2026-10-28'];
const SAMPLE_HOURS = Array.from({ length: 49 }, (_, i) => i);
// 箱の一辺の半分 [km]、画素のサイズ [km/px]、一辺の画素数。
const HALF_KM = 1000;
const KM_PER_PX = 2;
const SIZE_PX = 1000;
const KM_PER_DEG = 111.32;
// 真っ黒と見なす輝度平均の上限。GIBS はデータの無い時刻に全画素 0 の画像を返す。
const BLANK_MEAN_LIMIT = 0.01;
// リクエストの間隔。1 秒に 2 回程度に抑える。
const REQUEST_INTERVAL_MS = 550;
const MAX_ATTEMPTS = 3;

// 箱の緯度経度の範囲。経度の幅は cos(中心緯度) で決め、箱の両方向の km が揃うようにする。
function boxFor(box) {
  const dlat = HALF_KM / KM_PER_DEG;
  const dlon = HALF_KM / (KM_PER_DEG * Math.cos((box.lat * Math.PI) / 180));
  return {
    south: box.lat - dlat, north: box.lat + dlat,
    west: box.lon - dlon, east: box.lon + dlon,
  };
}

// GIBS WMS の GetMap の URL。BBOX は南・西・北・東(緯度・経度の順)。
function frameUrl(layer, bbox, time) {
  return `${WMS}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${layer}&CRS=EPSG:4326`
    + `&BBOX=${bbox.south.toFixed(4)},${bbox.west.toFixed(4)},${bbox.north.toFixed(4)},${bbox.east.toFixed(4)}`
    + `&WIDTH=${SIZE_PX}&HEIGHT=${SIZE_PX}&FORMAT=image/png`
    + `&TIME=${time.replace(/\.\d{3}Z$/, 'Z')}&TRANSPARENT=FALSE`;
}

// PNG の平均輝度 (0..1)。PNG でなければ GIBS の失敗応答(XML)として投げる。
function meanLuminance(bytes) {
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    throw new Error(`PNG でない応答 (先頭: ${Buffer.from(bytes.subarray(0, 120)).toString('utf8')})`);
  }
  const { channels, data } = decodePng(Buffer.from(bytes));
  let sum = 0;
  for (let i = 0; i < data.length; i += channels) sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
  return sum / (data.length / channels) / 255;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 1 フレームの取得。失敗は MAX_ATTEMPTS 回まで取り直す。真っ黒は取り直さず欠測として返す。
async function fetchFrame(url) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const mean = meanLuminance(bytes);
      return { bytes, mean };
    } catch (e) {
      lastError = e;
      await sleep(2000 * attempt);
    }
  }
  return { error: lastError.message };
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const colormapResponse = await fetch(COLORMAP_URL);
  if (!colormapResponse.ok) throw new Error(`カラーマップの取得に失敗: HTTP ${colormapResponse.status}`);
  writeFileSync(path.join(outDir, 'colormap.xml'), await colormapResponse.text());

  const series = [];
  let fetched = 0;
  let reused = 0;
  let missingCount = 0;
  for (const start of START_DATES) {
    const startMs = Date.parse(`${start}T00:00:00Z`);
    for (const box of BOXES) {
      const bbox = boxFor(box);
      const record = {
        box: box.name, class: box.cls, layer: LAYERS[box.layer], start,
        centerLat: box.lat, centerLon: box.lon, bbox, frames: [], missing: [],
      };
      for (const hours of SAMPLE_HOURS) {
        const time = new Date(startMs + hours * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
        const file = path.posix.join('.cloud-lab', 'reference-motion', `${box.name}-${start}-${hours}h.png`);
        const target = path.join(root, file);
        if (existsSync(target)) {
          const mean = meanLuminance(new Uint8Array(readFileSync(target)));
          record.frames.push({ hours, timeUtc: time, file, meanLuminance: mean });
          reused++;
          continue;
        }
        await sleep(REQUEST_INTERVAL_MS);
        const result = await fetchFrame(frameUrl(LAYERS[box.layer], bbox, time));
        if (result.error !== undefined) {
          record.missing.push({ hours, timeUtc: time, reason: `取得失敗: ${result.error}` });
          missingCount++;
          console.log(`欠測 ${file}: 取得失敗 (${result.error})`);
          continue;
        }
        if (result.mean < BLANK_MEAN_LIMIT) {
          record.missing.push({ hours, timeUtc: time, reason: `真っ黒(平均輝度 ${result.mean.toFixed(4)})` });
          missingCount++;
          console.log(`欠測 ${file}: 真っ黒`);
          continue;
        }
        writeFileSync(target, result.bytes);
        record.frames.push({ hours, timeUtc: time, file, meanLuminance: result.mean });
        fetched++;
        console.log(`fetched ${file}(平均輝度 ${result.mean.toFixed(3)})`);
      }
      series.push(record);
      console.log(`系列 ${box.name} ${start}: ${record.frames.length} 枚、欠測 ${record.missing.length}`);
    }
  }
  const manifest = {
    tool: 'cloud-lab-reference-motion',
    source: 'NASA GIBS WMS (epsg4326/best)',
    colormap: { url: COLORMAP_URL, file: 'colormap.xml' },
    kmPerPx: KM_PER_PX,
    sizePx: SIZE_PX,
    halfKm: HALF_KM,
    sampleHours: SAMPLE_HOURS,
    series,
  };
  writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const total = series.reduce((n, s) => n + s.frames.length, 0);
  console.log(`取れた枚数 ${total}(今回取得 ${fetched}、既存 ${reused})、欠測 ${missingCount}`);
  console.log('wrote .cloud-lab/reference-motion/manifest.json');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
