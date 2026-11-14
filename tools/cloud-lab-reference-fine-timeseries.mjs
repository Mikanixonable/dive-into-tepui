// 時刻つき描画撮影と同じ尺度・同じ箱で測れる実写の可視時系列を NASA GIBS WMS から
// .cloud-lab/reference-fine-timeseries/ へ取り込み、manifest.json を書く。
// 層は reference-fine と同じ地域ごとの決め方 (Himawari / GOES-East、npac-storm 2000km だけ
// GOES-West)。既にある枠は取り直さない。
// 時刻梯子は生成の [0,1,2,4,8] h に対し、実写は現地正午を中心に [-4,-3,-2,0,+4] h —
// 刻み幅 (1,1,2,4 h) と通算 8 h がそろう。可視は昼間しか撮れないので、正午中心にしないと
// 8 h の系列が組めない (夜側は真っ黒になる)。両端の太陽高度は低い (45°N の -4 h で ~7°)
// が、プローブで平均輝度 0.09・黒割合 0.000 を実測済みで、枠ごとの正規化で吸収する。
// サハラは取らない — VIIRS は極軌道で 1 日 1 回程度しか同じ場所を撮らず、8 h の時系列が
// 組めない (Meteosat は GIBS best に無く、GOES-East は縁外)。サハラは時刻 0 の対だけ残す。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng } from './png.mjs';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, '.cloud-lab', 'reference-fine-timeseries');

const WMS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi';
// 1° あたりの km (緯度方向)。経度方向は cos(緯度) で割る。
const KM_PER_DEG = 111.32;
// 真っ黒と見なす輝度平均の上限。GIBS はデータの無い時刻に全画素 0 の画像を返す。
const BLANK_MEAN_LIMIT = 0.01;
// 円盤外の黒画素がこの割合を超えたら警告を出す (manifest には記録する)。
const BLACK_FRACTION_WARN = 0.02;

// 生成のサンプル時刻 [h] と、実写の現地正午からのずれ [h] (同じ刻み幅・同じ通算)。
const SAMPLE_HOURS = [0, 1, 2, 4, 8];
const TIME_OFFSETS_HOURS = [-4, -3, -2, 0, 4];

// reference-fine と同じ地域・同じ現地正午 (timeUtc が t=0 の錨)。可視の層だけ使う。
const REGIONS = [
  { name: 'npac-storm', label: '北太平洋の嵐帯(45°N 170°W)', lat: 45, lon: -170,
    timeUtc: '2026-11-08T23:00:00Z',
    visible: { layer: 'Himawari_AHI_Band3_Red_Visible_1km', suffix: 'band3', nominalKmPerPx: 1 } },
  { name: 'natl-storm', label: '北大西洋の嵐帯(50°N 30°W)', lat: 50, lon: -30,
    timeUtc: '2026-11-08T14:00:00Z',
    visible: { layer: 'GOES-East_ABI_Band2_Red_Visible_1km', suffix: 'band2', nominalKmPerPx: 1 } },
  { name: 'so-ocean', label: '南大洋(55°S 100°E)', lat: -55, lon: 100,
    timeUtc: '2026-11-08T05:00:00Z',
    visible: { layer: 'Himawari_AHI_Band3_Red_Visible_1km', suffix: 'band3', nominalKmPerPx: 1 } },
  { name: 'sepac-subtrop', label: '南東太平洋の亜熱帯(20°S 85°W)', lat: -20, lon: -85,
    timeUtc: '2026-11-08T18:00:00Z',
    visible: { layer: 'GOES-East_ABI_Band2_Red_Visible_1km', suffix: 'band2', nominalKmPerPx: 1 } },
  { name: 'itcz-atl', label: '大西洋の収束帯(5°N 25°W)', lat: 5, lon: -25,
    timeUtc: '2026-11-08T14:00:00Z',
    visible: { layer: 'GOES-East_ABI_Band2_Red_Visible_1km', suffix: 'band2', nominalKmPerPx: 1 } },
  { name: 'typhoon', label: '台風域(19°N 136°E)', lat: 19, lon: 136,
    timeUtc: '2026-11-08T03:00:00Z',
    visible: { layer: 'Himawari_AHI_Band3_Red_Visible_1km', suffix: 'band3', nominalKmPerPx: 1 } },
  // 陸海の層別が取れる海岸。北米東海岸 (38.5°N 73.5°W) で、400 km 梯子でも 2000 km 梯子
  // でも陸と海が入る。GOES-East の直下に近く、可視の昼間 (現地正午 17:00Z) に収まる。
  { name: 'usec', label: '米国東海岸(38.5°N 73.5°W)', lat: 38.5, lon: -73.5,
    timeUtc: '2026-11-08T17:00:00Z',
    visible: { layer: 'GOES-East_ABI_Band2_Red_Visible_1km', suffix: 'band2', nominalKmPerPx: 1 } },
];
// 梯子: Slice A のキャプチャと同じ km/px (960x540 px の地上フットプリント)。
const LADDERS = [
  { name: '400km', kmPerPx: 0.691 },
  { name: '2000km', kmPerPx: 3.454 },
];
// 日付変更線を跨ぐ箱は GIBS が円盤外として黒く返す (npac-storm 2000km で実測 blackFrac 0.289)。
// 中心を 170°W から 158°W へ寄せ、西端を -179.06° に収める。ずれは manifest に記録する。
const CENTER_LON_OVERRIDE = { 'npac-storm-2000km': -158 };
// npac-storm 2000km は寄せた箱でも Himawari では円盤の縁に当たり黒割合 0.20 になる
// (北東角が直下点から 85° で、縁に近い)。同じ箱を GOES-West で取ると黒割合 0.000 なので、
// この梯子だけ GOES-West を使う。400km 梯子は Himawari で黒割合 0.000 のまま。
const LAYER_OVERRIDE = {
  'npac-storm-2000km-visible': { layer: 'GOES-West_ABI_Band2_Red_Visible_1km', suffix: 'band2', nominalKmPerPx: 1 },
};
// 取り込むフレームの横の画素数。縦は Slice A と同じ 540。
const FRAME_WIDTH = 960;
const FRAME_HEIGHT = 540;

