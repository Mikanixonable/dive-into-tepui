// 雲の実験環境の生成と実写(8k_clouds)の統計比較。ヘッドレス Chrome で .cloud-lab/ を開き、
// 全球と地域別 cap の両面を撮って、帯状平均・階調・行方向スペクトル・構造の異方性・地形との関係・
// 雲頂の分布の表を出す。
// 実写は低い厚い雲と高層の巻雲が 1 枚に重なっているので、`npm run cloud-lab:separate` が
// 分離した成分(src/assets の仮テクスチャと .cloud-lab/separated/)を読み、撮影の面(全球の
// 正距円筒と cap の正射影)へ再標本化して成分ごとに比べる。**先に separate を実行しておく。**
// 再標本化した実写厚・実写薄も画像で .cloud-lab/compare/ に残る。
// `--params <json ファイル>` を与えると、撮影の前に cloud-lab のつまみをその値へ置き直す。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';
import { structureTensor, structureToRgbPng, summarizeStructure } from './cloud-structure.mjs';
import { cropField, cropLatLonBox, decodeChannelPng, decodeRedPng, fieldToGrayPng } from './gray-image.mjs';

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
// 地域別 cap。数値目標を当てるのは前の 6 つで、台風は 8k_clouds に写っていないので目視で見る。
// coreRadiusKm は、雲頂を内側と外側に分けて出す半径 [km](台風の中心濃密雲域)。
const REGIONS = [
  { name: 'npac-storm', label: '北太平洋の暴風帯(45N 170W)', latitude: 45, longitude: -170, coreRadiusKm: null },
  { name: 'natl-storm', label: '北大西洋の暴風帯(50N 30W)', latitude: 50, longitude: -30, coreRadiusKm: null },
  { name: 'so-ocean', label: '南大洋(55S 100E)', latitude: -55, longitude: 100, coreRadiusKm: null },
  { name: 'sepac-subtrop', label: '南東太平洋の亜熱帯高圧帯(20S 85W)', latitude: -20, longitude: -85, coreRadiusKm: null },
  { name: 'sahara', label: 'サハラ(22N 10E)', latitude: 22, longitude: 10, coreRadiusKm: null },
  { name: 'itcz-atl', label: '大西洋の収束帯(5N 25W)', latitude: 5, longitude: -25, coreRadiusKm: null },
  { name: 'typhoon', label: '台風(15N 140E・数値目標外)', latitude: 15, longitude: 140, coreRadiusKm: 250 },
];
const VIEWS = ['photo', 'composite', 'coverage', 'translucent', 'cloudTop'];

const CAP_KM_PER_PX = (2 * Math.sin((CAP_RADIUS * Math.PI) / 180) * 6371) / CAP_W;
// 全球面の 1 texel が張る地表距離 [km]。経度方向は緯度の余弦で縮む。
const GLOBE_KM_PER_PX = 40075 / GLOBE_W;
// 横の縮みを補正する緯度の上限 [°]。極では補正が発散するので、判定に使わない緯度で止める。
const SCALE_LATITUDE_LIMIT = 80;

// 場の G(雲頂高度)が張る高さ [m]。tools/cloud-lab/views.ts の CLOUD_TOP_SPAN と対。
const CLOUD_TOP_SPAN = 15000;
// 雲頂の分位に入れる texel の被覆率のしきい。
const CLOUD_TOP_COVERAGE = 0.3;
// 金床の判定。この高さ [m] を超える texel のうち、周り ANVIL_RADIUS_KM [km] の雲の雲頂の平均も
// 超えているものを平らな天蓋と見なす。
const ANVIL_HEIGHT = 9000;
const ANVIL_RADIUS_KM = 100;

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

// --params が指す JSON のつまみ。与えられていなければ null。
function knobOverrides() {
  const at = process.argv.indexOf('--params');
  if (at < 0) return null;
  const file = process.argv[at + 1];
  if (!file) throw new Error('--params にはつまみの JSON ファイルを渡す');
  return JSON.parse(readFileSync(path.resolve(file), 'utf8'));
}

