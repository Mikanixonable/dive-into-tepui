// 雲の実験環境の生成と実写(8k_clouds)の統計比較。ヘッドレス Chrome で .cloud-lab/ を開き、
// 全球と地域別 cap の両面を撮って、帯状平均・階調・圧縮の分位・行方向スペクトル・構造の異方性・
// 地形との関係・雲頂の分布・台風の径方向プロファイルの表を出す。
// 実写は低い厚い雲と高層の巻雲が 1 枚に重なっているので、`npm run cloud-lab:separate` が
// 分離した成分(src/assets の仮テクスチャと .cloud-lab/separated/)を読み、撮影の面(全球の
// 正距円筒と cap の正射影)へ再標本化して成分ごとに比べる。**先に separate を実行しておく。**
// 再標本化した実写厚・実写薄も画像で .cloud-lab/compare/ に残る。
// 台風は 8k_clouds に写っていないので、`npm run cloud-lab:reference` が取り込んだ Worldview の実写
// (.cloud-lab/reference/)を cap の面へ再標本化して比べる。無ければその節だけ飛ばす。
// 表に出した数値はすべて、機械可読なレポートとして .cloud-lab/history/ へも残す(1 回の比較に
// つき 1 ファイル、消さない)。変更の前後で「どの特徴量がどれだけ動いたか」を後から引くためで、
// レポートの形は sections の節立てが表の節立てと対になる。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';
import { componentStats } from './cloud-components.mjs';
import { computeDistances } from './cloud-distances.mjs';
import { FINE_BANDS, FINE_PRIMARY_LADDER, applyCaptureMapping, captureBoxMapping, largestValidRect, measureFinePair, resampleCaptureToBox } from './cloud-fine-structure.mjs';
import { FINE_MOTION_DRIFT_LAG_HOURS, FINE_MOTION_SAMPLE_HOURS, measureFineMotionPair } from './cloud-fine-motion.mjs';
import { HIGH_CLOUD_THRESHOLD_C, coldnessField, invertBrightnessTemperature, parseBand13Colormap } from './cloud-brightness-temperature.mjs';
import { measureCirrusPair } from './cloud-cirrus.mjs';
import { bestShift, centroidOffset, crossingTime } from './cloud-motion.mjs';
import { cloudTopStats, quantile } from './cloud-top-stats.mjs';
import { structureTensor, structureToRgbPng, summarizeStructure } from './cloud-structure.mjs';
import { cropField, cropLatLonBox, decodeChannelPng, decodeRedPng, fieldToGrayPng } from './gray-image.mjs';
import { decodePng } from './png.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.cloud-lab');
const outDir = path.join(buildDir, 'compare');
const port = 8769;
const debugPort = 9446;

// 撮る面の大きさ。tools/cloud-lab/lab.ts の VIEW_HEIGHT / GLOBE_WIDTH / CAP_SIZE と対。
const GLOBE_W = 1024;
const HEIGHT = 512;
const CAP_W = 512;
// cap の円板に内接する、統計に使う中央の正方形の1辺 [px](512 / √2 を切り下げ)。
const CAP_BOX = 362;
// cap の照準。半径 20° の円板は 8.5 km/texel で、実写(赤道 4.9 km/texel)とほぼ同じ細かさになる。
const CAP_RADIUS = 20;
// 地域別 cap。数値目標を当てるのは前の 6 つで、台風は 8k_clouds に写っていないので Worldview の実写と
// 目視で見る。coreRadiusKm は、雲頂を内側と外側に分けて出す半径 [km](台風の中心濃密雲域)。
// upperReadsOutside は、上層の移流が焼いた cap の外を読む地域 — 薄い雲と合成の統計が参考値にしかならない。
const REGIONS = [
  { name: 'npac-storm', label: '北太平洋の暴風帯(45N 170W)', latitude: 45, longitude: -170,
    coreRadiusKm: null, upperReadsOutside: true },
  { name: 'natl-storm', label: '北大西洋の暴風帯(50N 30W)', latitude: 50, longitude: -30,
    coreRadiusKm: null, upperReadsOutside: true },
  { name: 'so-ocean', label: '南大洋(55S 100E)', latitude: -55, longitude: 100,
    coreRadiusKm: null, upperReadsOutside: true },
  { name: 'sepac-subtrop', label: '南東太平洋の亜熱帯高圧帯(20S 85W)', latitude: -20, longitude: -85,
    coreRadiusKm: null, upperReadsOutside: false },
  { name: 'sahara', label: 'サハラ(22N 10E)', latitude: 22, longitude: 10,
    coreRadiusKm: null, upperReadsOutside: false },
  { name: 'itcz-atl', label: '大西洋の収束帯(5N 25W)', latitude: 5, longitude: -25,
    coreRadiusKm: null, upperReadsOutside: false },
  { name: 'typhoon', label: '熱帯低気圧(19N 136E・時刻 0 の最盛期・数値目標外)', latitude: 19, longitude: 136,
    coreRadiusKm: 250, upperReadsOutside: false },
];
const VIEWS = ['photo', 'composite', 'coverage', 'translucent', 'cloudTop', 'surfaceWind', 'front'];

// 地表の風ビューの B が張る速さ [m/s]。tools/cloud-lab/views.ts の WIND_SPAN と対。
const WIND_SPAN = 45;
// 風の最大から外す、熱帯低気圧の中心のまわりの半径 [°]。眼壁の風は熱帯低気圧がいちばん強く巻いた
// 渦である以上そこだけ速くてよいので、異常の判定には入れない。中心は撮影のときにページから引く。
const TROPICAL_EXCLUDE_DEG = 10;

// 前線ビューの表示値が張る、圧縮の 1 を超えた分。tools/cloud-lab/views.ts の FRONT_SPAN と対。
const FRONT_SPAN = 8;
// 低気圧の帯と見なす緯度の下限 [°](BANDS のうち 35-60° の 2 本)。
const LOW_BAND_LATITUDE = 35;
// 低気圧の周りで圧縮を読む範囲 [km]。背景はどの中心からも BACKGROUND_KM より遠い texel、環は最盛期
// (深さ ≥ RING_MATURITY_HPA)の中心から RING_INNER_KM..RING_OUTER_KM の texel。最盛期と見なす深さ [hPa]
// は、低気圧の最深(16〜32 hPa)の中ほどの半分。中心はページから引く(時刻 0 の配置)。
const BACKGROUND_KM = 2500;
const RING_INNER_KM = 500;
const RING_OUTER_KM = 2000;
const RING_MATURITY_HPA = 12;

// 「のっぺり」の判定。この範囲の値を持ち、周り FLATNESS_WINDOW texel の標準偏差がこれ未満の
// texel を、階調も起伏も持たない平坦な灰色と見なす。窓は全球面の 5 texel ≈ 200 km。
const FLAT_VALUE_MIN = 0.06;
const FLAT_VALUE_MAX = 0.25;
const FLAT_DEVIATION = 0.02;
const FLATNESS_WINDOW = 5;
// 階調の刻み。これを境に 10 段へ分けて割合を数える。
const TONE_LEVELS = [0.03, 0.06, 0.1, 0.15, 0.25, 0.4, 0.6, 0.8, 0.94];
// 晴れと見なす値の上限と、真っ白と見なす値の下限。どちらも TONE_LEVELS の刻み。
const CLEAR_LEVEL = 0.06;
const WHITE_LEVEL = 0.94;
// 局所コントラストを取る窓 [texel]。周りこの広さの標準偏差を全 texel で平均する。
const CONTRAST_WINDOW = 5;
// 雲の塊と見なす値のしきい。階調の刻み(TONE_LEVELS)の 1 つで、のっぺり判定の区間の上限でも
// ある — 中間調より上を「塊」として形を測る。
const SHAPE_THRESHOLD = 0.25;

// 動きの計測のサンプル時刻 [h]。decorrelation の桁を見るために対数刻みにする。
const MOTION_SAMPLE_HOURS = [0, 1, 2, 4, 8, 16, 32, 64];
// 移流の lag 相関を取る時刻差 [h] と、探すずらしの上限 [texel]。風 15 m/s × 8 h ≈ 430 km は
// 全球面で約 11 texel(赤道)〜22 texel(60°、横が縮む分)なので、横は 24 まで見る。縦は南北の
// 移動が小さいぶん 6 まで。
const DRIFT_LAG_HOURS = 8;
const DRIFT_MAX_DX = 24;
const DRIFT_MAX_DY = 6;
// 熱帯低気圧のトラックを読む時刻 [h] と、描画中心のずれを測る時刻 [h]。
const TRACK_SAMPLE_HOURS = [0, 12, 24, 36, 48, 60, 72];
const CENTER_SAMPLE_HOURS = [0, 24, 48];
// 描画中心のずれは、解析中心からこの半径 [km] の内側の被覆率の重心で測る。cap 全面で取ると
// 渦の外の雲(前線や別の擾乱)に重心が引かれて「ずれ」でなく環境の非対称を測ってしまう。
const CENTER_CORE_RADIUS_KM = 500;

// 地球の平均半径 [km]。
const EARTH_RADIUS_KM = 6371;
const CAP_KM_PER_PX = (2 * Math.sin((CAP_RADIUS * Math.PI) / 180) * EARTH_RADIUS_KM) / CAP_W;
// 全球面の 1 texel が張る地表距離 [km]。経度方向は緯度の余弦で縮む。
const GLOBE_KM_PER_PX = 40075 / GLOBE_W;
// 横の縮みを補正する緯度の上限 [°]。極では補正が発散するので、判定に使わない緯度で止める。
const SCALE_LATITUDE_LIMIT = 80;
// 正距円筒の全球が張る範囲 [°]。
const GLOBE_EXTENT = { north: 90, south: -90, west: -180, east: 180 };

// 場の G(雲頂高度)が張る高さ [m]。tools/cloud-lab/views.ts の CLOUD_TOP_SPAN と対。
const CLOUD_TOP_SPAN = 15000;

// 台風の径方向プロファイル。中心からの距離を PROFILE_BIN_KM 刻みで PROFILE_MAX_KM まで方位平均する。
const PROFILE_BIN_KM = 50;
const PROFILE_MAX_KM = 1000;
// 中間調と見なす被覆率の範囲。台風の中心濃密雲域の外(PROFILE_MAX_KM まで)で、この範囲の texel の
// 割合を出す。
const MID_TONE_MIN = 0.06;
const MID_TONE_MAX = 0.25;

// 構造テンソルを取る尺度 [km]。全球は総観規模から上、cap は積雲の粒から総観規模まで。
const GLOBE_SCALES_KM = [100, 200, 400, 800];
const CAP_SCALES_KM = [25, 50, 100, 200, 400];
// 向きの画像を残す尺度 [km]。
const GLOBE_IMAGE_SCALES_KM = [200, 800];
const CAP_IMAGE_SCALES_KM = [50, 200];
// 構造の表に並べる場(写しの鍵と見出し)。
const STRUCTURE_FIELDS = [
  { key: 'thick', label: '実写厚' },
  { key: 'coverage', label: '被覆率' },
  { key: 'veil', label: '実写薄' },
  { key: 'translucent', label: '薄い雲' },
];

// 全球面で統計を取る緯度帯 [°]。
const BANDS = [
  { label: '35-60°N', north: 60, south: 35 },
  { label: '10°S-10°N', north: 10, south: -10 },
  { label: '35-60°S', north: -35, south: -60 },
];

// 地形との関係を読む箱 [°]。風上・風下の対で並べ、最後に対を持たない乾燥地帯を置く。
const TERRAIN_BOXES = [
  { label: 'チリ沿岸(20-35S 76-71W)', north: -20, south: -35, west: -76, east: -71 },
  { label: 'アンデス東(20-35S 68-63W)', north: -20, south: -35, west: -68, east: -63 },
  { label: '南ア西岸(25-33S 15-19E)', north: -25, south: -33, west: 15, east: 19 },
  { label: '南ア東岸(25-33S 29-33E)', north: -25, south: -33, west: 29, east: 33 },
  { label: 'パタゴニア西(40-50S 76-72W)', north: -40, south: -50, west: -76, east: -72 },
  { label: 'パタゴニア東(40-50S 70-65W)', north: -40, south: -50, west: -70, east: -65 },
  { label: 'ヒマラヤ南麓(22-28N 80-95E)', north: 28, south: 22, west: 80, east: 95 },
  { label: 'チベット(30-36N 80-95E)', north: 36, south: 30, west: 80, east: 95 },
  { label: 'サハラ(18-28N 0-25E)', north: 28, south: 18, west: 0, east: 25 },
  { label: '中央アジア(38-46N 55-85E)', north: 46, south: 38, west: 55, east: 85 },
];

// 分離済みの成分(原寸の正距円筒)を file(リポジトリ相対)から読む。無ければ、先に走らせる手順を
// 添えて投げる。
function loadSeparated(file) {
  try {
    return decodeRedPng(readFileSync(path.join(root, file)));
  } catch (e) {
    throw new Error(`${file} を読めない — 先に npm run cloud-lab:separate を実行する (${e.message})`, { cause: e });
  }
}

// 全球面への箱の縮小(整数倍を前提にした平均)。
function downsampleTo(field, width, height) {
  const factor = Math.round(field.width / width);
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          sum += field.data[(y * factor + dy) * field.width + (x * factor + dx)];
        }
      }
      out[y * width + x] = sum / (factor * factor);
    }
  }
  return { width, height, data: out };
}

// 経度で巻き付く双一次標本化。u, v は texel 座標。
function sampleBilinear(field, u, v) {
  const x0 = Math.floor(u);
  const y0 = Math.min(field.height - 2, Math.max(0, Math.floor(v)));
  const fx = u - x0;
  const fy = Math.min(1, Math.max(0, v - y0));
  const xa = ((x0 % field.width) + field.width) % field.width;
  const xb = (xa + 1) % field.width;
  const row0 = y0 * field.width;
  const row1 = (y0 + 1) * field.width;
  return (field.data[row0 + xa] * (1 - fx) + field.data[row0 + xb] * fx) * (1 - fy)
    + (field.data[row1 + xa] * (1 - fx) + field.data[row1 + xb] * fx) * fy;
}

