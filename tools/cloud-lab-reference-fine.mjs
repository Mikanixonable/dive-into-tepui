// Slice A の描画キャプチャと同じスケールで測れる実写参照を NASA GIBS WMS から
// .cloud-lab/reference-fine/ へ取り込み、Slice C が読む manifest.json を書く。
// 層は地域ごとに決める (Himawari / GOES-East / VIIRS)。既にある枠は取り直さない。
// 10000 km 梯子は取らない — 16580 km 幅の平坦な箱は静止衛星円盤に入らず、
// typhoon で実測 blackFrac 0.260 になったため (2000–200 km 帯の上端は既存の
// globe 比較が担う)。モデル・距離定義には触れない (Slice C の仕事)。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng } from './png.mjs';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, '.cloud-lab', 'reference-fine');

const WMS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi';
// 1° あたりの km (緯度方向)。経度方向は cos(緯度) で割る。
const KM_PER_DEG = 111.32;
// 真っ黒と見なす輝度平均の上限。GIBS はデータの無い時刻に全画素 0 の画像を返す。
const BLANK_MEAN_LIMIT = 0.01;
// 円盤外の黒画素がこの割合を超えたら警告を出す (manifest には記録する)。
const BLACK_FRACTION_WARN = 0.02;

// Slice A の直下点 (render-capture/manifest.json)。timeUtc は可視が昼になるよう
// 地域ごとの現地正午付近に固定した (2026-11-08、Phase 2 と同日)。
// nominalKmPerPx は GIBS が出す層の公称解像度 (Band3/Band2 は _1km 層なので 1 km/px が最細)。
const REGIONS = [
  { name: 'npac-storm', label: '北太平洋の嵐帯(45°N 170°W)', lat: 45, lon: -170,
    timeUtc: '2026-11-08T23:00:00Z',
    visible: { layer: 'Himawari_AHI_Band3_Red_Visible_1km', suffix: 'band3', nominalKmPerPx: 1 },
    infrared: { layer: 'Himawari_AHI_Band13_Clean_Infrared', suffix: 'band13', nominalKmPerPx: 2 } },
  { name: 'natl-storm', label: '北大西洋の嵐帯(50°N 30°W)', lat: 50, lon: -30,
    timeUtc: '2026-11-08T14:00:00Z',
    visible: { layer: 'GOES-East_ABI_Band2_Red_Visible_1km', suffix: 'band2', nominalKmPerPx: 1 },
    infrared: { layer: 'GOES-East_ABI_Band13_Clean_Infrared', suffix: 'band13', nominalKmPerPx: 2 } },
  { name: 'so-ocean', label: '南大洋(55°S 100°E)', lat: -55, lon: 100,
    timeUtc: '2026-11-08T05:00:00Z',
    visible: { layer: 'Himawari_AHI_Band3_Red_Visible_1km', suffix: 'band3', nominalKmPerPx: 1 },
    infrared: { layer: 'Himawari_AHI_Band13_Clean_Infrared', suffix: 'band13', nominalKmPerPx: 2 } },
  { name: 'sepac-subtrop', label: '南東太平洋の亜熱帯(20°S 85°W)', lat: -20, lon: -85,
    timeUtc: '2026-11-08T18:00:00Z',
    visible: { layer: 'GOES-East_ABI_Band2_Red_Visible_1km', suffix: 'band2', nominalKmPerPx: 1 },
    infrared: { layer: 'GOES-East_ABI_Band13_Clean_Infrared', suffix: 'band13', nominalKmPerPx: 2 } },
  { name: 'sahara', label: 'サハラ(22°N 10°E、晴天コントロール)', lat: 22, lon: 10,
    timeUtc: '2026-11-01T00:00:00Z',
    visible: { layer: 'VIIRS_SNPP_CorrectedReflectance_TrueColor', suffix: 'viirs', nominalKmPerPx: 0.25 },
    infrared: null },
  { name: 'itcz-atl', label: '大西洋の収束帯(5°N 25°W)', lat: 5, lon: -25,
    timeUtc: '2026-11-08T14:00:00Z',
    visible: { layer: 'GOES-East_ABI_Band2_Red_Visible_1km', suffix: 'band2', nominalKmPerPx: 1 },
    infrared: { layer: 'GOES-East_ABI_Band13_Clean_Infrared', suffix: 'band13', nominalKmPerPx: 2 } },
  { name: 'typhoon', label: '台風域(19°N 136°E)', lat: 19, lon: 136,
    timeUtc: '2026-11-08T03:00:00Z',
    visible: { layer: 'Himawari_AHI_Band3_Red_Visible_1km', suffix: 'band3', nominalKmPerPx: 1 },
    infrared: { layer: 'Himawari_AHI_Band13_Clean_Infrared', suffix: 'band13', nominalKmPerPx: 2 } },
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
  'npac-storm-2000km-infrared': { layer: 'GOES-West_ABI_Band13_Clean_Infrared', suffix: 'band13', nominalKmPerPx: 2 },
};
// 取り込むフレームの横の画素数。縦は Slice A と同じ 540。
const FRAME_WIDTH = 960;
const FRAME_HEIGHT = 540;

