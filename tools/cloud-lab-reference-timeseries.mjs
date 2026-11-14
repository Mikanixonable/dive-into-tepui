// ひまわり AHI Band13(クリーン赤外 10.3 µm)の時系列を NASA GIBS WMS から
// .cloud-lab/reference-timeseries/ へ取り込み、cloud-lab:compare が読む manifest.json を書く。
// 既にあるフレームは取り直さない。取得源は Worldview スナップショット API ではなく GIBS WMS —
// スナップショット API は静止衛星レイヤに真っ黒(全画素 0)を返すことを実測で確認済み。
// 可視(Band3)ではなく赤外を使う — 可視は夜に真っ黒になるため、64 h にわたる系列が組めない。
// 赤外は昼夜を問わず雲を写す(2026-11-08〜10 の 6 時刻で実測)。雲は冷たいほど明るい表示になる。
// GIBS の `best` は直近しか残らない(2026-11-11 の実測: 2026-10-01 は取得可、2026-06-01 は
// 真っ黒)ので、開始日は既定で 3 日前 00:00 UTC とし、64 h 後が昨日 16:00 UTC に収まる。
// WMS 1.3.0 + EPSG:4326 では BBOX は緯度・経度の順(南・西・北・東)。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng } from './png.mjs';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, '.cloud-lab', 'reference-timeseries');

const LAYER = 'Himawari_AHI_Band13_Clean_Infrared';
const WMS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi';

// 比較の箱。北西太平洋の中緯度(温帯低気圧帯・偏西風)と西太平洋の熱帯(収束帯・貿易風)。
// どちらもひまわり円盤の内側。tools/cloud-lab-compare.mjs の箱切り出しと対。
const BOXES = [
  { name: 'midlat-npac', label: '北西太平洋の中緯度(30-55°N 130-175°E)', north: 55, south: 30, west: 130, east: 175 },
  { name: 'tropics-wpac', label: '西太平洋の熱帯(5°S-20°N 130-170°E)', north: 20, south: -5, west: 130, east: 170 },
];
// サンプル時刻 [h]。tools/cloud-lab-compare.mjs の MOTION_SAMPLE_HOURS と対。
const SAMPLE_HOURS = [0, 1, 2, 4, 8, 16, 32, 64];
// 取り込むフレームの横の画素数。縦は箱の縦横比に合わせる。
const FRAME_WIDTH = 1024;
// 真っ黒と見なす輝度平均の上限。GIBS はデータの無い時刻に全画素 0 の画像を返す。
const BLANK_MEAN_LIMIT = 0.01;

// 開始日の既定: 3 日前 00:00 UTC。`--start YYYY-MM-DD` で指定できる。
function defaultStart() {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - 3);
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

function parseStart(argv) {
  const index = argv.indexOf('--start');
  if (index === -1) return defaultStart();
  const value = argv[index + 1];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) {
    throw new Error(`--start は YYYY-MM-DD で指定する: ${value ?? ''}`);
  }
  const start = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) throw new Error(`--start が日付として読めない: ${value}`);
  return start;
}

// GIBS WMS の GetMap の URL。BBOX は南・西・北・東(緯度・経度の順)。
function frameUrl(box, time) {
  const height = Math.round((FRAME_WIDTH * (box.north - box.south)) / (box.east - box.west));
  return `${WMS}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${LAYER}&CRS=EPSG:4326`
    + `&BBOX=${box.south},${box.west},${box.north},${box.east}`
    + `&WIDTH=${FRAME_WIDTH}&HEIGHT=${height}&FORMAT=image/png`
    + `&TIME=${time.toISOString().replace(/\.\d{3}Z$/, 'Z')}&TRANSPARENT=FALSE`;
}

// PNG のバイト列の平均輝度(0..1)。PNG でなければ、GIBS の失敗応答(XML)として投げる。
function meanLuminance(bytes) {
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    throw new Error(`PNG でない応答が返った(先頭: ${Buffer.from(bytes.subarray(0, 120)).toString('utf8')})`);
  }
  const { channels, data } = decodePng(Buffer.from(bytes));
  let sum = 0;
  for (let i = 0; i < data.length; i += channels) {
    sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
  }
  return sum / (data.length / channels) / 255;
}

// 1 フレームの取得。回線の瞬断では失敗しないよう、失敗したら 3 回まで取り直す。
async function fetchFrame(url, file) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      return new Uint8Array(await response.arrayBuffer());
    } catch (e) {
      lastError = e;
      console.log(`${file}: 取得に失敗(${e.message}) — ${attempt}/3 回目、取り直す`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
  throw new Error(`${file}: 3 回取り直しても取得できない(${url}): ${lastError.message}`);
}

async function main() {
  const start = parseStart(process.argv.slice(2));
  mkdirSync(outDir, { recursive: true });
  const frames = [];
  for (const box of BOXES) {
    for (const hours of SAMPLE_HOURS) {
      const file = path.posix.join('.cloud-lab', 'reference-timeseries', `${box.name}-${hours}h.png`);
      const target = path.join(root, file);
      const time = new Date(start.getTime() + hours * 3600 * 1000);
      if (existsSync(target)) {
        const mean = meanLuminance(new Uint8Array(readFileSync(target)));
        console.log(`skip ${file}(既にある・平均輝度 ${mean.toFixed(3)})`);
        frames.push({ box: box.name, hours, file, meanLuminance: mean });
        continue;
      }
      const url = frameUrl(box, time);
      const bytes = await fetchFrame(url, file);
      const mean = meanLuminance(bytes);
      if (mean < BLANK_MEAN_LIMIT) {
        throw new Error(`${file}: 真っ黒なフレーム(平均輝度 ${mean.toFixed(4)}) — `
          + `${time.toISOString()} に GIBS の ${LAYER} が無い。開始日を新しくして取り直すこと`);
      }
      writeFileSync(target, bytes);
      console.log(`fetched ${file}(${time.toISOString()}・平均輝度 ${mean.toFixed(3)})`);
      frames.push({ box: box.name, hours, file, meanLuminance: mean });
    }
  }
  const manifest = {
    tool: 'cloud-lab-reference-timeseries',
    layer: LAYER,
    source: 'NASA GIBS WMS (epsg4326/best)',
    startUtc: start.toISOString(),
    sampleHours: SAMPLE_HOURS,
    boxes: BOXES,
    frames,
  };
  writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${path.posix.join('.cloud-lab', 'reference-timeseries', 'manifest.json')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