// cap の面(正射影)の中央 362×362 を、緯度 extent.north..south・経度 extent.west..east [°] を張る
// 正距円筒の場から再標本化する。cap は extent の内側に収まっていること。式は
// src/render/field-projection.ts の OrthographicCap / equirectUvFromDirection と対。
function resampleCap(field, extent, latitudeDeg, longitudeDeg) {
  const latitude = (latitudeDeg * Math.PI) / 180;
  const longitude = (longitudeDeg * Math.PI) / 180;
  const cosLat = Math.cos(latitude);
  const sinLat = Math.sin(latitude);
  const cosLon = Math.cos(longitude);
  const sinLon = Math.sin(longitude);
  const center = [cosLat * sinLon, sinLat, cosLat * cosLon];
  const east = [cosLon, 0, -sinLon];
  const north = [-sinLat * sinLon, cosLat, -sinLat * cosLon];
  const sinRadius = Math.sin((CAP_RADIUS * Math.PI) / 180);
  const margin = (CAP_W - CAP_BOX) / 2;
  const out = new Float32Array(CAP_BOX * CAP_BOX);
  for (let by = 0; by < CAP_BOX; by++) {
    const v = (margin + by + 0.5) / CAP_W;
    for (let bx = 0; bx < CAP_BOX; bx++) {
      const u = (margin + bx + 0.5) / CAP_W;
      const px = (u * 2 - 1) * sinRadius;
      const py = (1 - v * 2) * sinRadius;
      const along = Math.sqrt(Math.max(1 - px * px - py * py, 0));
      const dir = [
        east[0] * px + north[0] * py + center[0] * along,
        east[1] * px + north[1] * py + center[1] * along,
        east[2] * px + north[2] * py + center[2] * along,
      ];
      const dirLatitude = Math.asin(Math.min(1, Math.max(-1, dir[1]))) * (180 / Math.PI);
      const dirLongitude = Math.atan2(dir[0], dir[2]) * (180 / Math.PI);
      const eu = (dirLongitude - extent.west) / (extent.east - extent.west);
      const ev = (extent.north - dirLatitude) / (extent.north - extent.south);
      out[by * CAP_BOX + bx] = sampleBilinear(field, eu * field.width - 0.5, ev * field.height - 0.5);
    }
  }
  return { width: CAP_BOX, height: CAP_BOX, data: out };
}

// 場をグレースケール PNG として .cloud-lab/compare/ へ書く。
function saveGray(name, field) {
  writeFileSync(path.join(outDir, name), fieldToGrayPng(field));
}

// 平均と、TONE_LEVELS で区切った段ごとの割合 shares(下から順)、その両端 — 晴れ(< CLEAR_LEVEL)の
// 割合 low と真っ白(> WHITE_LEVEL)の割合 high — そして 8bit の両端へ張り付いた割合 zero(= 0)と
// full(= 1)。張り付きは伝達関数が階調を捨てた印で、段の割合からは読めない。
function toneStats(field) {
  const counts = new Float64Array(TONE_LEVELS.length + 1);
  let sum = 0;
  let zero = 0;
  let full = 0;
  for (const v of field.data) {
    let bin = 0;
    while (bin < TONE_LEVELS.length && v >= TONE_LEVELS[bin]) bin++;
    counts[bin]++;
    sum += v;
    if (v <= 0) zero++;
    if (v >= 1) full++;
  }
  const n = field.data.length;
  const shares = Array.from(counts, (count) => count / n);
  const clearBins = TONE_LEVELS.indexOf(CLEAR_LEVEL) + 1;
  return {
    shares,
    low: shares.slice(0, clearBins).reduce((a, b) => a + b, 0),
    high: shares[TONE_LEVELS.indexOf(WHITE_LEVEL) + 1],
    zero: zero / n,
    full: full / n,
    mean: sum / n,
  };
}

// 各 texel の周り window² の標準偏差。窓の統計は積算表から引くので、窓の広さに依らず一定の手数で済む。
function windowDeviations(field, window) {
  const { width, height, data } = field;
  const stride = width + 1;
  const sum = new Float64Array(stride * (height + 1));
  const sumSquared = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = data[y * width + x];
      const i = (y + 1) * stride + (x + 1);
      sum[i] = v + sum[i - 1] + sum[i - stride] - sum[i - stride - 1];
      sumSquared[i] = v * v + sumSquared[i - 1] + sumSquared[i - stride] - sumSquared[i - stride - 1];
    }
  }
  const boxSum = (table, x0, y0, x1, y1) => table[(y1 + 1) * stride + x1 + 1] - table[y0 * stride + x1 + 1]
    - table[(y1 + 1) * stride + x0] + table[y0 * stride + x0];
  const radius = (window - 1) / 2;
  const out = new Float32Array(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius);
      const y0 = Math.max(0, y - radius);
      const x1 = Math.min(width - 1, x + radius);
      const y1 = Math.min(height - 1, y + radius);
      const count = (x1 - x0 + 1) * (y1 - y0 + 1);
      const mean = boxSum(sum, x0, y0, x1, y1) / count;
      const variance = boxSum(sumSquared, x0, y0, x1, y1) / count - mean * mean;
      out[y * width + x] = Math.sqrt(Math.max(variance, 0));
    }
  }
  return out;
}

// 平坦な灰色の割合。中間の暗い階調(FLAT_VALUE_MIN..FLAT_VALUE_MAX)にいて、周り
// FLATNESS_WINDOW² の標準偏差が FLAT_DEVIATION 未満の texel の割合。
function flatnessOf(field) {
  const deviations = windowDeviations(field, FLATNESS_WINDOW);
  let flat = 0;
  for (let i = 0; i < field.data.length; i++) {
    const v = field.data[i];
    if (v >= FLAT_VALUE_MIN && v <= FLAT_VALUE_MAX && deviations[i] < FLAT_DEVIATION) flat++;
  }
  return flat / field.data.length;
}

// 局所コントラスト: 周り CONTRAST_WINDOW² の標準偏差の全 texel 平均。
function localContrastOf(field) {
  const deviations = windowDeviations(field, CONTRAST_WINDOW);
  let sum = 0;
  for (const deviation of deviations) sum += deviation;
  return sum / deviations.length;
}

// 全球面の行 y・列 x の texel の中心の緯度・経度 [rad]。
function latitudeOfRow(y, height) {
  return (0.5 - (y + 0.5) / height) * Math.PI;
}
function longitudeOfColumn(x, width) {
  return ((x + 0.5) / width - 0.5) * 2 * Math.PI;
}

// 2 点(緯度・経度 [rad])の中心角 [rad]。
function centralAngle(latitude, longitude, otherLatitude, otherLongitude) {
  const cosAngle = Math.sin(latitude) * Math.sin(otherLatitude)
    + Math.cos(latitude) * Math.cos(otherLatitude) * Math.cos(longitude - otherLongitude);
  return Math.acos(Math.min(1, Math.max(-1, cosAngle)));
}

// 全球面の風の速さ [m/s] の最大と 99 パーセンタイル。熱帯低気圧 tropical(緯度・経度 [rad]。居なければ
// null)の中心から TROPICAL_EXCLUDE_DEG 以内は数えない。speed は地表の風ビューの B(速さ / WIND_SPAN)。
function windAnomaly(speed, tropical) {
  const exclude = (TROPICAL_EXCLUDE_DEG * Math.PI) / 180;
  const speeds = [];
  for (let y = 0; y < speed.height; y++) {
    const latitude = latitudeOfRow(y, speed.height);
    for (let x = 0; x < speed.width; x++) {
      const longitude = longitudeOfColumn(x, speed.width);
      if (tropical !== null && centralAngle(latitude, longitude, tropical.latitude, tropical.longitude) < exclude) continue;
      speeds.push(speed.data[y * speed.width + x] * WIND_SPAN);
    }
  }
  speeds.sort((a, b) => a - b);
  return { max: speeds[speeds.length - 1], p99: quantile(speeds, 0.99) };
}

// 行方向の 1 次元パワースペクトルをオクターブ束(波数 1-2, 2-4, ...)で。行は 1 本おきに間引く。
function rowSpectrum(field) {
  const { width, height, data } = field;
  const power = new Float64Array(Math.floor(width / 2));
  let rows = 0;
  for (let y = 0; y < height; y += 2) {
    const row = data.subarray(y * width, (y + 1) * width);
    let mean = 0;
    for (const v of row) mean += v;
    mean /= width;
    for (let k = 1; k < width / 2; k++) {
      let re = 0;
      let im = 0;
      const angle = (2 * Math.PI * k) / width;
      for (let x = 0; x < width; x++) {
        const v = row[x] - mean;
        re += v * Math.cos(angle * x);
        im -= v * Math.sin(angle * x);
      }
      power[k] += (re * re + im * im) / (width * width);
    }
    rows++;
  }
  const octaves = [];
  for (let k0 = 1; k0 < width / 2; k0 *= 2) {
    let sum = 0;
    for (let k = k0; k < Math.min(k0 * 2, width / 2); k++) sum += power[k];
    octaves.push({ k0, k1: Math.min(k0 * 2, Math.floor(width / 2)), value: sum / rows });
  }
  return octaves;
}

// 緯度 [°] → 全球面の行。
function rowAtLatitude(latitude) {
  return Math.round(((90 - latitude) / 180) * HEIGHT);
}

// 正距円筒の場を width × height の格子へ双一次で載せ替える。
function resampleEquirect(field, width, height) {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const v = ((y + 0.5) / height) * field.height - 0.5;
    for (let x = 0; x < width; x++) {
      out[y * width + x] = sampleBilinear(field, ((x + 0.5) / width) * field.width - 0.5, v);
    }
  }
  return { width, height, data: out };
}

// 行ごとの平均を引いた偏差。緯度で決まる分を落として、地理的な偏りだけを残す。
function zonalDeviation(field) {
  const out = new Float32Array(field.data.length);
  for (let y = 0; y < field.height; y++) {
    const row = y * field.width;
    let mean = 0;
    for (let x = 0; x < field.width; x++) mean += field.data[row + x];
    mean /= field.width;
    for (let x = 0; x < field.width; x++) out[row + x] = field.data[row + x] - mean;
  }
  return { width: field.width, height: field.height, data: out };
}

// 同じ大きさの 2 つの場のピアソン相関。
function correlation(a, b) {
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < a.data.length; i++) {
    meanA += a.data[i];
    meanB += b.data[i];
  }
  meanA /= a.data.length;
  meanB /= b.data.length;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let i = 0; i < a.data.length; i++) {
    const da = a.data[i] - meanA;
    const db = b.data[i] - meanB;
    covariance += da * db;
    varianceA += da * da;
    varianceB += db * db;
  }
  return covariance / Math.sqrt(varianceA * varianceB + 1e-30);
}

// 場の尺度ごとの構造テンソル(尺度 [km] → テンソル)。rowKmPerPx は行ごとの横 1 px の地表距離 [km]。
function structuresOf(field, rowKmPerPx, kmPerPxY, wrapX, scales) {
  return new Map(scales.map((scale) => [scale, structureTensor(field, rowKmPerPx, kmPerPxY, wrapX, scale)]));
}

// 1 つの面の構造を尺度ごとに並べる。rows は { scale, cells } で、cells は STRUCTURE_FIELDS と同じ並び。
// レポート用に、場のキーと組にした同じ値を返す。
function printStructureTable(header, rows) {
  console.log(header);
  console.log(`尺度[km]  ${STRUCTURE_FIELDS.map((field) => `${field.label} 伸び/揃い/向き`).join('    ')}`);
  for (const { scale, cells } of rows) {
    const columns = cells.map((cell) =>
      `${cell.coherence.toFixed(2)} ${cell.r.toFixed(2)} ${cell.orientationDeg.toFixed(0).padStart(3)}°`);
    console.log(`${String(scale).padStart(5)}     ${columns.join('       ')}`);
  }
  return rows.map(({ scale, cells }) => ({
    scaleKm: scale,
    fields: STRUCTURE_FIELDS.map((field, index) => ({ field: field.key, ...cells[index] })),
  }));
}

// 実写と生成のオクターブ束スペクトルを波長帯ごとに並べ、比を添えて出す。wavelengthOf は
// 波数 → 波長 [km]。レポート用に、波長帯と組にした同じ値を返す。
function printSpectrumTable(header, wavelengthOf, reference, generated, referenceLabel, generatedLabel) {
  console.log(header);
  console.log(`波長帯 [km]      ${referenceLabel}   ${generatedLabel}   比(生成/実写)`);
  const buckets = [];
  for (let i = 0; i < reference.length; i++) {
    const coarse = wavelengthOf(reference[i].k0);
    const fine = wavelengthOf(reference[i].k1);
    console.log(
      `${fine.toFixed(0).padStart(5)}-${coarse.toFixed(0).padStart(5)}  ${reference[i].value.toExponential(2)}  `
      + `${generated[i].value.toExponential(2)}  ${(generated[i].value / reference[i].value).toFixed(3)}`);
    buckets.push({
      wavelengthKm: [fine, coarse],
      reference: reference[i].value,
      generated: generated[i].value,
      ratio: generated[i].value / reference[i].value,
    });
  }
  return buckets;
}

// 階調の表。rows は { label, field, source }(source は張り付きを数える元の場。既定は field)。
// TONE_LEVELS で区切った段ごとの割合 [%]、平均、局所コントラスト、
// 晴れ(< CLEAR_LEVEL)と真っ白(> WHITE_LEVEL)の割合 [%]、8bit の両端へ張り付いた割合 [%] を
// 場ごとに 1 行で出す。レポート用に、割合は % でなく 0..1 のまま返す(row に key があれば一緒に)。
function printToneTable(header, rows) {
  console.log(header);
  const marks = TONE_LEVELS.map((level) => level.toFixed(2).slice(1));
  const bins = [`<${marks[0]}`, ...marks.slice(0, -1).map((mark, i) => `${mark}-${marks[i + 1]}`), `>${marks.at(-1)}`];
  console.log(`${'場'.padEnd(12)}  ${bins.map((bin) => bin.padStart(8)).join('')}`
    + `   平均  局所コントラスト  晴れ<${CLEAR_LEVEL}  >${WHITE_LEVEL}  黒潰れ=0  白飛び=1`);
  const recorded = [];
  for (const { label, field, source, key } of rows) {
    const tone = toneStats(field);
    const ends = source === undefined ? tone : toneStats(source);
    const contrast = localContrastOf(field);
    console.log(`${label.padEnd(12)}  ${tone.shares.map((share) => (share * 100).toFixed(1).padStart(8)).join('')}`
      + `  ${tone.mean.toFixed(3)}  ${contrast.toFixed(4).padStart(14)}`
      + `  ${(tone.low * 100).toFixed(1).padStart(8)}%  ${(tone.high * 100).toFixed(1).padStart(5)}%`
      + `  ${(ends.zero * 100).toFixed(1).padStart(7)}%  ${(ends.full * 100).toFixed(1).padStart(7)}%`);
    recorded.push({
      label, key: key ?? null, shares: tone.shares, mean: tone.mean, contrast,
      clear: tone.low, white: tone.high, crushed: ends.zero, clipped: ends.full,
    });
  }
  return recorded;
}