// 分離済みの成分(原寸の正距円筒)を file(リポジトリ相対)から読む。無ければ、先に走らせる手順を
// 添えて投げる。
function loadSeparated(file) {
  try {
    return decodeRedPng(readFileSync(path.join(root, file)));
  } catch (e) {
    throw new Error(`${file} を読めない — 先に npm run cloud-lab:separate を実行する (${e.message})`);
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

// cap の面(正射影)の中央 362×362 を、原寸の正距円筒から再標本化する。式は
// src/render/cloud/field-projection.ts の OrthographicCap / equirectUvFromDirection と対。
function resampleCap(field, latitudeDeg, longitudeDeg) {
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
      const eu = Math.atan2(dir[0], dir[2]) / (2 * Math.PI) + 0.5;
      const ev = 0.5 - Math.asin(Math.min(1, Math.max(-1, dir[1]))) / Math.PI;
      out[by * CAP_BOX + bx] = sampleBilinear(field, eu * field.width - 0.5, ev * field.height - 0.5);
    }
  }
  return { width: CAP_BOX, height: CAP_BOX, data: out };
}

// 場をグレースケール PNG として .cloud-lab/compare/ へ書く。
function saveGray(name, field) {
  writeFileSync(path.join(outDir, name), fieldToGrayPng(field));
}

// 平均と、両端(<0.06 / >0.94)・中間調の割合。
function toneStats(field) {
  let low = 0;
  let mid = 0;
  let high = 0;
  let sum = 0;
  for (const v of field.data) {
    if (v < 0.06) low++;
    else if (v > 0.94) high++;
    else mid++;
    sum += v;
  }
  const n = field.data.length;
  return { low: low / n, mid: mid / n, high: high / n, mean: sum / n };
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
function printStructureTable(header, rows) {
  console.log(header);
  console.log(`尺度[km]  ${STRUCTURE_FIELDS.map((field) => `${field.label} 伸び/揃い/向き`).join('    ')}`);
  for (const { scale, cells } of rows) {
    const columns = cells.map((cell) =>
      `${cell.coherence.toFixed(2)} ${cell.r.toFixed(2)} ${cell.orientationDeg.toFixed(0).padStart(3)}°`);
    console.log(`${String(scale).padStart(5)}     ${columns.join('       ')}`);
  }
}

// 雲頂 [m] の分位。被覆率が CLOUD_TOP_COVERAGE を超え、mask(null なら全域)が立つ texel だけを
// 数える。area は数えた範囲に対する雲域の割合、金床は周り ANVIL_RADIUS_KM の雲の雲頂の平均も
// ANVIL_HEIGHT を超えているものの、ANVIL_HEIGHT を超える texel に対する割合。
function cloudTopStats(top, coverage, kmPerPx, mask) {
  const { width, height } = top;
  const stride = width + 1;
  // 周りの雲の雲頂の平均を半径に依らず一定の手数で引くための積算表。
  const sumTop = new Float64Array(stride * (height + 1));
  const sumCount = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cloudy = coverage.data[y * width + x] > CLOUD_TOP_COVERAGE ? 1 : 0;
      const i = (y + 1) * stride + (x + 1);
      sumTop[i] = cloudy * top.data[y * width + x] + sumTop[i - 1] + sumTop[i - stride] - sumTop[i - stride - 1];
      sumCount[i] = cloudy + sumCount[i - 1] + sumCount[i - stride] - sumCount[i - stride - 1];
    }
  }
  const boxSum = (table, x0, y0, x1, y1) => table[(y1 + 1) * stride + x1 + 1] - table[y0 * stride + x1 + 1]
    - table[(y1 + 1) * stride + x0] + table[y0 * stride + x0];
  const radius = Math.max(1, Math.round(ANVIL_RADIUS_KM / kmPerPx));

  const tops = [];
  let considered = 0;
  let high = 0;
  let anvils = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (mask !== null && mask[i] === 0) continue;
      considered++;
      if (coverage.data[i] <= CLOUD_TOP_COVERAGE) continue;
      tops.push(top.data[i]);
      if (top.data[i] <= ANVIL_HEIGHT) continue;
      high++;
      const x0 = Math.max(0, x - radius);
      const y0 = Math.max(0, y - radius);
      const x1 = Math.min(width - 1, x + radius);
      const y1 = Math.min(height - 1, y + radius);
      const count = boxSum(sumCount, x0, y0, x1, y1);
      if (count > 0 && boxSum(sumTop, x0, y0, x1, y1) / count > ANVIL_HEIGHT) anvils++;
    }
  }
  tops.sort((a, b) => a - b);
  const quantile = (fraction) => (tops.length === 0 ? 0 : tops[Math.min(tops.length - 1, Math.floor(tops.length * fraction))]);
  const share = (test) => tops.filter(test).length / Math.max(1, tops.length);
  return {
    area: tops.length / Math.max(1, considered),
    median: quantile(0.5),
    iqr: quantile(0.75) - quantile(0.25),
    below3: share((v) => v <= 3000),
    middle: share((v) => v > 3000 && v <= 7000),
    above9: share((v) => v > 9000),
    above12: share((v) => v > 12000),
    anvil: anvils / Math.max(1, high),
  };
}

