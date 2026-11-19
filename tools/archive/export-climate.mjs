// assets-src/climate/ の NASA 配布データ(fetch-climate-source.mjs が取り込む)から、天気のモデルが
// 読む地球の気候・地形の事前テクスチャを焼く。
//   src/assets/earth-climate.png(正距円筒、512×256、RGB8)
//     R: 平均気温 −40..40 °C を 0..255 に(緯度の余弦と、標高による気温減率から)
//     G: 平年の雲量 0..1(MODIS の月平均雲量を全月・全年で平均したもの)
//     B: 標高 0..8000 m を 0..255 に(ぼかしたもの)
//   src/assets/earth-terrain.png(正距円筒、4096×2048、RGB8)
//     R: 東向きの地形勾配 [m/m]、±0.06 を 0..255 に(ゼロが中間)
//     G: 北向きの地形勾配、R と同じ符号化
//     B: 陸地の重み 0..1(標高 0..100 m の smoothstep を σ10 km でぼかしたもの)
// 行 0 が北極、列 0 が経度 −180°(西端)。気候は雲に比べて低周波の量なので粗く、地形は島の
// 上昇源を解像するため細かく取る。
//
// 実行: node tools/archive/export-climate.mjs
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeGrayPng, encodeRgbPng } from '../png.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const climateDir = join(repoRoot, 'assets-src', 'climate');
// 標高の入力。本来は NASA が配る GEBCO の画像(fetch-climate-source.mjs)だが、同じ 0..6400 m の
// 符号化へ畳んだ ETOPO1 由来の画像(グレー 8bit、21600×10800)も読める。どちらか一方があればよい。
const ELEVATION_CANDIDATES = [
  'gebco_08_rev_elev_21600x10800.png',
  'etopo1_elev_21600x10800.png',
];
const elevationPath = ELEVATION_CANDIDATES.map((name) => join(climateDir, name)).find(existsSync);
if (elevationPath === undefined) {
  throw new Error(`elevation source missing in ${climateDir}: run fetch-climate-source.mjs`);
}
console.log(`elevation: ${elevationPath}`);
const cloudFractionDir = join(climateDir, 'cloud-fraction');
const outPath = join(repoRoot, 'src', 'assets', 'earth-climate.png');
const terrainOutPath = join(repoRoot, 'src', 'assets', 'earth-terrain.png');

const WIDTH = 512;
const HEIGHT = 256;
// 地形の格子。赤道上で約 10 km/px — チェジュ島(約 73 km)を横へ約 7 px で解像する。
const TERRAIN_WIDTH = 4096;
const TERRAIN_HEIGHT = 2048;
// 標高画像の階調 255 に当たる標高 [m]。
const SOURCE_ELEVATION_SCALE = 6400;
// 雲量画像の目盛り。階調 CLOUD_FRACTION_SCALE が雲量 1、CLOUD_FRACTION_NO_DATA は観測なし。
const CLOUD_FRACTION_SCALE = 254;
const CLOUD_FRACTION_NO_DATA = 255;
// 出力の目盛り。
const TEMPERATURE_MIN = -40;
const TEMPERATURE_SPAN = 80;
const ELEVATION_SPAN = 8000;
// 平均気温 [°C] = TEMPERATURE_EQUATOR_OFFSET + TEMPERATURE_LATITUDE_AMPLITUDE × cos(緯度) − LAPSE_RATE × 標高。
const TEMPERATURE_EQUATOR_OFFSET = -5;
const TEMPERATURE_LATITUDE_AMPLITUDE = 35;
const LAPSE_RATE = 6.5e-3;
// 球面上のぼかしの σ [m]。雲量は観測の粒々と海岸線の段差を均す幅に留める — 実際の雲量は海岸で
// 急に変わるので、広く取るとその対比が消える。標高は風向との内積が滑らかになる幅。
const CLOUDINESS_BLUR_SIGMA = 100e3;
const ELEVATION_BLUR_SIGMA = 200e3;
const EARTH_RADIUS = 6371e3;
// 地形の勾配を読む前に標高へ掛けるぼかしの σ [m]。生の GEBCO そのままでは texel 級の崖が
// 勾配を暴れさせ、広く取ると小さな島が沈む。
const TERRAIN_ELEVATION_BLUR_SIGMA = 15e3;
// 陸地の重みのぼかしの σ [m]。海岸線を滑らかにしつつ、10 km 級の小島や湖は残す幅。
const TERRAIN_LAND_BLUR_SIGMA = 10e3;
// 地形勾配の符号化の半幅 [m/m]。量子化幅は ±0.06/255 ≈ 4.7e-4 m/m。
const TERRAIN_SLOPE_RANGE = 0.06;
// 陸地の重みとして数える標高の窓 [m]。climate.slope の LAND_ELEVATION と同じ幅。
const LAND_ELEVATION = 100;