// 帯(緯度 north..south [°])の圧縮を昇順の 3 組に分ける。all は帯の全 texel、background はどの
// 低気圧の中心からも BACKGROUND_KM より遠い texel、ring は最盛期(深さ ≥ RING_MATURITY_HPA)の中心から
// RING_INNER_KM..RING_OUTER_KM の texel。
function compressionInBand(compression, band, lows) {
  const { width, height, data } = compression;
  const mature = lows.filter((low) => low.depth >= RING_MATURITY_HPA);
  const all = [];
  const background = [];
  const ring = [];
  for (let y = rowAtLatitude(band.north); y < rowAtLatitude(band.south); y++) {
    const latitude = latitudeOfRow(y, height);
    for (let x = 0; x < width; x++) {
      const longitude = longitudeOfColumn(x, width);
      const distanceTo = (low) => centralAngle(latitude, longitude, low.latitude, low.longitude) * EARTH_RADIUS_KM;
      const inRing = (low) => {
        const km = distanceTo(low);
        return km >= RING_INNER_KM && km <= RING_OUTER_KM;
      };
      const v = data[y * width + x];
      all.push(v);
      if (lows.every((low) => distanceTo(low) > BACKGROUND_KM)) background.push(v);
      if (mature.some(inRing)) ring.push(v);
    }
  }
  const ascending = (values) => values.sort((a, b) => a - b);
  return { all: ascending(all), background: ascending(background), ring: ascending(ring) };
}

// 場の中心からの距離を PROFILE_BIN_KM 刻みで PROFILE_MAX_KM まで方位平均した値の列(全 texel の平均)。
function radialProfile(field, kmPerPx) {
  const bins = PROFILE_MAX_KM / PROFILE_BIN_KM;
  const sums = new Float64Array(bins);
  const counts = new Float64Array(bins);
  const centerX = (field.width - 1) / 2;
  const centerY = (field.height - 1) / 2;
  for (let y = 0; y < field.height; y++) {
    for (let x = 0; x < field.width; x++) {
      const bin = Math.floor((Math.hypot(x - centerX, y - centerY) * kmPerPx) / PROFILE_BIN_KM);
      if (bin >= bins) continue;
      sums[bin] += field.data[y * field.width + x];
      counts[bin]++;
    }
  }
  return Array.from(sums, (sum, bin) => sum / Math.max(1, counts[bin]));
}

// 場の中心から innerKm..outerKm [km] の texel のうち、値が min..max のものの割合。
function annulusShare(field, kmPerPx, innerKm, outerKm, min, max) {
  const centerX = (field.width - 1) / 2;
  const centerY = (field.height - 1) / 2;
  let inside = 0;
  let matched = 0;
  for (let y = 0; y < field.height; y++) {
    for (let x = 0; x < field.width; x++) {
      const km = Math.hypot(x - centerX, y - centerY) * kmPerPx;
      if (km < innerKm || km > outerKm) continue;
      inside++;
      const v = field.data[y * field.width + x];
      if (v >= min && v <= max) matched++;
    }
  }
  return matched / Math.max(1, inside);
}

// 径方向プロファイルを刻みごとに並べる。columns は { label, values, digits }。
// レポート用に、列ごとの値の並びも返す。
function printRadialTable(header, columns) {
  console.log(header);
  console.log(`距離 [km]   ${columns.map((column) => column.label.padStart(8)).join('  ')}`);
  for (let bin = 0; bin < PROFILE_MAX_KM / PROFILE_BIN_KM; bin++) {
    const cells = columns.map((column) => column.values[bin].toFixed(column.digits).padStart(8));
    const range = `${String(bin * PROFILE_BIN_KM).padStart(4)}-${String((bin + 1) * PROFILE_BIN_KM).padStart(4)}`;
    console.log(`${range}   ${cells.join('  ')}`);
  }
  return columns.map((column) => ({ label: column.label, values: Array.from(column.values) }));
}

// 差分の表示用の数値の整形。スペクトルのような小さな値と雲頂 [m] のような大きな値が混ざるので、
// 桁の端では指数表記へ倒し、それ以外は有効数字 6 桁で丸める。
function formatDiffValue(value) {
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude < 1e-4 || magnitude >= 1e6)) return value.toExponential(3);
  return String(Number(value.toPrecision(6)));
}

// 2 つのレポートの sections を辿り、両方にある数値のリーフについて { path, before, after } を集める。
// 形が変わった(節やキーの増減)ものは数えない — 形の変更は差分でなく版の変更として扱う。
function collectNumericDiffs(before, after, path, out) {
  if (typeof before === 'number' && typeof after === 'number') {
    out.compared++;
    if (before !== after) out.changed.push({ path, before, after });
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    for (let i = 0; i < Math.min(before.length, after.length); i++) {
      collectNumericDiffs(before[i], after[i], `${path}[${i}]`, out);
    }
    return;
  }
  if (before !== null && after !== null && typeof before === 'object' && typeof after === 'object') {
    for (const key of Object.keys(before)) {
      if (key in after) collectNumericDiffs(before[key], after[key], path === '' ? key : `${path}.${key}`, out);
    }
  }
}

// レポートへ焼く、いまの HEAD の短い SHA。git が読めない環境では unknown として、比較自体は止めない。
function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

// 2 つの時刻の場の移流。bestShift のずらし [texel] を [m/s] へ換算し、渡された平均風
// (null なら風との比較をしない)との向きの差と速さ比を添える。箱の実物の動きと生成の動きを
// 同じ定義で測るためのもので、全球面の帯の移流は従来どおり main の中で測る。
function driftOf(a, b, lagHours, kmPerTexelX, kmPerTexelY, wind) {
  const shift = bestShift(a, b, DRIFT_MAX_DX, DRIFT_MAX_DY);
  const driftEast = (shift.dx * kmPerTexelX * 1000) / (lagHours * 3600);
  const driftNorth = (-shift.dy * kmPerTexelY * 1000) / (lagHours * 3600);
  const driftSpeed = Math.hypot(driftEast, driftNorth);
  if (wind === null) {
    return {
      shiftTexels: [shift.dx, shift.dy],
      correlation: shift.correlation,
      driftMs: { east: driftEast, north: driftNorth },
      driftSpeedMs: driftSpeed,
      windMs: null,
      windSpeedMs: null,
      angleDeg: null,
      speedRatio: null,
    };
  }
  const windSpeed = Math.hypot(wind.east, wind.north);
  const angleDeg = driftSpeed > 0 && windSpeed > 0
    ? (Math.acos(Math.min(1, Math.max(-1, (driftEast * wind.east + driftNorth * wind.north)
      / (driftSpeed * windSpeed)))) * 180) / Math.PI
    : null;
  return {
    shiftTexels: [shift.dx, shift.dy],
    correlation: shift.correlation,
    driftMs: { east: driftEast, north: driftNorth },
    driftSpeedMs: driftSpeed,
    windMs: wind,
    windSpeedMs: windSpeed,
    angleDeg,
    speedRatio: windSpeed > 0 ? driftSpeed / windSpeed : null,
  };
}

// sRGB の 8bit 値 → 線形の 0..1。
function linearOf(srgb) {
  const c = srgb / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

// 8bit・非インターレースの RGB / RGBA の PNG を、線形化した R・G・B の平均(輝度 0..1)の場で返す。
function decodeLuminancePng(png) {
  const { width, height, channels, data } = decodePng(png);
  const out = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const p = i * channels;
    out[i] = (linearOf(data[p]) + linearOf(data[p + 1]) + linearOf(data[p + 2])) / 3;
  }
  return { width, height, data: out };
}