// 地域の直下点を中心に、梯子の地上フットプリントと同じ広がりの緯度経度箱を切る。
// 透視のキャプチャと等距円筒の箱では投影が違うが、Slice C は統計特徴量で比べるので許容する。
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

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const frames = [];
  for (const region of REGIONS) {
    for (const ladder of LADDERS) {
      const box = boxFor(region, ladder);
      const layers = ['visible', 'infrared']
        .map((kind) => {
          const def = LAYER_OVERRIDE[`${region.name}-${ladder.name}-${kind}`] ?? region[kind];
          return def === null ? null : def;
        })
        .filter((layer) => layer !== null);
      for (const layer of layers) {
        const file = path.posix.join(
          '.cloud-lab', 'reference-fine', `${region.name}-${ladder.name}-${layer.suffix}.png`,
        );
        const target = path.join(root, file);
        const record = {
          region: region.name, ladder: ladder.name, layer: layer.layer, suffix: layer.suffix,
          file, timeUtc: region.timeUtc, box,
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
        const url = frameUrl(layer.layer, box, region.timeUtc);
        const bytes = await fetchFrame(url, file);
        const stats = frameStats(bytes);
        if (stats.meanLuminance < BLANK_MEAN_LIMIT) {
          throw new Error(`${file}: 真っ黒なフレーム(平均輝度 ${stats.meanLuminance.toFixed(4)}) — `
            + `${region.timeUtc} に GIBS の ${layer.layer} が無い。時刻を新しくして取り直すこと`);
        }
        if (stats.blackFraction > BLACK_FRACTION_WARN) {
          console.log(`注意 ${file}: 黒画素の割合 ${stats.blackFraction.toFixed(3)} が ${BLACK_FRACTION_WARN} を超えた (円盤端の可能性)`);
        }
        writeFileSync(target, bytes);
        console.log(`fetched ${file}(${region.timeUtc}・平均輝度 ${stats.meanLuminance.toFixed(3)}・黒割合 ${stats.blackFraction.toFixed(3)})`);
        frames.push({ ...record, sha256: sha256(bytes), ...stats });
      }
    }
  }
  const manifest = {
    tool: 'cloud-lab-reference-fine',
    source: 'NASA GIBS WMS (epsg4326/best)',
    notes: [
      '10000 km 梯子は無い。16580 km 幅の平坦な箱は静止衛星円盤に入らず、typhoon で実測 blackFrac 0.260 になった。2000–200 km 帯の上端は既存の globe 比較が担う。',
      'npac-storm 2000km の箱の中心は 170°W ではなく 158°W。跨いだ箱は実測 blackFrac 0.289 になり、東西反転した BBOX は GIBS が拒否する。さらに寄せた箱でも Himawari では北東角が円盤の縁に当たって blackFrac 0.20 になるため、この梯子だけ GOES-West を使う (同箱で blackFrac 0.000)。',
      'sahara の日付は 2026-11-01。VIIRS は 11-05〜08 が真っ黒で、11-01 は取れる (処理遅延)。sahara は可視のみ — 赤外の対応層は GIBS best に無い (Meteosat が無く、GOES-East は縁外)。',
      'Band3/Band2 は _1km 層なので実効の最細解像度は 1 km/px。Band13 は公称 2 km/px。20–2 km 帯は可視が担い、赤外は巻雲の筋の向きに使う。',
    ],
    regions: REGIONS.map(({ name, label, lat, lon, timeUtc }) => ({ name, label, lat, lon, timeUtc })),
    ladders: LADDERS,
    centerLonOverride: CENTER_LON_OVERRIDE,
    frames,
  };
  writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${path.posix.join('.cloud-lab', 'reference-fine', 'manifest.json')} (${frames.length} frames)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