const latitudeOf = (y, height) => ((0.5 - (y + 0.5) / height) * Math.PI);
const texelRadians = (width) => (2 * Math.PI) / width;

// 正距円筒のグレースケール画像を出力格子へ箱型で縮小する。value が null を返した画素は数えない。
function reduceToGrid(image, width, height, value, sum, count) {
  for (let y = 0; y < image.height; y++) {
    const row = Math.floor((y * height) / image.height) * width;
    for (let x = 0; x < image.width; x++) {
      const sample = value(image.data[y * image.width + x]);
      if (sample === null) continue;
      const bin = row + Math.floor((x * width) / image.width);
      sum[bin] += sample;
      count[bin] += 1;
    }
  }
}

// 観測が 1 つも入らなかった texel(極夜の極域)を、同じ経度の最も近い観測で埋める。
function fillGapsAlongColumns(field, count, width, height) {
  const fillFrom = (yFirst, yLast, step) => {
    for (let x = 0; x < width; x++) {
      let nearest = null;
      for (let y = yFirst; y !== yLast + step; y += step) {
        const i = y * width + x;
        if (count[i] > 0) nearest = field[i];
        else if (nearest !== null) field[i] = nearest;
      }
    }
  };
  fillFrom(0, height - 1, 1);
  fillFrom(height - 1, 0, -1);
}

// 緯度方向は固定幅、経度方向は cos(緯度) で伸ばした分離ガウスぼかし。経度は周回、緯度は端で止める。
function blurOnSphere(field, width, height, sigmaMeters) {
  const sigmaTexels = sigmaMeters / EARTH_RADIUS / texelRadians(width);
  const kernel = (sigma) => {
    const radius = Math.ceil(sigma * 3);
    const weights = [];
    for (let k = -radius; k <= radius; k++) weights.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
    const total = weights.reduce((a, b) => a + b, 0);
    return { radius, weights: weights.map((w) => w / total) };
  };
  const vertical = kernel(sigmaTexels);
  const pass1 = new Float64Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -vertical.radius; k <= vertical.radius; k++) {
        const yy = Math.min(height - 1, Math.max(0, y + k));
        sum += vertical.weights[k + vertical.radius] * field[yy * width + x];
      }
      pass1[y * width + x] = sum;
    }
  }
  const out = new Float64Array(width * height);
  for (let y = 0; y < height; y++) {
    const stretch = 1 / Math.max(Math.cos(latitudeOf(y, height)), 1e-3);
    const horizontal = kernel(Math.min(sigmaTexels * stretch, width / 6));
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -horizontal.radius; k <= horizontal.radius; k++) {
        const xx = (((x + k) % width) + width) % width;
        sum += horizontal.weights[k + horizontal.radius] * pass1[y * width + xx];
      }
      out[y * width + x] = sum;
    }
  }
  return out;
}