async function main() {
  // 分離済みの成分を先に読む(無いなら撮影の前に気付かせる)。仮テクスチャは R が被覆率。
  const separatedThick = loadSeparated(path.join('src', 'assets', 'cloud-field.png'));
  const separatedVeil = loadSeparated(path.join('.cloud-lab', 'separated', 'veil.png'));
  // 気候の事前分布(G が平年の雲量、B が標高)。天気のモデルが読んでいるものと同じ写し。
  const climate = readFileSync(path.join(root, 'src', 'assets', 'earth-climate.png'));
  const meanCloudiness = resampleEquirect(decodeChannelPng(climate, 1), GLOBE_W, HEIGHT);
  const elevation = resampleEquirect(decodeChannelPng(climate, 2), GLOBE_W, HEIGHT);

  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-cloud-compare-', onEvent,
    // 並走する Chrome があると最初の評価だけで 60 秒を超えることがある。
    // 撮影ツールと同じ 300 秒にする。
    requestTimeoutMs: 300_000,
  });
  const shots = new Map();
  // 時刻 0 の低気圧の谷の配置(緯度・経度 [rad]、深さ [hPa]、半径 [m])。ページの進路モジュールから引く。
  let cyclonesAtZero;
  // 動きの計測用の追加撮影の受け皿。全球の被覆率の時系列と、熱帯低気圧の解析配置の時系列、
  // 解析中心へ合わせた cap の被覆率。合成ビューも同じ時刻で撮る — 実物は衛星の見た輝度なので、
  // 被覆率ではなく描画そのものの輝度と比べる。
  let motionCoverage;
  let motionComposite;
  let cycloneTrack;
  let cycloneCenters;
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/?capture-only` });
    await waitFor(
      devTools,
      "(document.getElementById('error')?.textContent || typeof window.cloudLab === 'object')",
      'the cloud lab to initialise',
    );
    const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
    if (failure) throw new Error(`Cloud lab failed to initialise: ${failure}`);

    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    await devTools.evaluate('window.cloudLab.setTime(0)');
    cyclonesAtZero = JSON.parse(await devTools.evaluate('JSON.stringify(window.cloudLab.cyclonesAt(0))'));
    for (const region of REGIONS) {
      await devTools.evaluate(
        `window.cloudLab.aimCap(${region.latitude}, ${region.longitude}, ${CAP_RADIUS})`);
      for (const view of VIEWS) {
        await devTools.evaluate(`window.cloudLab.show(${JSON.stringify(view)})`);
        const dataUrl = await devTools.evaluate('window.cloudLab.capture()');
        const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
        writeFileSync(path.join(outDir, `${region.name}-${view}.png`), png);
        shots.set(`${region.name}-${view}`, decodeRedPng(png));
        console.log(`shot ${region.name} ${view}`);
      }
    }

    // 動きの計測用の追加撮影。被覆率の全球面をサンプル時刻ごとに撮る。熱帯低気圧の cap は
    // 解析中心へ照準を合わせ直して撮るので、地域別の撮影が終わってから行う (照準が移る)。
    motionCoverage = new Map();
    await devTools.evaluate("window.cloudLab.show('coverage')");
    for (const hours of MOTION_SAMPLE_HOURS) {
      await devTools.evaluate(`window.cloudLab.setTime(${hours})`);
      const dataUrl = await devTools.evaluate('window.cloudLab.capture()');
      const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
      motionCoverage.set(hours, cropField(decodeRedPng(png), 0, 0, GLOBE_W, HEIGHT));
      console.log(`shot motion coverage at ${hours} h`);
    }
    motionComposite = new Map();
    await devTools.evaluate("window.cloudLab.show('composite')");
    for (const hours of MOTION_SAMPLE_HOURS) {
      await devTools.evaluate(`window.cloudLab.setTime(${hours})`);
      const dataUrl = await devTools.evaluate('window.cloudLab.capture()');
      const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
      motionComposite.set(hours, cropField(decodeRedPng(png), 0, 0, GLOBE_W, HEIGHT));
      console.log(`shot motion composite at ${hours} h`);
    }
    cycloneTrack = JSON.parse(await devTools.evaluate(
      `JSON.stringify([${TRACK_SAMPLE_HOURS.join(',')}].map((hours) => ({ hours, ...window.cloudLab.cyclonesAt(hours) })))`));
    // 中心のずれは被覆率の重心で測るので、ビューを coverage へ戻す(composite の撮影の後)。
    await devTools.evaluate("window.cloudLab.show('coverage')");
    cycloneCenters = new Map();
    const capBoxX = GLOBE_W + (CAP_W - CAP_BOX) / 2;
    const capBoxY = (HEIGHT - CAP_BOX) / 2;
    for (const hours of CENTER_SAMPLE_HOURS) {
      const tropical = cycloneTrack.find((entry) => entry.hours === hours)?.tropical;
      if (!tropical) continue;
      await devTools.evaluate(`window.cloudLab.setTime(${hours})`);
      await devTools.evaluate(
        `window.cloudLab.aimCap(${(tropical.latitude * 180) / Math.PI}, ${(tropical.longitude * 180) / Math.PI}, ${CAP_RADIUS})`);
      const dataUrl = await devTools.evaluate('window.cloudLab.capture()');
      const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
      cycloneCenters.set(hours, cropField(decodeRedPng(png), capBoxX, capBoxY, CAP_BOX, CAP_BOX));
      console.log(`shot cyclone center at ${hours} h`);
    }
    if (fatalEvents.length > 0) throw new Error(`Page reported errors during shooting:\n${fatalEvents.join('\n')}`);
  } finally {
    await session.close();
  }

  // 全球面はどの撮影にも同じものが写っているので、先頭の地域の 1 枚から取る。
  const globeOf = (view) => cropField(shots.get(`${REGIONS[0].name}-${view}`), 0, 0, GLOBE_W, HEIGHT);
  // 薄い雲ビューの表示値は光学的厚み τ そのもの。実写の veil(輝度)と比べるため 1 − e^(−τ) へ。
  const brightnessOf = (field) => ({
    width: field.width, height: field.height, data: Float32Array.from(field.data, (t) => 1 - Math.exp(-t)),
  });

  const globe = {
    photo: globeOf('photo'),
    thick: downsampleTo(separatedThick, GLOBE_W, HEIGHT),
    veil: downsampleTo(separatedVeil, GLOBE_W, HEIGHT),
    coverage: globeOf('coverage'),
    translucent: brightnessOf(globeOf('translucent')),
    composite: globeOf('composite'),
  };
  saveGray('globe-thick.png', globe.thick);
  saveGray('globe-veil.png', globe.veil);
  // 地表の風だけは B(速さ)を読むので、書いた PNG から取り直す。動きの節では R(東西)・
  // G(南北)の成分も要る — 符号の規約は tools/cloud-lab/views.ts の windColor と対で、
  // 成分 = (値 − 0.5) × 2 × WIND_SPAN [m/s]。
  const windPng = readFileSync(path.join(outDir, `${REGIONS[0].name}-surfaceWind.png`));
  const windSpeed = cropField(decodeChannelPng(windPng, 2), 0, 0, GLOBE_W, HEIGHT);
  const windEast = cropField(decodeChannelPng(windPng, 0), 0, 0, GLOBE_W, HEIGHT);
  const windNorth = cropField(decodeChannelPng(windPng, 1), 0, 0, GLOBE_W, HEIGHT);

  // 雲頂ビューの表示値は 0..CLOUD_TOP_SPAN を 0..1 に載せたもの。分位は [m] で取る。
  const metresOf = (field) => ({
    width: field.width, height: field.height, data: Float32Array.from(field.data, (v) => v * CLOUD_TOP_SPAN),
  });

  const boxX0 = GLOBE_W + (CAP_W - CAP_BOX) / 2;
  const boxY0 = (HEIGHT - CAP_BOX) / 2;
  const caps = new Map();
  const capTops = new Map();
  for (const region of REGIONS) {
    const thick = resampleCap(separatedThick, GLOBE_EXTENT, region.latitude, region.longitude);
    const veil = resampleCap(separatedVeil, GLOBE_EXTENT, region.latitude, region.longitude);
    saveGray(`${region.name}-thick.png`, thick);
    saveGray(`${region.name}-veil.png`, veil);
    caps.set(region.name, {
      photo: cropField(shots.get(`${region.name}-photo`), boxX0, boxY0, CAP_BOX, CAP_BOX),
      thick,
      veil,
      coverage: cropField(shots.get(`${region.name}-coverage`), boxX0, boxY0, CAP_BOX, CAP_BOX),
      translucent: brightnessOf(cropField(shots.get(`${region.name}-translucent`), boxX0, boxY0, CAP_BOX, CAP_BOX)),
      composite: cropField(shots.get(`${region.name}-composite`), boxX0, boxY0, CAP_BOX, CAP_BOX),
    });
    capTops.set(region.name, metresOf(cropField(shots.get(`${region.name}-cloudTop`), boxX0, boxY0, CAP_BOX, CAP_BOX)));
  }

  // レポートの器。以後の節は、表へ出したのと同じ値をここへも溜める。
  const report = {
    meta: {
      tool: 'cloud-lab-compare',
      reportVersion: 1,
      generatedAt: new Date().toISOString(),
      gitHead: gitHead(),
      regions: REGIONS.map((region) => region.name),
      views: VIEWS,
    },
    sections: {},
  };

  console.log('\n=== 帯状平均(全球面・5.625° 刻み) ===');
  console.log('緯度      実写計  実写厚  実写薄  被覆率  薄い雲  合成   被覆率/実写厚');
  const zonal = [];
  for (let band = 0; band < 32; band++) {
    const latitude = 90 - (band + 0.5) * 5.625;
    const rowMeans = Object.fromEntries(Object.entries(globe).map(([key, field]) =>
      [key, toneStats(cropField(field, 0, band * 16, GLOBE_W, 16)).mean]));
    const coveragePerThick = rowMeans.coverage / Math.max(1e-6, rowMeans.thick);
    console.log(
      `${latitude.toFixed(1).padStart(6)}°  ${rowMeans.photo.toFixed(3)}  ${rowMeans.thick.toFixed(3)}  `
      + `${rowMeans.veil.toFixed(3)}  ${rowMeans.coverage.toFixed(3)}  ${rowMeans.translucent.toFixed(3)}  `
      + `${rowMeans.composite.toFixed(3)}  ${coveragePerThick.toFixed(2)}`);
    zonal.push({ latitudeDeg: latitude, means: rowMeans, coveragePerThick });
  }
  report.sections.zonal = zonal;

  const y60 = rowAtLatitude(60);
  const bandHeight = rowAtLatitude(-60) - y60;
  // 薄い雲は輝度へ写したものを比べるので、張り付きは写す前の光学的厚み(撮影そのもの)で数える。
  const TONE_FIELDS = [['実写計', 'photo'], ['合成', 'composite'], ['実写厚', 'thick'],
    ['被覆率', 'coverage'], ['実写薄', 'veil'], ['薄い雲(輝度)', 'translucent', globeOf('translucent')]];
  report.sections.toneGlobe = printToneTable(
    `\n=== 階調(全球面・±60°): 段ごとの割合 [%]・平均・局所コントラスト(${CONTRAST_WINDOW}×${CONTRAST_WINDOW} texel の標準偏差の平均)・晴れ・真っ白・張り付き ===`,
    TONE_FIELDS.map(([label, key, source]) => ({
      label,
      key,
      field: cropField(globe[key], 0, y60, GLOBE_W, bandHeight),
      source: source && cropField(source, 0, y60, GLOBE_W, bandHeight),
    })));

  console.log('\n=== のっぺり率(全球面・±60°): 0.06〜0.25 かつ 5×5 texel の標準偏差 < 0.02 ===');
  const flatness = {};
  for (const [label, key] of [['実写計', 'photo'], ['実写厚', 'thick'], ['合成', 'composite'], ['被覆率', 'coverage']]) {
    flatness[key] = flatnessOf(cropField(globe[key], 0, y60, GLOBE_W, bandHeight));
    console.log(`${label}: ${(flatness[key] * 100).toFixed(1)}%`);
  }
  report.sections.flatness = flatness;

  console.log('\n=== 風の異常(全球面・熱帯低気圧の中心 10° 以内を除く) ===');
  const wind = windAnomaly(windSpeed, cyclonesAtZero.tropical);
  console.log(`最大 ${wind.max.toFixed(1)} m/s   99 パーセンタイル ${wind.p99.toFixed(1)} m/s`);
  report.sections.wind = { maxMs: wind.max, p99Ms: wind.p99 };

  console.log('\n=== 圧縮の分位(全球面・前線ビュー、低気圧の帯・時刻 0) ===');
  // 前線ビューの表示値は、圧縮の 1 を超えた分を FRONT_SPAN で割ったもの。
  const front = globeOf('front');
  const compression = {
    width: front.width, height: front.height, data: Float32Array.from(front.data, (v) => v * FRONT_SPAN + 1),
  };
  // 時刻 0 に居る低気圧だけ(居ない枡は null)。
  const lows = cyclonesAtZero.lows.flatMap((low, index) => (low === null ? [] : [{ index, ...low }]));
  console.log('低気圧    緯度      経度   深さ [hPa]  半径 [km]');
  const compressionReport = { lows: [], bands: [] };
  for (const low of lows) {
    const longitudeDeg = ((((low.longitude * 180) / Math.PI + 180) % 360) + 360) % 360 - 180;
    console.log(`${String(low.index).padStart(4)}   ${((low.latitude * 180) / Math.PI).toFixed(1).padStart(6)}°  `
      + `${longitudeDeg.toFixed(1).padStart(6)}°  ${low.depth.toFixed(1).padStart(6)}   ${(low.radius / 1e3).toFixed(0).padStart(6)}`);
    compressionReport.lows.push({
      index: low.index,
      latitudeDeg: (low.latitude * 180) / Math.PI,
      longitudeDeg,
      depthHpa: low.depth,
      radiusKm: low.radius / 1e3,
    });
  }
  console.log(`帯        中央値   90%    99%   背景 90%(中心から >${BACKGROUND_KM} km)`
    + `  環の中央値  環 90%(最盛期の中心から ${RING_INNER_KM}-${RING_OUTER_KM} km)`);
  // 低気圧が置かれる緯度の帯だけを見る。
  for (const band of BANDS.filter((band) => Math.min(Math.abs(band.north), Math.abs(band.south)) >= LOW_BAND_LATITUDE)) {
    const { all, background, ring } = compressionInBand(compression, band, lows);
    const bandStats = {
      band: band.label,
      median: quantile(all, 0.5),
      p90: quantile(all, 0.9),
      p99: quantile(all, 0.99),
      backgroundP90: quantile(background, 0.9),
      ringMedian: quantile(ring, 0.5),
      ringP90: quantile(ring, 0.9),
    };
    console.log(`${band.label}   ${bandStats.median.toFixed(2)}  ${bandStats.p90.toFixed(2)}`
      + `  ${bandStats.p99.toFixed(2)}  ${bandStats.backgroundP90.toFixed(2).padStart(22)}`
      + `  ${bandStats.ringMedian.toFixed(2).padStart(10)}  ${bandStats.ringP90.toFixed(2).padStart(8)}`);
    compressionReport.bands.push(bandStats);
  }
  report.sections.compression = compressionReport;

  console.log('\n=== 行方向スペクトル(全球面)===');
  const spectrumGlobe = [];
  for (const band of BANDS) {
    const y0 = rowAtLatitude(band.north);
    const h = rowAtLatitude(band.south) - y0;
    const circumference = 40075 * Math.cos((((band.north + band.south) / 2) * Math.PI) / 180);
    const wavelengthOf = (k) => circumference / k;
    const bandOf = (key) => rowSpectrum(cropField(globe[key], 0, y0, GLOBE_W, h));
    for (const [referenceKey, generatedKey, referenceLabel, generatedLabel] of [
      ['thick', 'coverage', '実写厚', '被覆率'],
      ['photo', 'composite', '実写計', '合成  '],
      ['veil', 'translucent', '実写薄', '薄い雲'],
    ]) {
      const buckets = printSpectrumTable(
        `--- ${band.label} ---`, wavelengthOf, bandOf(referenceKey), bandOf(generatedKey), referenceLabel, generatedLabel);
      spectrumGlobe.push({ band: band.label, reference: referenceKey, generated: generatedKey, buckets });
    }
  }
  report.sections.spectrumGlobe = spectrumGlobe;

  // 上層の移流が写しの外を読む地域は、薄い雲と合成の値が参考値であることを見出しで断る。
  const capLabelOf = (region) => (region.upperReadsOutside
    ? `${region.label}(薄い雲・合成は参考値: 上層が写しの外を読む)` : region.label);
  const capLabelWidth = Math.max(...REGIONS.map((region) => capLabelOf(region).length));
  console.log('\n=== 地域別 cap(中央 362×362)の平均 ===');
  console.log(`${'地域'.padEnd(capLabelWidth)}  実写計  実写厚  実写薄  被覆率  薄い雲  合成`);
  const capMeans = [];
  for (const region of REGIONS) {
    const cap = caps.get(region.name);
    const means = Object.fromEntries(Object.entries(cap).map(([key, field]) => [key, toneStats(field).mean]));
    console.log(
      `${capLabelOf(region).padEnd(capLabelWidth)}  ${means.photo.toFixed(3)}  ${means.thick.toFixed(3)}  `
      + `${means.veil.toFixed(3)}  ${means.coverage.toFixed(3)}  ${means.translucent.toFixed(3)}  `
      + `${means.composite.toFixed(3)}`);
    capMeans.push({ region: region.name, means });
  }
  report.sections.capMeans = capMeans;

  console.log('\n=== 地域別 cap: 行方向スペクトル(実写厚 vs 被覆率)===');
  const capWavelengthOf = (k) => (CAP_BOX * CAP_KM_PER_PX) / k;
  const capSpectrum = [];
  for (const region of REGIONS) {
    const cap = caps.get(region.name);
    const buckets = printSpectrumTable(
      `--- ${region.label} ---`, capWavelengthOf, rowSpectrum(cap.thick), rowSpectrum(cap.coverage), '実写厚', '被覆率');
    capSpectrum.push({ region: region.name, reference: 'thick', generated: 'coverage', buckets });
  }
  report.sections.capSpectrum = capSpectrum;

  console.log('\n=== 構造の異方性(全球面・帯 × 尺度): 局所の伸び / 向きの揃い / 卓越する筋の向き ===');
  // 正距円筒は経度方向が緯度の余弦で縮むので、勾配も窓も 1 texel の地表距離で測り直す。
  const globeRowKm = Array.from({ length: HEIGHT }, (_, y) => {
    const latitude = Math.min(SCALE_LATITUDE_LIMIT, Math.abs(90 - ((y + 0.5) / HEIGHT) * 180));
    return GLOBE_KM_PER_PX * Math.cos((latitude * Math.PI) / 180);
  });
  const globeStructures = new Map(STRUCTURE_FIELDS.map((field) =>
    [field.key, structuresOf(globe[field.key], globeRowKm, GLOBE_KM_PER_PX, true, GLOBE_SCALES_KM)]));
  for (const field of STRUCTURE_FIELDS) {
    for (const scale of GLOBE_IMAGE_SCALES_KM) {
      writeFileSync(path.join(outDir, `globe-${field.key}-${scale}km-structure.png`),
        structureToRgbPng(globeStructures.get(field.key).get(scale)));
    }
  }
  const structureGlobe = [];
  for (const band of BANDS) {
    const y0 = rowAtLatitude(band.north);
    const h = rowAtLatitude(band.south) - y0;
    const rows = printStructureTable(`--- ${band.label} ---`, GLOBE_SCALES_KM.map((scale) => ({
      scale,
      cells: STRUCTURE_FIELDS.map((field) =>
        summarizeStructure(globeStructures.get(field.key).get(scale), 0, y0, GLOBE_W, h)),
    })));
    structureGlobe.push({ band: band.label, rows });
  }
  report.sections.structureGlobe = structureGlobe;

  console.log('\n=== 構造の異方性(地域別 cap・尺度) ===');
  const capRowKm = new Array(CAP_BOX).fill(CAP_KM_PER_PX);
  const structureCaps = [];
  for (const region of REGIONS) {
    const cap = caps.get(region.name);
    const structures = new Map(STRUCTURE_FIELDS.map((field) =>
      [field.key, structuresOf(cap[field.key], capRowKm, CAP_KM_PER_PX, false, CAP_SCALES_KM)]));
    for (const field of STRUCTURE_FIELDS) {
      for (const scale of CAP_IMAGE_SCALES_KM) {
        writeFileSync(path.join(outDir, `${region.name}-${field.key}-${scale}km-structure.png`),
          structureToRgbPng(structures.get(field.key).get(scale)));
      }
    }
    const rows = printStructureTable(`--- ${capLabelOf(region)} ---`, CAP_SCALES_KM.map((scale) => ({
      scale,
      cells: STRUCTURE_FIELDS.map((field) =>
        summarizeStructure(structures.get(field.key).get(scale), 0, 0, CAP_BOX, CAP_BOX)),
    })));
    structureCaps.push({ region: region.name, rows });
  }
  report.sections.structureCaps = structureCaps;

  console.log(`\n=== 雲の塊の形(しきい ${SHAPE_THRESHOLD}・前景 8 近傍、面積と周囲は地表の km 換算) ===`);
  console.log('面            場      塊の数   曇り割合  面積中央値 [km²]  面積 p90 [km²]  最大の割合   穴の数  穴の割合  周囲/面積 [1/km]');
  const printShapeRow = (face, label, stats) => console.log(
    `${face.padEnd(12)}  ${label.padEnd(6)}  ${String(stats.count).padStart(6)}  ${(stats.cloudyShare * 100).toFixed(1).padStart(7)}%`
    + `  ${stats.areaKm2.median.toFixed(0).padStart(12)}  ${stats.areaKm2.p90.toFixed(0).padStart(12)}`
    + `  ${(stats.largestShare * 100).toFixed(1).padStart(7)}%  ${String(stats.holeCount).padStart(6)}`
    + `  ${(stats.holeAreaShare * 100).toFixed(2).padStart(6)}%  ${stats.perimeterPerArea.toFixed(4).padStart(8)}`);
  const bandRowKm = globeRowKm.slice(y60, y60 + bandHeight);
  const globeShapes = {
    reference: componentStats(cropField(globe.thick, 0, y60, GLOBE_W, bandHeight), SHAPE_THRESHOLD, true, bandRowKm, GLOBE_KM_PER_PX),
    generated: componentStats(cropField(globe.coverage, 0, y60, GLOBE_W, bandHeight), SHAPE_THRESHOLD, true, bandRowKm, GLOBE_KM_PER_PX),
  };
  printShapeRow('全球 ±60°', '実写厚', globeShapes.reference);
  printShapeRow('全球 ±60°', '被覆率', globeShapes.generated);
  const capShapes = [];
  for (const region of REGIONS) {
    const cap = caps.get(region.name);
    const reference = componentStats(cap.thick, SHAPE_THRESHOLD, false, capRowKm, CAP_KM_PER_PX);
    const generated = componentStats(cap.coverage, SHAPE_THRESHOLD, false, capRowKm, CAP_KM_PER_PX);
    printShapeRow(region.name, '実写厚', reference);
    printShapeRow(region.name, '被覆率', generated);
    capShapes.push({ region: region.name, reference, generated });
  }
  report.sections.shapes = { threshold: SHAPE_THRESHOLD, globe: globeShapes, caps: capShapes };

  console.log('\n=== 地形との関係(全球面・±60°、帯状平均を引いた偏差の相関) ===');
  console.log('場      平年雲量   標高');
  const inBand = (field) => zonalDeviation(cropField(field, 0, y60, GLOBE_W, bandHeight));
  const cloudinessDeviation = inBand(meanCloudiness);
  const elevationDeviation = inBand(elevation);
  const terrain = [];
  for (const [label, key] of [['実写計', 'photo'], ['実写厚', 'thick'], ['実写薄', 'veil'],
    ['被覆率', 'coverage'], ['薄い雲', 'translucent'], ['合成', 'composite']]) {
    const deviation = inBand(globe[key]);
    const cloudinessCorr = correlation(deviation, cloudinessDeviation);
    const elevationCorr = correlation(deviation, elevationDeviation);
    console.log(`${label}   ${cloudinessCorr.toFixed(3).padStart(6)}  `
      + `${elevationCorr.toFixed(3).padStart(6)}`);
    terrain.push({ field: key, cloudinessCorr, elevationCorr });
  }
  report.sections.terrain = terrain;

  console.log('\n=== 地形の箱(平均と、晴れ < 0.06 の割合) ===');
  console.log('箱                              平年雲量  実写計  合成   被覆率  薄い雲  実写計の晴れ  合成の晴れ');
  const terrainBoxes = [];
  for (const box of TERRAIN_BOXES) {
    const statsIn = (field) => toneStats(cropLatLonBox(field, box.north, box.south, box.west, box.east));
    const meanIn = (field) => statsIn(field).mean;
    const means = {
      photo: meanIn(globe.photo),
      composite: meanIn(globe.composite),
      coverage: meanIn(globe.coverage),
      translucent: meanIn(globe.translucent),
    };
    const clearPhoto = statsIn(globe.photo).low;
    const clearComposite = statsIn(globe.composite).low;
    console.log(`${box.label.padEnd(26)}  ${meanIn(meanCloudiness).toFixed(3)}  ${means.photo.toFixed(3)}  `
      + `${means.composite.toFixed(3)}  ${means.coverage.toFixed(3)}  ${means.translucent.toFixed(3)}  `
      + `${(clearPhoto * 100).toFixed(0).padStart(10)}%  ${(clearComposite * 100).toFixed(0).padStart(8)}%`);
    terrainBoxes.push({
      label: box.label, meanCloudiness: meanIn(meanCloudiness), means, clearPhoto, clearComposite,
    });
  }
  report.sections.terrainBoxes = terrainBoxes;

  console.log('\n=== 雲頂(cap の中央 362×362・被覆率 > 0.3 の texel、生成のみ) ===');
  console.log('地域                                    雲域  中央値  四分位幅   ≤3km  3-7km   >9km  >12km   金床');
  const printCloudTop = (label, stats) => console.log(
    `${label.padEnd(30)}  ${(stats.area * 100).toFixed(0).padStart(3)}%  ${(stats.median / 1000).toFixed(1).padStart(4)} km`
    + `  ${(stats.iqr / 1000).toFixed(1).padStart(4)} km  ${(stats.below3 * 100).toFixed(0).padStart(4)}%`
    + `  ${(stats.middle * 100).toFixed(0).padStart(4)}%  ${(stats.above9 * 100).toFixed(1).padStart(5)}%`
    + `  ${(stats.above12 * 100).toFixed(1).padStart(5)}%  ${(stats.anvil * 100).toFixed(0).padStart(4)}%`);
  const capCenter = (CAP_BOX - 1) / 2;
  const cloudTop = [];
  for (const region of REGIONS) {
    const top = capTops.get(region.name);
    const { coverage } = caps.get(region.name);
    if (region.coreRadiusKm === null) {
      const stats = cloudTopStats(top, coverage, CAP_KM_PER_PX, null);
      printCloudTop(region.label, stats);
      cloudTop.push({ region: region.name, part: 'all', stats });
      continue;
    }
    // 中心濃密雲域は外側と分けて出す。平らな天蓋を持ってよいのはここだけ。
    const radius = region.coreRadiusKm / CAP_KM_PER_PX;
    const maskFor = (within) => Uint8Array.from({ length: CAP_BOX * CAP_BOX }, (_, i) => {
      const inside = Math.hypot((i % CAP_BOX) - capCenter, Math.floor(i / CAP_BOX) - capCenter) <= radius;
      return inside === within ? 1 : 0;
    });
    const coreStats = cloudTopStats(top, coverage, CAP_KM_PER_PX, maskFor(true));
    printCloudTop(`${region.label} 中心 ${region.coreRadiusKm} km`, coreStats);
    cloudTop.push({ region: region.name, part: 'core', stats: coreStats });
    const outsideStats = cloudTopStats(top, coverage, CAP_KM_PER_PX, maskFor(false));
    printCloudTop(`${region.label} 外側`, outsideStats);
    cloudTop.push({ region: region.name, part: 'outside', stats: outsideStats });
  }
  report.sections.cloudTop = cloudTop;

  // 雲頂の実写参照 (MODIS Terra の雲頂高度)。生成の cloudTop 節と同じ地域・部位で、
  // 同じ分位の定義 (tools/cloud-top-stats.mjs) の値を並べ、cloudTop の距離の入力にする。
  // 参照が無ければこの節だけ飛ばす (typhoonReference と同じ扱い)。
  console.log('\n=== 雲頂の実写参照(MODIS Terra・雲頂高度、生成の同じ地域・部位) ===');
  console.log('地域                                    生成中央値  実写中央値  生成≤3km  実写≤3km  生成>9km  実写>9km');
  const cloudtopManifest = path.join(buildDir, 'reference-cloudtop', 'manifest.json');
  if (!existsSync(cloudtopManifest)) {
    console.log('.cloud-lab/reference-cloudtop/manifest.json が無い — npm run cloud-lab:reference-cloudtop で取り込む');
  } else {
    const manifest = JSON.parse(readFileSync(cloudtopManifest, 'utf8'));
    const referenceByKey = new Map(manifest.frames.flatMap((frame) => frame.stats.map((entry) =>
      [`${frame.region}/${entry.part}`, entry.stats])));
    const cloudTopReference = [];
    for (const entry of cloudTop) {
      const stats = referenceByKey.get(`${entry.region}/${entry.part}`);
      if (!stats) continue;
      cloudTopReference.push({ region: entry.region, part: entry.part, stats });
      const label = entry.part === 'all' ? entry.region : `${entry.region} ${entry.part}`;
      console.log(`${label.padEnd(30)}  ${(entry.stats.median / 1000).toFixed(1).padStart(6)} km  `
        + `${(stats.median / 1000).toFixed(1).padStart(6)} km  ${(entry.stats.below3 * 100).toFixed(0).padStart(5)}%  `
        + `${(stats.below3 * 100).toFixed(0).padStart(5)}%  ${(entry.stats.above9 * 100).toFixed(1).padStart(5)}%  `
        + `${(stats.above9 * 100).toFixed(1).padStart(5)}%`);
    }
    report.sections.cloudTopReference = {
      layer: manifest.layer, date: manifest.date, colormap: manifest.colormap, entries: cloudTopReference,
    };
  }

  // --- 微細構造: 描画の撮影を実写の高解像度参照の箱へ載せ替え、尺度帯ごとに比べる ---
  console.log('\n=== 微細構造(描画の撮影と実写の高解像度参照、尺度帯ごと) ===');
  const capManifestPath = path.join(root, '.cloud-lab/render-capture/manifest.json');
  const fineManifestPath = path.join(root, '.cloud-lab/reference-fine/manifest.json');
  if (!existsSync(capManifestPath)) {
    console.log('  (撮影の manifest が無いので微細構造は未計測)');
  } else if (!existsSync(fineManifestPath)) {
    console.log('  (実写の微細参照の manifest が無いので微細構造は未計測)');
  } else {
    const capManifest = JSON.parse(readFileSync(capManifestPath, 'utf8'));
    const fineManifest = JSON.parse(readFileSync(fineManifestPath, 'utf8'));
    const finePairs = [];
    for (const region of REGIONS) {
      for (const ladder of ['400km', '2000km']) {
        const capture = capManifest.captures.find(
          (entry) => entry.region === region.name && entry.name === `${region.name}-${ladder}`);
        const visibleFrame = fineManifest.frames.find(
          (frame) => frame.region === region.name && frame.ladder === ladder
            && ['band3', 'band2', 'viirs'].includes(frame.suffix));
        if (capture === undefined || visibleFrame === undefined) {
          console.log(`  ${region.label} ${ladder}: 撮影または可視の参照が無く、対を組めない`);
          continue;
        }
        const streakFrame = fineManifest.frames.find(
          (frame) => frame.region === region.name && frame.ladder === ladder && frame.suffix === 'band13');
        const captureField = decodeLuminancePng(
          readFileSync(path.join(root, '.cloud-lab/render-capture', capture.file)));
        const resampled = resampleCaptureToBox(
          captureField, capture.latitudeDeg, capture.longitudeDeg, capture.cameraDistanceKm,
          capManifest.fovDeg, visibleFrame.box, 960, 540);
        if (resampled.validRect === null) {
          console.log(`  ${region.label} ${ladder}: 撮影が箱を覆わず、有効矩形が無い`);
          continue;
        }
        const rect = resampled.validRect;
        const generatedVisible = cropField(resampled, rect.x0, rect.y0, rect.width, rect.height);
        const referenceVisibleField = decodeLuminancePng(readFileSync(path.join(root, visibleFrame.file)));
        const referenceVisible = cropField(
          referenceVisibleField, rect.x0, rect.y0, rect.width, rect.height);
        let referenceStreak = null;
        if (streakFrame !== undefined) {
          const streakField = decodeLuminancePng(readFileSync(path.join(root, streakFrame.file)));
          referenceStreak = cropField(streakField, rect.x0, rect.y0, rect.width, rect.height);
        }
        const features = measureFinePair(
          generatedVisible, referenceVisible, referenceStreak, visibleFrame.kmPerPx, ladder);
        const validCount = resampled.valid.reduce((sum, value) => sum + (value ? 1 : 0), 0);
        const pair = {
          region: region.name,
          ladder,
          kmPerPx: visibleFrame.kmPerPx,
          widthKm: +(visibleFrame.box.east - visibleFrame.box.west) * 111.32
            * Math.cos((visibleFrame.box.north + visibleFrame.box.south) / 2 * Math.PI / 180),
          heightKm: +(visibleFrame.box.north - visibleFrame.box.south) * 111.32,
          validFraction: +(validCount / (960 * 540)).toFixed(4),
          validRect: rect,
          distance: true,
          visible: { bands: features.bands },
          streak: features.streak,
        };
        // typhoon 400 km: 実写の嵐の中心は箱の北辺の外 (北緯 20.68° の外側に目がある) で、
        // 枠内は嵐の南側の裾しか写っていないのに、生成側は目と眼の壁が枠を埋める。
        // 同じ嵐の同じ場所を比べていないので、この対だけ距離の項から外す。
        if (region.name === 'typhoon' && ladder === '400km') {
          pair.distance = false;
          pair.distanceReason = 'typhoon-content-mismatch';
        }
        finePairs.push(pair);
        console.log(`--- ${region.label} ${ladder} (${pair.widthKm.toFixed(0)}x${pair.heightKm.toFixed(0)} km、`
          + `有効 ${rect.width}x${rect.height}・${(pair.validFraction * 100).toFixed(1)}%) ---`);
        console.log('  帯[km]  電力割合 生成/実写  箱次元 生成/実写  log空隙率 生成/実写'
          + '  成分数 生成/実写  面積中央値 生成/実写[km2]  最大の割合 生成/実写');
        for (const band of features.bands) {
          if (band.boxDimension === null) {
            console.log(`  ${band.loKm}-${band.hiKm}  ${band.generatedShare.toFixed(3)}/${band.referenceShare.toFixed(3)}`
              + '  (測れない)');
            continue;
          }
          const dimension = band.boxDimension;
          const lacunarity = band.lacunarity;
          const components = band.components;
          console.log(`  ${band.loKm}-${band.hiKm}${band.primary ? '*' : ' '}  `
            + `${band.generatedShare.toFixed(3)}/${band.referenceShare.toFixed(3)}  `
            + `${dimension.generated.toFixed(2)}/${dimension.reference.toFixed(2)}  `
            + `${lacunarity === null ? '-' : lacunarity.generated.toFixed(2) + '/' + lacunarity.reference.toFixed(2)}  `
            + `${components.generated.count}/${components.reference.count}  `
            + `${components.generated.medianAreaKm2.toFixed(0)}/${components.reference.medianAreaKm2.toFixed(0)}  `
            + `${components.generated.largestShare.toFixed(3)}/${components.reference.largestShare.toFixed(3)}`);
        }
        if (features.streak === null) {
          console.log('  筋: 赤外の参照が無く未計測');
        } else {
          const scale63 = features.streak.scales.find((scale) => scale.scaleKm === 63);
          const lTheta = features.streak.lThetaKm;
          const coherence = features.streak.scales.map((scale) =>
            `${scale.scaleKm}:${scale.generated.coherence.toFixed(2)}/${scale.reference.coherence.toFixed(2)}`).join(' ');
          console.log(`  筋 63km: 向き ${scale63 === undefined ? '-' : scale63.generated.orientationDeg.toFixed(0) + '/'
            + scale63.reference.orientationDeg.toFixed(0) + '°'}  Lθ `
            + `${lTheta === null || lTheta.generated === null ? '-' : lTheta.generated.toFixed(0) + '/'
            + (lTheta.reference === null ? '-' : lTheta.reference.toFixed(0)) + ' km'}  揃い ${coherence}`);
        }
      }
    }
    report.sections.fineStructure = {
      capture: { gitHead: capManifest.gitHead, fovDeg: capManifest.fovDeg, viewport: capManifest.viewport },
      reference: { source: fineManifest.source },
      bands: FINE_BANDS.map((band) => ({
        loKm: band.loKm,
        hiKm: band.hiKm,
        primaryLadder: FINE_PRIMARY_LADDER[`${band.loKm}-${band.hiKm}`],
      })),
      pairs: finePairs,
    };
  }

  // --- 巻雲層: 層だけの撮影と、帯 13 の輝度温度から切り分けた高層雲を比べる ---
  // 合成画の微細構造は明るい積雲に支配され、巻雲のズレがどの距離にも出なかった。
  // ここでは生成側も教師側も層だけに切り分け、層の中だけで帯の電力割合と筋を測る。
  // 対の箱は帯 13 フレームの箱 (npac の 2000 km では帯 13 だけ中心がずれている —
  // 生成は全球の場なのでどちらの箱へも載せ替えられ、対の中で同じ場所を比べることを
  // 優先する)。sahara は帯 13 の参照が無いので対を組めない。
  console.log('\n=== 巻雲層(層だけの撮影と帯 13 輝度温度の高層雲、尺度帯ごと) ===');
  const cirrusCapManifestPath = path.join(root, '.cloud-lab/render-capture-cirrus/manifest.json');
  const cirrusRefManifestPath = path.join(root, '.cloud-lab/reference-cirrus/manifest.json');
  if (!existsSync(cirrusCapManifestPath)) {
    console.log('  (巻雲の撮影の manifest が無いので巻雲層は未計測)');
  } else if (!existsSync(fineManifestPath)) {
    console.log('  (実写の微細参照の manifest が無いので巻雲層は未計測)');
  } else if (!existsSync(cirrusRefManifestPath)) {
    console.log('  (reference-cirrus の manifest が無いので巻雲層は未計測)');
  } else {
    const cirrusCapManifest = JSON.parse(readFileSync(cirrusCapManifestPath, 'utf8'));
    const fineManifest = JSON.parse(readFileSync(fineManifestPath, 'utf8'));
    const cirrusRefManifest = JSON.parse(readFileSync(cirrusRefManifestPath, 'utf8'));
    const colormapEntries = parseBand13Colormap(
      readFileSync(path.join(root, '.cloud-lab/reference-cirrus', cirrusRefManifest.colormap.file), 'utf8'));
    const cirrusPairs = [];
    for (const region of REGIONS) {
      for (const ladder of ['400km', '2000km']) {
        const capture = cirrusCapManifest.captures.find(
          (entry) => entry.region === region.name && entry.name === `${region.name}-${ladder}`);
        const btFrame = fineManifest.frames.find(
          (frame) => frame.region === region.name && frame.ladder === ladder && frame.suffix === 'band13');
        if (capture === undefined || btFrame === undefined) {
          console.log(`  ${region.label} ${ladder}: 巻雲の撮影または帯 13 の参照が無く、対を組めない`);
          continue;
        }
        const captureField = decodeLuminancePng(
          readFileSync(path.join(root, '.cloud-lab/render-capture-cirrus', capture.file)));
        const resampled = resampleCaptureToBox(
          captureField, capture.latitudeDeg, capture.longitudeDeg, capture.cameraDistanceKm,
          cirrusCapManifest.fovDeg, btFrame.box, 960, 540);
        if (resampled.validRect === null) {
          console.log(`  ${region.label} ${ladder}: 撮影が箱を覆わず、有効矩形が無い`);
          continue;
        }
        const rect = resampled.validRect;
        const generatedLayer = cropField(resampled, rect.x0, rect.y0, rect.width, rect.height);
        const btField = invertBrightnessTemperature(
          decodePng(readFileSync(path.join(root, btFrame.file))), colormapEntries);
        const referenceLayer = cropField(coldnessField(btField), rect.x0, rect.y0, rect.width, rect.height);
        const btCrop = cropField(btField, rect.x0, rect.y0, rect.width, rect.height);
        let highCount = 0;
        let btCount = 0;
        for (const v of btCrop.data) {
          if (Number.isNaN(v)) continue;
          btCount++;
          if (v <= HIGH_CLOUD_THRESHOLD_C) highCount++;
        }
        const features = measureCirrusPair(generatedLayer, referenceLayer, btFrame.kmPerPx, ladder);
        const validCount = resampled.valid.reduce((sum, value) => sum + (value ? 1 : 0), 0);
        const pair = {
          region: region.name,
          ladder,
          kmPerPx: btFrame.kmPerPx,
          widthKm: +(btFrame.box.east - btFrame.box.west) * 111.32
            * Math.cos((btFrame.box.north + btFrame.box.south) / 2 * Math.PI / 180),
          heightKm: +(btFrame.box.north - btFrame.box.south) * 111.32,
          validFraction: +(validCount / (960 * 540)).toFixed(4),
          validRect: rect,
          distance: true,
          highCloudFraction: btCount > 0 ? +(highCount / btCount).toFixed(4) : null,
          inversion: {
            exactFraction: +btField.stats.exactFraction.toFixed(4),
            ambiguousFraction: +btField.stats.ambiguousFraction.toFixed(4),
            coldGrayFraction: +btField.stats.coldGrayFraction.toFixed(4),
          },
          bands: features.bands,
          streak: features.streak,
        };
        // 微細構造と同じ理由で、typhoon 400 km は同じ嵐の同じ場所を比べていない。
        if (region.name === 'typhoon' && ladder === '400km') {
          pair.distance = false;
          pair.distanceReason = 'typhoon-content-mismatch';
        }
        // 教師側に層がほぼ無い対 (高層雲の面積率 1% 未満) では、層の内側の構造は
        // 測れない — 冷たさの場はまばらな冷たい画素の寄せ集めで、その帯配分は
        // 巻雲の質感ではなく点の分布を映す。対は記録に残し、距離の項からだけ外す。
        if (pair.highCloudFraction !== null && pair.highCloudFraction < 0.01) {
          pair.distance = false;
          pair.distanceReason = 'reference-layer-absent';
        }
        cirrusPairs.push(pair);
        console.log(`--- ${region.label} ${ladder} (${pair.widthKm.toFixed(0)}x${pair.heightKm.toFixed(0)} km、`
          + `有効 ${rect.width}x${rect.height}・${(pair.validFraction * 100).toFixed(1)}%、`
          + `高層雲の面積率 ${(pair.highCloudFraction * 100).toFixed(1)}%) ---`);
        console.log('  帯[km]  電力割合 生成/実写');
        for (const band of features.bands) {
          console.log(`  ${band.loKm}-${band.hiKm}${band.primary ? '*' : ' '}  `
            + `${band.generatedShare.toFixed(3)}/${band.referenceShare.toFixed(3)}`);
        }
        const scale63 = features.streak.scales.find((scale) => scale.scaleKm === 63);
        const lTheta = features.streak.lThetaKm;
        const coherence = features.streak.scales.map((scale) =>
          `${scale.scaleKm}:${scale.generated.coherence.toFixed(2)}/${scale.reference.coherence.toFixed(2)}`).join(' ');
        console.log(`  筋 63km: 向き ${scale63 === undefined ? '-' : scale63.generated.orientationDeg.toFixed(0) + '/'
          + scale63.reference.orientationDeg.toFixed(0) + '°'}  Lθ `
          + `${lTheta === null || lTheta.generated === null ? '-' : lTheta.generated.toFixed(0) + '/'
          + (lTheta.reference === null ? '-' : lTheta.reference.toFixed(0)) + ' km'}  揃い ${coherence}`);
      }
    }
    report.sections.cirrusStructure = {
      capture: {
        gitHead: cirrusCapManifest.gitHead, layer: cirrusCapManifest.layer,
        fovDeg: cirrusCapManifest.fovDeg, viewport: cirrusCapManifest.viewport,
      },
      reference: {
        source: fineManifest.source, colormap: cirrusRefManifest.colormap,
        threshold: cirrusRefManifest.threshold,
      },
      bands: FINE_BANDS.map((band) => ({
        loKm: band.loKm,
        hiKm: band.hiKm,
        primaryLadder: FINE_PRIMARY_LADDER[`${band.loKm}-${band.hiKm}`],
      })),
      pairs: cirrusPairs,
    };
  }

  // --- 微細な動き: 描画の時系列撮影と実写の可視時系列を、帯域ごとに動きで比べる ---
  // 写像 (箱の画素が撮影のどこを読むか) は時刻によらず同じなので、1 つの対で 1 回だけ
  // 作って 5 時刻に使い回す。測る矩形は、生成の有効域と実写の全 5 時刻の有効域 (輝度が黒 =
  // 円盤外・夜側として除く。実写フェッチャの黒の取り方 (ガンマで 3/255 未満) と同じ) の
  // 共通部分の最大の矩形で、生成と実写の両方に同じ格子で切り出す。輝度は線形化してあるので
  // しきいも線形へ直す (linearOf(3) ≈ 0.00091)。3/255 を線形のまま使うと、暗いだけの
  // 海 (ガンマで 26/255 まで) まで除いて矩形が潰れる。
  // 陸らしさ = smoothstep(0, 100 m, 標高) で、箱の格子へ双一次で載せ替えたもの
  // (climate-map.ts の landFraction と同じ。標高は 200 km でぼかしてあるので、海岸の
  // 200 km 以内は陸寄りに読む — 層別は大まかな陸海の別で、細かい海岸線は解かない)。
  // 風は箱の平均の地表風 (t=0。成分 = (値 − 0.5) × 2 × WIND_SPAN)。
  console.log('\n=== 微細な動き(描画の時系列撮影と実写の可視時系列、帯域ごと) ===');
  const tsCapManifestPath = path.join(root, '.cloud-lab/render-capture-timeseries/manifest.json');
  const tsFineManifestPath = path.join(root, '.cloud-lab/reference-fine-timeseries/manifest.json');
  if (!existsSync(tsCapManifestPath)) {
    console.log('  (時系列の撮影の manifest が無いので微細な動きは未計測)');
  } else if (!existsSync(tsFineManifestPath)) {
    console.log('  (実写の可視時系列の manifest が無いので微細な動きは未計測)');
  } else {
    const tsCapManifest = JSON.parse(readFileSync(tsCapManifestPath, 'utf8'));
    const tsFineManifest = JSON.parse(readFileSync(tsFineManifestPath, 'utf8'));
    if (JSON.stringify(tsCapManifest.sampleHours) !== JSON.stringify(FINE_MOTION_SAMPLE_HOURS)
      || JSON.stringify(tsFineManifest.sampleHours) !== JSON.stringify(FINE_MOTION_SAMPLE_HOURS)) {
      console.log('  (時刻梯子が想定と違うので微細な動きは未計測)');
    } else {
      const fineMotionPairs = [];
      const landFractionOnGrid = (box, width, height) => {
        const data = new Float32Array(width * height);
        for (let y = 0; y < height; y++) {
          const lat = box.north - ((y + 0.5) / height) * (box.north - box.south);
          for (let x = 0; x < width; x++) {
            const lon = box.west + ((x + 0.5) / width) * (box.east - box.west);
            const elevM = sampleBilinear(
              elevation, ((lon + 180) / 360) * GLOBE_W - 0.5, ((90 - lat) / 180) * HEIGHT - 0.5) * 8000;
            const t = Math.min(1, Math.max(0, elevM / 100));
            data[y * width + x] = t * t * (3 - 2 * t);
          }
        }
        return { width, height, data };
      };
      const windMeanOfBox = (box) => {
        const east = cropLatLonBox(windEast, box.north, box.south, box.west, box.east);
        const north = cropLatLonBox(windNorth, box.north, box.south, box.west, box.east);
        let u = 0;
        let v = 0;
        for (let i = 0; i < east.data.length; i++) {
          u += (east.data[i] - 0.5) * 2 * WIND_SPAN;
          v += (north.data[i] - 0.5) * 2 * WIND_SPAN;
        }
        return { east: u / east.data.length, north: v / north.data.length };
      };
      for (const region of tsFineManifest.regions) {
        for (const ladder of ['400km', '2000km']) {
          const firstCapture = tsCapManifest.captures.find(
            (entry) => entry.region === region.name && entry.ladder === ladder && entry.hours === 0);
          const frames = FINE_MOTION_SAMPLE_HOURS.map((hours) => tsFineManifest.frames.find(
            (frame) => frame.region === region.name && frame.ladder === ladder && frame.hours === hours));
          const captures = FINE_MOTION_SAMPLE_HOURS.map((hours) => tsCapManifest.captures.find(
            (entry) => entry.region === region.name && entry.ladder === ladder && entry.hours === hours));
          if (firstCapture === undefined || frames.some((frame) => frame === undefined)
            || captures.some((entry) => entry === undefined)) {
            console.log(`  ${region.label} ${ladder}: 時系列の撮影または実写が揃わず、対を組めない`);
            continue;
          }
          const box = frames[0].box;
          if (frames.some((frame) => JSON.stringify(frame.box) !== JSON.stringify(box))) {
            console.log(`  ${region.label} ${ladder}: 時刻で箱が違い、対を組めない`);
            continue;
          }
          const mapping = captureBoxMapping(
            firstCapture.latitudeDeg, firstCapture.longitudeDeg, firstCapture.cameraDistanceKm,
            tsCapManifest.fovDeg, box, 960, 540, 960, 540);
          if (mapping.validRect === null) {
            console.log(`  ${region.label} ${ladder}: 撮影が箱を覆わず、有効矩形が無い`);
            continue;
          }
          const generatedFields = captures.map((entry) => applyCaptureMapping(
            decodeLuminancePng(readFileSync(path.join(root, '.cloud-lab/render-capture-timeseries', entry.file))),
            mapping));
          const referenceFields = frames.map((frame) => decodeLuminancePng(
            readFileSync(path.join(root, frame.file))));
          const commonValid = new Uint8Array(960 * 540);
          for (let i = 0; i < 960 * 540; i++) {
            commonValid[i] = mapping.valid[i]
              && referenceFields.every((field) => field.data[i] >= linearOf(3)) ? 1 : 0;
          }
          const rect = largestValidRect(commonValid, 960, 540);
          if (rect === null) {
            console.log(`  ${region.label} ${ladder}: 生成と実写の共通の有効矩形が無い`);
            continue;
          }
          const generated = generatedFields.map(
            (field) => cropField(field, rect.x0, rect.y0, rect.width, rect.height));
          const reference = referenceFields.map(
            (field) => cropField(field, rect.x0, rect.y0, rect.width, rect.height));
          const landField = cropField(
            landFractionOnGrid(box, 960, 540), rect.x0, rect.y0, rect.width, rect.height);
          const windMs = windMeanOfBox(box);
          const motion = measureFineMotionPair({
            generated, reference, kmPerPx: frames[0].kmPerPx, ladder,
            sampleHours: FINE_MOTION_SAMPLE_HOURS, driftLagHours: FINE_MOTION_DRIFT_LAG_HOURS,
            windMs, landField,
          });
          const validCount = commonValid.reduce((sum, value) => sum + value, 0);
          const pair = {
            region: region.name,
            ladder,
            kmPerPx: frames[0].kmPerPx,
            widthKm: +(box.east - box.west) * 111.32
              * Math.cos((box.north + box.south) / 2 * Math.PI / 180),
            heightKm: +(box.north - box.south) * 111.32,
            validFraction: +(validCount / (960 * 540)).toFixed(4),
            validRect: rect,
            distance: true,
            windMs,
            bands: motion.bands,
            strata: motion.strata,
          };
          // typhoon 400 km: t=0 の対と同じ理由 (実写の嵐の中心が箱の外で、生成側は目が枠を
          // 埋める) で、距離の項から外す。時系列でも同じ内容のずれが入る。
          if (region.name === 'typhoon' && ladder === '400km') {
            pair.distance = false;
            pair.distanceReason = 'typhoon-content-mismatch';
          }
          fineMotionPairs.push(pair);
          const fmt = (value, digits = 1) => (value === null ? '-' : value.toFixed(digits));
          console.log(`--- ${region.label} ${ladder} (${pair.widthKm.toFixed(0)}x${pair.heightKm.toFixed(0)} km、`
            + `有効 ${rect.width}x${rect.height}・${(pair.validFraction * 100).toFixed(1)}%) ---`);
          console.log(`  風 (箱平均・地表) 東 ${windMs.east.toFixed(1)} / 北 ${windMs.north.toFixed(1)} m/s`);
          console.log('  帯[km]  移流 東 生成/実写 [m/s]  北 生成/実写 [m/s]  風角 生成/実写 [°]'
            + '  速比 生成/実写  τ 生成/実写 [h]');
          for (const band of motion.bands) {
            const g = band.generated;
            const r = band.reference;
            console.log(`  ${band.loKm}-${band.hiKm}${band.primary ? '*' : ' '}  `
              + `${fmt(g.drift.driftMs.east)}/${fmt(r.drift.driftMs.east)}  `
              + `${fmt(g.drift.driftMs.north)}/${fmt(r.drift.driftMs.north)}  `
              + `${fmt(g.drift.angleDeg, 0)}/${fmt(r.drift.angleDeg, 0)}  `
              + `${fmt(g.drift.speedRatio, 2)}/${fmt(r.drift.speedRatio, 2)}  `
              + `${fmt(g.tauHours)}/${fmt(r.tauHours)}`);
          }
          console.log('  層別 陸 τ 生成/実写 [h] (タイル数)  海 τ 生成/実写 [h] (タイル数)');
          for (const band of motion.strata) {
            if (band.generated === null) continue;
            const g = band.generated;
            const r = band.reference;
            console.log(`  ${band.loKm}-${band.hiKm}${band.primary ? '*' : ' '}  `
              + `${fmt(g.land.tauHours)}/${fmt(r.land.tauHours)} (${g.land.tiles}/${r.land.tiles})  `
              + `${fmt(g.sea.tauHours)}/${fmt(r.sea.tauHours)} (${g.sea.tiles}/${r.sea.tiles})`);
          }
        }
      }
      report.sections.fineMotion = {
        capture: {
          gitHead: tsCapManifest.gitHead, fovDeg: tsCapManifest.fovDeg,
          sampleHours: FINE_MOTION_SAMPLE_HOURS, driftLagHours: FINE_MOTION_DRIFT_LAG_HOURS,
        },
        reference: { source: tsFineManifest.source, sampleHours: FINE_MOTION_SAMPLE_HOURS },
        pairs: fineMotionPairs,
      };
    }
  }

  console.log(`\n=== 台風の径方向プロファイル(cap の中央 362×362・${PROFILE_BIN_KM} km 刻みの方位平均、全 texel) ===`);
  const typhoonRadial = [];
  for (const region of REGIONS) {
    if (region.coreRadiusKm === null) continue;
    const cap = caps.get(region.name);
    const topKm = radialProfile(capTops.get(region.name), CAP_KM_PER_PX).map((metres) => metres / 1000);
    const profile = printRadialTable(`--- ${region.label} ---`, [
      { label: '雲頂 [km]', values: topKm, digits: 2 },
      { label: '被覆率', values: radialProfile(cap.coverage, CAP_KM_PER_PX), digits: 3 },
      { label: '合成', values: radialProfile(cap.composite, CAP_KM_PER_PX), digits: 3 },
    ]);
    const midTones = annulusShare(
      cap.coverage, CAP_KM_PER_PX, region.coreRadiusKm, PROFILE_MAX_KM, MID_TONE_MIN, MID_TONE_MAX);
    console.log(`${region.coreRadiusKm}-${PROFILE_MAX_KM} km の被覆率のうち中間調(${MID_TONE_MIN}-${MID_TONE_MAX})の割合: `
      + `${(midTones * 100).toFixed(1)}%`);
    typhoonRadial.push({ region: region.name, profile, midToneShare: midTones });
  }
  report.sections.typhoonRadial = typhoonRadial;

  console.log('\n=== 台風リファレンス(Worldview の実写の輝度を cap へ再標本化、生成の台風 cap の合成と比較) ===');
  const referenceDir = path.join(buildDir, 'reference');
  const referenceIndex = path.join(referenceDir, 'reference.json');
  if (!existsSync(referenceIndex)) {
    console.log('.cloud-lab/reference/reference.json が無い — npm run cloud-lab:reference で取り込む');
    report.sections.typhoonReference = [];
  } else {
    const typhoon = REGIONS.find((region) => region.coreRadiusKm !== null);
    const typhoonCap = caps.get(typhoon.name);
    const typhoonReference = [];
    for (const entry of JSON.parse(readFileSync(referenceIndex, 'utf8'))) {
      const luminance = decodeLuminancePng(readFileSync(path.join(root, entry.file)));
      const referenceCap = resampleCap(luminance, entry.bbox, entry.center.latitude, entry.center.longitude);
      saveGray(`typhoon-reference-${entry.name}.png`, referenceCap);
      const header = `--- ${entry.name}(${entry.date}・${entry.center.latitude}N ${entry.center.longitude}E) ---`;
      const tone = printToneTable(header, [
        { label: '実写(輝度)', key: 'reference', field: referenceCap },
        { label: '合成', key: 'composite', field: typhoonCap.composite },
      ]);
      const spectrum = printSpectrumTable(`${header} 行方向スペクトル`, capWavelengthOf,
        rowSpectrum(referenceCap), rowSpectrum(typhoonCap.composite), '実写(輝度)', '合成  ');
      const radial = printRadialTable(`${header} 径方向プロファイル`,
        [{ label: '実写(輝度)', values: radialProfile(referenceCap, CAP_KM_PER_PX), digits: 3 }]);
      typhoonReference.push({ name: entry.name, date: entry.date, tone, spectrum, radial });
    }
    report.sections.typhoonReference = typhoonReference;
  }

  console.log('\n=== 動き: 被覆率の時刻方向の自己相関(全球面・±60°) ===');
  const coverageBandAt = (hours) => cropField(motionCoverage.get(hours), 0, y60, GLOBE_W, bandHeight);
  const correlations = MOTION_SAMPLE_HOURS.map((hours) => correlation(coverageBandAt(0), coverageBandAt(hours)));
  console.log(`時刻 [h]  ${MOTION_SAMPLE_HOURS.map((hours) => String(hours).padStart(7)).join('')}`);
  console.log(`相関      ${correlations.map((value) => value.toFixed(3).padStart(7)).join('')}`);
  const tauHours = crossingTime(MOTION_SAMPLE_HOURS, correlations, 1 / Math.E);
  console.log(tauHours === null
    ? `相関が 1/e を切る時刻: ${MOTION_SAMPLE_HOURS.at(-1)} h 以内では切らない`
    : `相関が 1/e を切る時刻: ${tauHours.toFixed(1)} h`);

  console.log(`\n=== 動き: 帯ごとの移流(${DRIFT_LAG_HOURS} 時間の lag 相関)と地表風の平均 ===`);
  console.log('帯           ずらし [texel]   移流 東/北 [m/s]   相関    風 東/北 [m/s]   向きの差   速さ比');
  const drift = [];
  for (const band of BANDS) {
    const y0 = rowAtLatitude(band.north);
    const h = rowAtLatitude(band.south) - y0;
    const shift = bestShift(
      cropField(motionCoverage.get(0), 0, y0, GLOBE_W, h),
      cropField(motionCoverage.get(DRIFT_LAG_HOURS), 0, y0, GLOBE_W, h),
      DRIFT_MAX_DX, DRIFT_MAX_DY);
    const kmPerTexelX = GLOBE_KM_PER_PX * Math.cos((((band.north + band.south) / 2) * Math.PI) / 180);
    const driftEast = (shift.dx * kmPerTexelX * 1000) / (DRIFT_LAG_HOURS * 3600);
    const driftNorth = (-shift.dy * GLOBE_KM_PER_PX * 1000) / (DRIFT_LAG_HOURS * 3600);
    let windU = 0;
    let windV = 0;
    for (let y = y0; y < y0 + h; y++) {
      for (let x = 0; x < GLOBE_W; x++) {
        windU += (windEast.data[y * GLOBE_W + x] - 0.5) * 2 * WIND_SPAN;
        windV += (windNorth.data[y * GLOBE_W + x] - 0.5) * 2 * WIND_SPAN;
      }
    }
    windU /= h * GLOBE_W;
    windV /= h * GLOBE_W;
    const driftSpeed = Math.hypot(driftEast, driftNorth);
    const windSpeed = Math.hypot(windU, windV);
    const angleDeg = driftSpeed > 0 && windSpeed > 0
      ? (Math.acos(Math.min(1, Math.max(-1, (driftEast * windU + driftNorth * windV) / (driftSpeed * windSpeed)))) * 180) / Math.PI
      : null;
    console.log(`${band.label.padEnd(12)}  ${String(shift.dx).padStart(4)},${String(shift.dy).padStart(3)}`
      + `        ${driftEast.toFixed(1).padStart(5)} / ${driftNorth.toFixed(1).padStart(5)}   ${shift.correlation.toFixed(3)}`
      + `   ${windU.toFixed(1).padStart(5)} / ${windV.toFixed(1).padStart(5)}   ${angleDeg === null ? '    -' : `${angleDeg.toFixed(0).padStart(4)}°`}`
      + `   ${windSpeed > 0 ? (driftSpeed / windSpeed).toFixed(2) : '-'}`);
    drift.push({
      band: band.label,
      shiftTexels: [shift.dx, shift.dy],
      correlation: shift.correlation,
      driftMs: { east: driftEast, north: driftNorth },
      driftSpeedMs: driftSpeed,
      windMs: { east: windU, north: windV },
      windSpeedMs: windSpeed,
      angleDeg,
      speedRatio: windSpeed > 0 ? driftSpeed / windSpeed : null,
    });
  }

  console.log(`\n=== 動き: 熱帯低気圧のトラック(解析配置)と描画中心のずれ(中心 ${CENTER_CORE_RADIUS_KM} km 以内の被覆率の重心) ===`);
  const longitudeDegOf = (rad) => ((((rad * 180) / Math.PI + 180) % 360) + 360) % 360 - 180;
  const track = cycloneTrack.map((entry) => ({
    hours: entry.hours,
    tropical: entry.tropical === null ? null : {
      latitudeDeg: (entry.tropical.latitude * 180) / Math.PI,
      longitudeDeg: longitudeDegOf(entry.tropical.longitude),
      depthHpa: entry.tropical.depth,
    },
  }));
  for (const point of track) {
    console.log(point.tropical === null
      ? `${String(point.hours).padStart(3)} h  (熱帯低気圧なし)`
      : `${String(point.hours).padStart(3)} h  ${point.tropical.latitudeDeg.toFixed(1).padStart(5)}° `
        + `${point.tropical.longitudeDeg.toFixed(1).padStart(6)}°  深さ ${point.tropical.depthHpa.toFixed(1)} hPa`);
  }
  const translationKmh = [];
  for (let i = 1; i < track.length; i++) {
    const from = track[i - 1].tropical;
    const to = track[i].tropical;
    if (from === null || to === null) continue;
    const dLat = ((to.latitudeDeg - from.latitudeDeg) * Math.PI) / 180;
    const dLon = ((to.longitudeDeg - from.longitudeDeg) * Math.PI) / 180;
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos((from.latitudeDeg * Math.PI) / 180) * Math.cos((to.latitudeDeg * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    const distanceKm = 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
    translationKmh.push({ fromHours: track[i - 1].hours, toHours: track[i].hours, kmh: distanceKm / (track[i].hours - track[i - 1].hours) });
  }
  for (const leg of translationKmh) {
    console.log(`${leg.fromHours}-${leg.toHours} h の移動速度: ${leg.kmh.toFixed(1)} km/h`);
  }
  const centerOffsets = [];
  const centerCoreRadiusPx = CENTER_CORE_RADIUS_KM / CAP_KM_PER_PX;
  for (const [hours, field] of cycloneCenters) {
    const core = {
      width: field.width,
      height: field.height,
      data: Float32Array.from(field.data, (value, i) => {
        const dx = (i % field.width) - (field.width - 1) / 2;
        const dy = Math.floor(i / field.width) - (field.height - 1) / 2;
        return Math.hypot(dx, dy) <= centerCoreRadiusPx ? value : 0;
      }),
    };
    const offset = centroidOffset(core);
    if (offset === null) continue;
    const dxKm = offset.dx * CAP_KM_PER_PX;
    const dyKm = offset.dy * CAP_KM_PER_PX;
    const offsetKm = Math.hypot(dxKm, dyKm);
    console.log(`${String(hours).padStart(3)} h の描画中心のずれ: 東 ${dxKm.toFixed(0)} km / 南 ${dyKm.toFixed(0)} km(計 ${offsetKm.toFixed(0)} km)`);
    centerOffsets.push({ hours, dxKm, dyKm, offsetKm });
  }
  report.sections.motion = {
    sampleHours: MOTION_SAMPLE_HOURS,
    decorrelation: { correlations, tauHours },
    driftLagHours: DRIFT_LAG_HOURS,
    drift,
    cyclone: { track, translationKmh, centerOffsets },
  };

  console.log('\n=== 実物の動き: ひまわり赤外の時系列と生成の同じ箱・同じ時刻刻み ===');
  const timeseriesManifest = path.join(buildDir, 'reference-timeseries', 'manifest.json');
  if (!existsSync(timeseriesManifest)) {
    console.log('.cloud-lab/reference-timeseries/manifest.json が無い — npm run cloud-lab:reference-timeseries で取り込む');
  } else {
    const manifest = JSON.parse(readFileSync(timeseriesManifest, 'utf8'));
    if (JSON.stringify(manifest.sampleHours) !== JSON.stringify(MOTION_SAMPLE_HOURS)) {
      throw new Error(`manifest の sampleHours(${manifest.sampleHours})が MOTION_SAMPLE_HOURS(${MOTION_SAMPLE_HOURS})と違う`);
    }
    // 箱の実物フレームを輝度へ直し、生成側の箱の格子へ載せ替える。実物フレームは箱そのもの
    // なので、全球面用の resampleEquirect ではなく度数から sampleBilinear で引く。
    // 載せ替えた場は .cloud-lab/compare/ へ残す。
    const referenceBoxAt = (box, hours) => {
      const frame = manifest.frames.find((entry) => entry.box === box.name && entry.hours === hours);
      if (!frame) throw new Error(`manifest に ${box.name} ${hours}h のフレームが無い`);
      const luminance = decodeLuminancePng(readFileSync(path.join(root, frame.file)));
      const size = cropLatLonBox(globe.coverage, box.north, box.south, box.west, box.east);
      const out = new Float32Array(size.width * size.height);
      for (let y = 0; y < size.height; y++) {
        const latitude = box.north - ((y + 0.5) / size.height) * (box.north - box.south);
        for (let x = 0; x < size.width; x++) {
          const longitude = box.west + ((x + 0.5) / size.width) * (box.east - box.west);
          const u = ((longitude - box.west) / (box.east - box.west)) * luminance.width - 0.5;
          const v = ((box.north - latitude) / (box.north - box.south)) * luminance.height - 0.5;
          out[y * size.width + x] = sampleBilinear(luminance, u, v);
        }
      }
      const field = { width: size.width, height: size.height, data: out };
      saveGray(`reference-motion-${box.name}-${hours}h.png`, field);
      return field;
    };
    // 箱の地表風の平均 [m/s]。成分 = (値 − 0.5) × 2 × WIND_SPAN。
    const windMeanOf = (box) => {
      const east = cropLatLonBox(windEast, box.north, box.south, box.west, box.east);
      const north = cropLatLonBox(windNorth, box.north, box.south, box.west, box.east);
      let u = 0;
      let v = 0;
      for (let i = 0; i < east.data.length; i++) {
        u += (east.data[i] - 0.5) * 2 * WIND_SPAN;
        v += (north.data[i] - 0.5) * 2 * WIND_SPAN;
      }
      return { east: u / east.data.length, north: v / north.data.length };
    };
    const motionOf = (box, fields, wind) => {
      const correlationsAt = MOTION_SAMPLE_HOURS.map((hours, index) => correlation(fields[0], fields[index]));
      const kmPerTexelX = GLOBE_KM_PER_PX * Math.cos((((box.north + box.south) / 2) * Math.PI) / 180);
      return {
        correlations: correlationsAt,
        tauHours: crossingTime(MOTION_SAMPLE_HOURS, correlationsAt, 1 / Math.E),
        drift: driftOf(fields[0], fields[MOTION_SAMPLE_HOURS.indexOf(DRIFT_LAG_HOURS)], DRIFT_LAG_HOURS,
          kmPerTexelX, GLOBE_KM_PER_PX, wind),
      };
    };
    const printMotionRow = (label, motion) => {
      console.log(`${label.padEnd(10)}  ${motion.correlations.map((value) => value.toFixed(3).padStart(7)).join('')}`
        + `   ${motion.tauHours === null ? '  -  ' : `${motion.tauHours.toFixed(1).padStart(5)} h`}`);
    };
    const referenceMotionBoxes = [];
    for (const box of manifest.boxes) {
      const wind = windMeanOf(box);
      const fieldAt = (source) => MOTION_SAMPLE_HOURS.map((hours) => source(hours));
      const reference = motionOf(box,
        fieldAt((hours) => referenceBoxAt(box, hours)), wind);
      const composite = motionOf(box,
        fieldAt((hours) => cropLatLonBox(motionComposite.get(hours), box.north, box.south, box.west, box.east)), wind);
      const coverage = motionOf(box,
        fieldAt((hours) => cropLatLonBox(motionCoverage.get(hours), box.north, box.south, box.west, box.east)), wind);
      console.log(`--- ${box.label} ---`);
      console.log(`時刻 [h]  ${MOTION_SAMPLE_HOURS.map((hours) => String(hours).padStart(7)).join('')}   1/e を切る時刻`);
      printMotionRow('実物赤外', reference);
      printMotionRow('生成合成', composite);
      printMotionRow('生成被覆率', coverage);
      const printDrift = (label, motion) => console.log(
        `${label.padEnd(10)}  移流 東 ${motion.drift.driftMs.east.toFixed(1).padStart(5)} / 北 `
        + `${motion.drift.driftMs.north.toFixed(1).padStart(5)} m/s`
        + `  ずらし ${String(motion.drift.shiftTexels[0]).padStart(3)},${String(motion.drift.shiftTexels[1]).padStart(2)}`
        + `  相関 ${motion.drift.correlation.toFixed(3)}`
        + `  風との向きの差 ${motion.drift.angleDeg === null ? ' - ' : `${motion.drift.angleDeg.toFixed(0).padStart(3)}°`}`
        + `  速さ比 ${motion.drift.speedRatio === null ? '-' : motion.drift.speedRatio.toFixed(2)}`);
      console.log(`8 h の移流(モデルの風 東 ${wind.east.toFixed(1)} / 北 ${wind.north.toFixed(1)} m/s との比較):`);
      printDrift('実物赤外', reference);
      printDrift('生成合成', composite);
      printDrift('生成被覆率', coverage);
      referenceMotionBoxes.push({
        box: box.name, label: box.label,
        sampleHours: MOTION_SAMPLE_HOURS,
        driftLagHours: DRIFT_LAG_HOURS,
        windMs: wind,
        reference, generated: { composite, coverage },
      });
    }
    report.sections.referenceMotion = {
      startUtc: manifest.startUtc,
      layer: manifest.layer,
      boxes: referenceMotionBoxes,
    };
  }

  // 家族ごとの距離。sections だけから同じ定義で計算できる (過去のレポートへも後から
  // 適用できる) ので、レポートには結果だけを載せる。
  report.distances = computeDistances(report.sections);
  console.log('\n=== 実写との距離(特徴量の家族ごと、0 が一致) ===');
  for (const [family, value] of Object.entries(report.distances.families)) {
    console.log(`${family.padEnd(18)} ${value.toFixed(3)}`);
  }
  console.log(`${'index (家族の平均)'.padEnd(18)} ${report.distances.index.toFixed(3)}`);

  // レポートを履歴へ残す。ファイル名は生成時刻と HEAD で一意にし、過去分は消さない
  // (webpack の保持対象に .cloud-lab/history を加えてある — webpack.cloud-lab.config.js)。
  // 書く前に直近のレポートとの差分を出す — 変更 → 計測 → 何が動いたか、の輪の出口。
  const historyDir = path.join(buildDir, 'history');
  mkdirSync(historyDir, { recursive: true });
  const previousName = readdirSync(historyDir).filter((name) => name.endsWith('.json')).sort().at(-1);
  const stamp = report.meta.generatedAt.replace(/[:.]/g, '-');
  writeFileSync(path.join(historyDir, `${stamp}-${report.meta.gitHead}.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log('\n=== 前回レポートとの差分 ===');
  if (previousName === undefined) {
    console.log('前回のレポートが無い(今回が初回)');
  } else {
    let previous = null;
    try {
      previous = JSON.parse(readFileSync(path.join(historyDir, previousName), 'utf8'));
    } catch {
      // 読めなければ null のままにする。
    }
    if (previous === null || previous.sections === undefined) {
      console.log(`${previousName} が読めないため差分を出せない`);
    } else {
      const diffs = { compared: 0, changed: [] };
      collectNumericDiffs(previous.sections, report.sections, '', diffs);
      for (const { path: leaf, before, after } of diffs.changed) {
        const delta = after - before;
        console.log(`${leaf}: ${formatDiffValue(before)} → ${formatDiffValue(after)} (${delta >= 0 ? '+' : ''}${formatDiffValue(delta)})`);
      }
      console.log(diffs.changed.length === 0
        ? `変わった数値なし(比較した数値 ${diffs.compared}、前回: ${previousName})`
        : `変わった数値 ${diffs.changed.length} / ${diffs.compared}(前回: ${previousName})`);
    }
  }

  // 距離の前後判定。前回の距離は保存値でなく sections から同じ定義で計算し直す —
  // 距離の定義を変えても履歴と比較できるようにするため。変化が相対 5% 以内なら横ばい
  // とする (計測は決定的だが、実行環境の浮動小数の揺れを悪化と誤判定しないための幅)。
  if (previousName !== undefined) {
    let prior = null;
    try {
      prior = JSON.parse(readFileSync(path.join(historyDir, previousName), 'utf8'));
    } catch {
      // 読めなければ null のままにする。
    }
    if (prior?.sections) {
      const before = computeDistances(prior.sections);
      let improved = 0;
      let worsened = 0;
      let unchanged = 0;
      console.log('\n=== 距離の変化(前回比、相対 5% 以内は横ばい) ===');
      for (const [family, after] of Object.entries(report.distances.families)) {
        const priorValue = before.families[family];
        if (priorValue === undefined) {
          console.log(`${family.padEnd(18)} (前回は未計測) → ${after.toFixed(3)}`);
          continue;
        }
        const relative = priorValue > 0 ? (after - priorValue) / priorValue : (after > 0 ? Infinity : 0);
        const verdict = relative < -0.05 ? '改善' : relative > 0.05 ? '悪化' : '横ばい';
        if (verdict === '改善') improved++;
        else if (verdict === '悪化') worsened++;
        else unchanged++;
        console.log(`${family.padEnd(18)} ${priorValue.toFixed(3)} → ${after.toFixed(3)}  ${verdict}`);
      }
      console.log(`改善 ${improved} / 悪化 ${worsened} / 横ばい ${unchanged}(index: ${before.index.toFixed(3)} → ${report.distances.index.toFixed(3)})`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