// 実写と生成のオクターブ束スペクトルを波長帯ごとに並べ、比を添えて出す。wavelengthOf は
// 波数 → 波長 [km]。
function printSpectrumTable(header, wavelengthOf, reference, generated, referenceLabel, generatedLabel) {
  console.log(header);
  console.log(`波長帯 [km]      ${referenceLabel}   ${generatedLabel}   比(生成/実写)`);
  for (let i = 0; i < reference.length; i++) {
    const coarse = wavelengthOf(reference[i].k0);
    const fine = wavelengthOf(reference[i].k1);
    console.log(
      `${fine.toFixed(0).padStart(5)}-${coarse.toFixed(0).padStart(5)}  ${reference[i].value.toExponential(2)}  `
      + `${generated[i].value.toExponential(2)}  ${(generated[i].value / reference[i].value).toFixed(3)}`);
  }
}

async function main() {
  // 分離済みの成分を先に読む(無いなら撮影の前に気付かせる)。仮テクスチャは R が被覆率。
  const separatedThick = loadSeparated(path.join('src', 'assets', 'cloud-field.png'));
  const separatedVeil = loadSeparated(path.join('.cloud-lab', 'separated', 'veil.png'));
  // 気候の事前分布(G が平年の雲量、B が標高)。天気のモデルが読んでいるものと同じ写し。
  const climate = readFileSync(path.join(root, 'src', 'assets', 'earth-climate.png'));
  const meanCloudiness = resampleEquirect(decodeChannelPng(climate, 1), GLOBE_W, HEIGHT);
  const elevation = resampleEquirect(decodeChannelPng(climate, 2), GLOBE_W, HEIGHT);

  const overrides = knobOverrides();
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-cloud-compare-', onEvent,
  });
  const shots = new Map();
  let knobs = null;
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    await waitFor(
      devTools,
      "(document.getElementById('error')?.textContent || typeof window.cloudLab === 'object')",
      'the cloud lab to initialise',
    );
    const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
    if (failure) throw new Error(`Cloud lab failed to initialise: ${failure}`);

    if (overrides) await devTools.evaluate(`window.cloudLab.setParams(${JSON.stringify(overrides)})`);
    knobs = await devTools.evaluate('window.cloudLab.params()');

    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    await devTools.evaluate('window.cloudLab.setTime(0)');
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

  // 雲頂ビューの表示値は 0..CLOUD_TOP_SPAN を 0..1 に載せたもの。分位は [m] で取る。
  const metresOf = (field) => ({
    width: field.width, height: field.height, data: Float32Array.from(field.data, (v) => v * CLOUD_TOP_SPAN),
  });

  const boxX0 = GLOBE_W + (CAP_W - CAP_BOX) / 2;
  const boxY0 = (HEIGHT - CAP_BOX) / 2;
  const caps = new Map();
  const capTops = new Map();
  for (const region of REGIONS) {
    const thick = resampleCap(separatedThick, region.latitude, region.longitude);
    const veil = resampleCap(separatedVeil, region.latitude, region.longitude);
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

  console.log(`\nつまみ: ${JSON.stringify(knobs)}`);

  console.log('\n=== 帯状平均(全球面・5.625° 刻み) ===');
  console.log('緯度      実写計  実写厚  実写薄  被覆率  薄い雲  合成   被覆率/実写厚');
  for (let band = 0; band < 32; band++) {
    const latitude = 90 - (band + 0.5) * 5.625;
    const rowMeans = Object.fromEntries(Object.entries(globe).map(([key, field]) =>
      [key, toneStats(cropField(field, 0, band * 16, GLOBE_W, 16)).mean]));
    console.log(
      `${latitude.toFixed(1).padStart(6)}°  ${rowMeans.photo.toFixed(3)}  ${rowMeans.thick.toFixed(3)}  `
      + `${rowMeans.veil.toFixed(3)}  ${rowMeans.coverage.toFixed(3)}  ${rowMeans.translucent.toFixed(3)}  `
      + `${rowMeans.composite.toFixed(3)}  ${(rowMeans.coverage / Math.max(1e-6, rowMeans.thick)).toFixed(2)}`);
  }

  console.log('\n=== 階調(全球面・±60°): <0.06 / 中間 / >0.94 / 平均 ===');
  const y60 = rowAtLatitude(60);
  const bandHeight = rowAtLatitude(-60) - y60;
  for (const [label, key] of [['実写計', 'photo'], ['実写厚', 'thick'], ['合成', 'composite'], ['被覆率', 'coverage']]) {
    const t = toneStats(cropField(globe[key], 0, y60, GLOBE_W, bandHeight));
    console.log(`${label}: ${(t.low * 100).toFixed(1)}% / ${(t.mid * 100).toFixed(1)}% / ${(t.high * 100).toFixed(1)}% / ${t.mean.toFixed(3)}`);
  }

  console.log('\n=== 行方向スペクトル(全球面, 実写厚 vs 被覆率)===');
  for (const band of BANDS) {
    const y0 = rowAtLatitude(band.north);
    const h = rowAtLatitude(band.south) - y0;
    const circumference = 40075 * Math.cos((((band.north + band.south) / 2) * Math.PI) / 180);
    printSpectrumTable(
      `--- ${band.label} ---`, (k) => circumference / k,
      rowSpectrum(cropField(globe.thick, 0, y0, GLOBE_W, h)), rowSpectrum(cropField(globe.coverage, 0, y0, GLOBE_W, h)),
      '実写厚', '被覆率');
  }

  console.log('\n=== 地域別 cap(中央 362×362)の平均 ===');
  console.log('地域                                  実写計  実写厚  実写薄  被覆率  薄い雲  合成');
  for (const region of REGIONS) {
    const cap = caps.get(region.name);
    const means = Object.fromEntries(Object.entries(cap).map(([key, field]) => [key, toneStats(field).mean]));
    console.log(
      `${region.label.padEnd(24)}  ${means.photo.toFixed(3)}  ${means.thick.toFixed(3)}  ${means.veil.toFixed(3)}  `
      + `${means.coverage.toFixed(3)}  ${means.translucent.toFixed(3)}  ${means.composite.toFixed(3)}`);
  }

  console.log('\n=== 地域別 cap: 行方向スペクトル(実写厚 vs 被覆率)===');
  for (const region of REGIONS) {
    const cap = caps.get(region.name);
    printSpectrumTable(
      `--- ${region.label} ---`, (k) => (CAP_BOX * CAP_KM_PER_PX) / k,
      rowSpectrum(cap.thick), rowSpectrum(cap.coverage), '実写厚', '被覆率');
  }

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
  for (const band of BANDS) {
    const y0 = rowAtLatitude(band.north);
    const h = rowAtLatitude(band.south) - y0;
    printStructureTable(`--- ${band.label} ---`, GLOBE_SCALES_KM.map((scale) => ({
      scale,
      cells: STRUCTURE_FIELDS.map((field) =>
        summarizeStructure(globeStructures.get(field.key).get(scale), 0, y0, GLOBE_W, h)),
    })));
  }

  console.log('\n=== 構造の異方性(地域別 cap・尺度) ===');
  const capRowKm = new Array(CAP_BOX).fill(CAP_KM_PER_PX);
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
    printStructureTable(`--- ${region.label} ---`, CAP_SCALES_KM.map((scale) => ({
      scale,
      cells: STRUCTURE_FIELDS.map((field) =>
        summarizeStructure(structures.get(field.key).get(scale), 0, 0, CAP_BOX, CAP_BOX)),
    })));
  }

  console.log('\n=== 地形との関係(全球面・±60°、帯状平均を引いた偏差の相関) ===');
  console.log('場      平年雲量   標高');
  const inBand = (field) => zonalDeviation(cropField(field, 0, y60, GLOBE_W, bandHeight));
  const cloudinessDeviation = inBand(meanCloudiness);
  const elevationDeviation = inBand(elevation);
  for (const [label, key] of [['実写計', 'photo'], ['実写厚', 'thick'], ['実写薄', 'veil'],
    ['被覆率', 'coverage'], ['薄い雲', 'translucent'], ['合成', 'composite']]) {
    const deviation = inBand(globe[key]);
    console.log(`${label}   ${correlation(deviation, cloudinessDeviation).toFixed(3).padStart(6)}  `
      + `${correlation(deviation, elevationDeviation).toFixed(3).padStart(6)}`);
  }

  console.log('\n=== 地形の箱(平均) ===');
  console.log('箱                              平年雲量  実写計  合成   被覆率  薄い雲');
  for (const box of TERRAIN_BOXES) {
    const meanIn = (field) => toneStats(cropLatLonBox(field, box.north, box.south, box.west, box.east)).mean;
    console.log(`${box.label.padEnd(26)}  ${meanIn(meanCloudiness).toFixed(3)}  ${meanIn(globe.photo).toFixed(3)}  `
      + `${meanIn(globe.composite).toFixed(3)}  ${meanIn(globe.coverage).toFixed(3)}  ${meanIn(globe.translucent).toFixed(3)}`);
  }

  console.log('\n=== 雲頂(cap の中央 362×362・被覆率 > 0.3 の texel、生成のみ) ===');
  console.log('地域                                    雲域  中央値  四分位幅   ≤3km  3-7km   >9km  >12km   金床');
  const printCloudTop = (label, stats) => console.log(
    `${label.padEnd(30)}  ${(stats.area * 100).toFixed(0).padStart(3)}%  ${(stats.median / 1000).toFixed(1).padStart(4)} km`
    + `  ${(stats.iqr / 1000).toFixed(1).padStart(4)} km  ${(stats.below3 * 100).toFixed(0).padStart(4)}%`
    + `  ${(stats.middle * 100).toFixed(0).padStart(4)}%  ${(stats.above9 * 100).toFixed(1).padStart(5)}%`
    + `  ${(stats.above12 * 100).toFixed(1).padStart(5)}%  ${(stats.anvil * 100).toFixed(0).padStart(4)}%`);
  const capCenter = (CAP_BOX - 1) / 2;
  for (const region of REGIONS) {
    const top = capTops.get(region.name);
    const { coverage } = caps.get(region.name);
    if (region.coreRadiusKm === null) {
      printCloudTop(region.label, cloudTopStats(top, coverage, CAP_KM_PER_PX, null));
      continue;
    }
    // 中心濃密雲域は外側と分けて出す。平らな天蓋を持ってよいのはここだけ。
    const radius = region.coreRadiusKm / CAP_KM_PER_PX;
    const maskFor = (within) => Uint8Array.from({ length: CAP_BOX * CAP_BOX }, (_, i) => {
      const inside = Math.hypot((i % CAP_BOX) - capCenter, Math.floor(i / CAP_BOX) - capCenter) <= radius;
      return inside === within ? 1 : 0;
    });
    printCloudTop(`${region.label} 中心 ${region.coreRadiusKm} km`, cloudTopStats(top, coverage, CAP_KM_PER_PX, maskFor(true)));
    printCloudTop(`${region.label} 外側`, cloudTopStats(top, coverage, CAP_KM_PER_PX, maskFor(false)));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