const toByte = (value) => Math.round(Math.min(1, Math.max(0, value)) * 255);
// THREE.MathUtils.smoothstep と同じ形。edge0 以下で 0、edge1 以上で 1。
const smoothstep = (edge0, edge1, value) => {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

const elevationImage = decodeGrayPng(readFileSync(elevationPath));

const elevationSum = new Float64Array(WIDTH * HEIGHT);
const elevationCount = new Float64Array(WIDTH * HEIGHT);
reduceToGrid(
  elevationImage, WIDTH, HEIGHT,
  (value) => (value / 255) * SOURCE_ELEVATION_SCALE,
  elevationSum, elevationCount,
);

// 雲量の月別ファイルが無ければ気候の出力は飛ばす — 地形の出力だけを更新できる。
if (existsSync(cloudFractionDir)) {
  const cloudinessSum = new Float64Array(WIDTH * HEIGHT);
  const cloudinessCount = new Float64Array(WIDTH * HEIGHT);
  for (const name of readdirSync(cloudFractionDir).sort()) {
    reduceToGrid(
      decodeGrayPng(readFileSync(join(cloudFractionDir, name))), WIDTH, HEIGHT,
      (value) => (value === CLOUD_FRACTION_NO_DATA ? null : value / CLOUD_FRACTION_SCALE),
      cloudinessSum, cloudinessCount,
    );
    console.log(`read ${name}`);
  }

  const cloudiness = cloudinessSum.map((sum, i) => (cloudinessCount[i] > 0 ? sum / cloudinessCount[i] : 0));
  fillGapsAlongColumns(cloudiness, cloudinessCount, WIDTH, HEIGHT);
  const cloudinessBlurred = blurOnSphere(cloudiness, WIDTH, HEIGHT, CLOUDINESS_BLUR_SIGMA);
  const elevationBlurred = blurOnSphere(
    elevationSum.map((sum, i) => sum / elevationCount[i]), WIDTH, HEIGHT, ELEVATION_BLUR_SIGMA);

  const rgb = new Uint8Array(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y++) {
    const latitude = latitudeOf(y, HEIGHT);
    for (let x = 0; x < WIDTH; x++) {
      const i = y * WIDTH + x;
      const temperature = TEMPERATURE_EQUATOR_OFFSET + TEMPERATURE_LATITUDE_AMPLITUDE * Math.cos(latitude)
        - LAPSE_RATE * elevationBlurred[i];
      rgb[i * 3] = toByte((temperature - TEMPERATURE_MIN) / TEMPERATURE_SPAN);
      rgb[i * 3 + 1] = toByte(cloudinessBlurred[i]);
      rgb[i * 3 + 2] = toByte(elevationBlurred[i] / ELEVATION_SPAN);
    }
  }

  const png = encodeRgbPng(WIDTH, HEIGHT, rgb);
  writeFileSync(outPath, png);
  console.log(`wrote ${outPath} (${WIDTH}x${HEIGHT}, ${png.length} bytes)`);
} else {
  console.log(`skip ${outPath} (no cloud-fraction sources)`);
}

// --- 地形(島・山地の上昇源を解像する細かい面)。気候と同じ GEBCO から別格子で焼く。 ---
const terrainElevationSum = new Float64Array(TERRAIN_WIDTH * TERRAIN_HEIGHT);
const terrainElevationCount = new Float64Array(TERRAIN_WIDTH * TERRAIN_HEIGHT);
reduceToGrid(
  elevationImage, TERRAIN_WIDTH, TERRAIN_HEIGHT,
  (value) => (value / 255) * SOURCE_ELEVATION_SCALE,
  terrainElevationSum, terrainElevationCount,
);
const terrainElevation = terrainElevationSum.map((sum, i) => sum / terrainElevationCount[i]);

// 勾配はぼかした標高の差分で取る。陸地の重みは生の標高から取って別の幅でぼかす。
const terrainSmoothed = blurOnSphere(terrainElevation, TERRAIN_WIDTH, TERRAIN_HEIGHT, TERRAIN_ELEVATION_BLUR_SIGMA);
const terrainLand = blurOnSphere(
  terrainElevation.map((elevation) => smoothstep(0, LAND_ELEVATION, elevation)),
  TERRAIN_WIDTH, TERRAIN_HEIGHT, TERRAIN_LAND_BLUR_SIGMA,
);

// 中心差分。東向きは 1 texel が張る実距離が cos(緯度) で縮むので実距離へ換算し、
// 北向きは行が小さいほど北(緯度が高い)なので上の行から下の行を引く。
const texelLongitude = texelRadians(TERRAIN_WIDTH);
const texelLatitude = Math.PI / TERRAIN_HEIGHT;
const terrainRgb = new Uint8Array(TERRAIN_WIDTH * TERRAIN_HEIGHT * 3);
for (let y = 0; y < TERRAIN_HEIGHT; y++) {
  const latitude = latitudeOf(y, TERRAIN_HEIGHT);
  const eastMeters = Math.max(EARTH_RADIUS * Math.cos(latitude) * texelLongitude, 1);
  const northMeters = EARTH_RADIUS * texelLatitude;
  for (let x = 0; x < TERRAIN_WIDTH; x++) {
    const i = y * TERRAIN_WIDTH + x;
    const eastSlope =
      (terrainSmoothed[y * TERRAIN_WIDTH + ((x + 1) % TERRAIN_WIDTH)]
        - terrainSmoothed[y * TERRAIN_WIDTH + (((x - 1) + TERRAIN_WIDTH) % TERRAIN_WIDTH)])
      / (2 * eastMeters);
    const northSlope =
      (terrainSmoothed[Math.max(0, y - 1) * TERRAIN_WIDTH + x]
        - terrainSmoothed[Math.min(TERRAIN_HEIGHT - 1, y + 1) * TERRAIN_WIDTH + x])
      / (2 * northMeters);
    terrainRgb[i * 3] = toByte(eastSlope / TERRAIN_SLOPE_RANGE * 0.5 + 0.5);
    terrainRgb[i * 3 + 1] = toByte(northSlope / TERRAIN_SLOPE_RANGE * 0.5 + 0.5);
    terrainRgb[i * 3 + 2] = toByte(terrainLand[i]);
  }
}

const terrainPng = encodeRgbPng(TERRAIN_WIDTH, TERRAIN_HEIGHT, terrainRgb);
writeFileSync(terrainOutPath, terrainPng);
console.log(`wrote ${terrainOutPath} (${TERRAIN_WIDTH}x${TERRAIN_HEIGHT}, ${terrainPng.length} bytes)`);