// 地域の直下点を中心に、梯子の地上フットプリントと同じ広がりの緯度経度箱を切る。
// reference-fine の boxFor と同じ式 (同じ箱になる)。
function boxFor(region, ladder) {
  const lon = CENTER_LON_OVERRIDE[`${region.name}-${ladder.name}`] ?? region.lon;
  const wKm = FRAME_WIDTH * ladder.kmPerPx;
  const hKm = FRAME_HEIGHT * ladder.kmPerPx;
  const dlat = hKm / KM_PER_DEG / 2;
  const dlon = wKm / (KM_PER_DEG * Math.cos((region.lat * Math.PI) / 180)) / 2;
  return {
    south: region.lat - dlat, north: region.lat + dlat,
    west: lon - dlon, east: lon + dlon, centerLon: lon,
  };
}

// GIBS WMS の GetMap の URL。BBOX は南・西・北・東(緯度・経度の順)。
function frameUrl(layer, box, time) {
  return `${WMS}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${layer}&CRS=EPSG:4326`
    + `&BBOX=${box.south.toFixed(4)},${box.west.toFixed(4)},${box.north.toFixed(4)},${box.east.toFixed(4)}`
    + `&WIDTH=${FRAME_WIDTH}&HEIGHT=${FRAME_HEIGHT}&FORMAT=image/png`
    + `&TIME=${time}&TRANSPARENT=FALSE`;
}

// PNG の平均輝度 (0..1) と黒画素の割合。PNG でなければ、GIBS の失敗応答 (XML) として投げる。
function frameStats(bytes) {
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    throw new Error(`PNG でない応答が返った(先頭: ${Buffer.from(bytes.subarray(0, 120)).toString('utf8')})`);
  }
  const { channels, data } = decodePng(Buffer.from(bytes));
  let sum = 0;
  let black = 0;
  for (let i = 0; i < data.length; i += channels) {
    const luminance = (data[i] + data[i + 1] + data[i + 2]) / 3;
    sum += luminance;
    if (luminance < 3) black++;
  }
  const pixels = data.length / channels;
  return { meanLuminance: sum / pixels / 255, blackFraction: black / pixels };
}

// 1 フレームの取得。回線の瞬断では失敗しないよう、失敗したら 5 回まで取り直す。
// GIBS は失敗を HTTP 200 の XML (ServiceException) で返すことがあるので、PNG でない
// 応答も失敗として取り直す (itcz-atl 400km 1h で実測)。usec 取り込み時 (2026-11-14)
// には同じ URL が 2 回続けて XML を返したので、3 回では足りず 5 回に増やした。
async function fetchFrame(url, file) {
  let lastError = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
        throw new Error(`PNG でない応答が返った(先頭: ${Buffer.from(bytes.subarray(0, 120)).toString('utf8')})`);
      }
      return bytes;
    } catch (e) {
      lastError = e;
      console.log(`${file}: 取得に失敗(${e.message}) — ${attempt}/5 回目、取り直す`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
  throw new Error(`${file}: 5 回取り直しても取得できない(${url}): ${lastError.message}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const frames = [];
  for (const region of REGIONS) {
    for (const ladder of LADDERS) {
      const box = boxFor(region, ladder);
      const layer = LAYER_OVERRIDE[`${region.name}-${ladder.name}-visible`] ?? region.visible;
      for (let step = 0; step < SAMPLE_HOURS.length; step++) {
        const hours = SAMPLE_HOURS[step];
        const time = new Date(new Date(region.timeUtc).getTime() + TIME_OFFSETS_HOURS[step] * 3600 * 1000);
        const timeUtc = time.toISOString().replace(/\.\d{3}Z$/, 'Z');
        const file = path.posix.join(
          '.cloud-lab', 'reference-fine-timeseries', `${region.name}-${ladder.name}-${hours}h-${layer.suffix}.png`,
        );
        const target = path.join(root, file);
        const record = {
          region: region.name, ladder: ladder.name, hours, layer: layer.layer, suffix: layer.suffix,
          file, timeUtc, box,
          kmPerPx: ladder.kmPerPx, nominalKmPerPx: layer.nominalKmPerPx,
          width: FRAME_WIDTH, height: FRAME_HEIGHT,
        };
        if (existsSync(target)) {
          const bytes = new Uint8Array(readFileSync(target));
          const stats = frameStats(bytes);
          console.log(`skip ${file}(既にある・平均輝度 ${stats.meanLuminance.toFixed(3)}・黒割合 ${stats.blackFraction.toFixed(3)})`);
          frames.push({ ...record, sha256: sha256(bytes), ...stats });
          continue;
        }
        const url = frameUrl(layer.layer, box, timeUtc);
        const bytes = await fetchFrame(url, file);
        const stats = frameStats(bytes);
        if (stats.meanLuminance < BLANK_MEAN_LIMIT) {
          throw new Error(`${file}: 真っ黒なフレーム(平均輝度 ${stats.meanLuminance.toFixed(4)}) — `
            + `${timeUtc} に GIBS の ${layer.layer} が無い。時刻を新しくして取り直すこと`);
        }
        if (stats.blackFraction > BLACK_FRACTION_WARN) {
          console.log(`注意 ${file}: 黒画素の割合 ${stats.blackFraction.toFixed(3)} が ${BLACK_FRACTION_WARN} を超えた (円盤端の可能性)`);
        }
        writeFileSync(target, bytes);
        console.log(`fetched ${file}(${timeUtc}・平均輝度 ${stats.meanLuminance.toFixed(3)}・黒割合 ${stats.blackFraction.toFixed(3)})`);
        frames.push({ ...record, sha256: sha256(bytes), ...stats });
      }
    }
  }
  const manifest = {
    tool: 'cloud-lab-reference-fine-timeseries',
    source: 'NASA GIBS WMS (epsg4326/best)',
    notes: [
      '生成のサンプル時刻 [0,1,2,4,8] h に対し、実写は現地正午を中心に [-4,-3,-2,0,+4] h。刻み幅 (1,1,2,4 h) と通算 8 h がそろう。可視は昼間しか撮れないため正午中心にした。両端の太陽高度は低いが、プローブで平均輝度 0.09・黒割合 0.000 を実測済み。',
      'サハラは無い。VIIRS は極軌道で 1 日 1 回程度しか同じ場所を撮らず、8 h の時系列が組めない (Meteosat は GIBS best に無く、GOES-East は縁外)。サハラは時刻 0 の対だけ残す。',
      'npac-storm 2000km の箱の中心は 170°W ではなく 158°W (reference-fine と同じ)。この梯子だけ GOES-West を使う。',
      'Band3/Band2 は _1km 層なので実効の最細解像度は 1 km/px。20–2 km 帯の微細端は 1 km/px の層で測る。',
      '実写の系列は朝→午後の昼間サイクルを含むが、生成の系列はモデルの時刻 0 からの 8 h で昼夜サイクルを持たない。デコヒーレンス時間の比較にはこの非対称が入る (相関は枠ごとの正規化で振幅の変化に鈍い)。',
    ],
    sampleHours: SAMPLE_HOURS,
    offsetsHours: TIME_OFFSETS_HOURS,
    regions: REGIONS.map(({ name, label, lat, lon, timeUtc }) => ({ name, label, lat, lon, timeUtc })),
    ladders: LADDERS,
    centerLonOverride: CENTER_LON_OVERRIDE,
    frames,
  };
  writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${path.posix.join('.cloud-lab', 'reference-fine-timeseries', 'manifest.json')} (${frames.length} frames)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
