// assets-src/climate/ の NASA 配布データ(fetch-climate-source.mjs が取り込む)から、天気のモデルが
// 読む地球の気候の事前テクスチャ src/assets/earth-climate.png(正距円筒、RGB8)を焼く。
//   R: 平均気温 −40..40 °C を 0..255 に(緯度の余弦と、標高による気温減率から)
//   G: 平年の雲量 0..1(MODIS の月平均雲量を全月・全年で平均したもの)
//   B: 標高 0..8000 m を 0..255 に(ぼかしたもの)
// 行 0 が北極、列 0 が経度 −180°(西端)。雲に比べてはるかに低周波の量なので解像度は粗くてよい。
//
// 実行: node tools/export-climate.mjs
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeGrayPng, encodeRgbPng } from './png.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const climateDir = join(repoRoot, 'assets-src', 'climate');
const elevationPath = join(climateDir, 'gebco_08_rev_elev_21600x10800.png');
const cloudFractionDir = join(climateDir, 'cloud-fraction');
const outPath = join(repoRoot, 'src', 'assets', 'earth-climate.png');

const WIDTH = 512;
const HEIGHT = 256;
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

const latitudeOf = (y) => ((0.5 - (y + 0.5) / HEIGHT) * Math.PI);
const texelRadians = (2 * Math.PI) / WIDTH;

// 正距円筒のグレースケール画像を出力格子へ箱型で縮小する。value が null を返した画素は数えない。
function reduceToGrid(image, value, sum, count) {
  for (let y = 0; y < image.height; y++) {
    const row = Math.floor((y * HEIGHT) / image.height) * WIDTH;
    for (let x = 0; x < image.width; x++) {
      const sample = value(image.data[y * image.width + x]);
      if (sample === null) continue;
      const bin = row + Math.floor((x * WIDTH) / image.width);
      sum[bin] += sample;
      count[bin] += 1;
    }
  }
}

// 観測が 1 つも入らなかった texel(極夜の極域)を、同じ経度の最も近い観測で埋める。
function fillGapsAlongColumns(field, count) {
  const fillFrom = (yFirst, yLast, step) => {
    for (let x = 0; x < WIDTH; x++) {
      let nearest = null;
      for (let y = yFirst; y !== yLast + step; y += step) {
        const i = y * WIDTH + x;
        if (count[i] > 0) nearest = field[i];
        else if (nearest !== null) field[i] = nearest;
      }
    }
  };
  fillFrom(0, HEIGHT - 1, 1);
  fillFrom(HEIGHT - 1, 0, -1);
}

// 緯度方向は固定幅、経度方向は cos(緯度) で伸ばした分離ガウスぼかし。経度は周回、緯度は端で止める。
function blurOnSphere(field, sigmaMeters) {
  const sigmaTexels = sigmaMeters / EARTH_RADIUS / texelRadians;
  const kernel = (sigma) => {
    const radius = Math.ceil(sigma * 3);
    const weights = [];
    for (let k = -radius; k <= radius; k++) weights.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
    const total = weights.reduce((a, b) => a + b, 0);
    return { radius, weights: weights.map((w) => w / total) };
  };
  const vertical = kernel(sigmaTexels);
  const pass1 = new Float64Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      let sum = 0;
      for (let k = -vertical.radius; k <= vertical.radius; k++) {
        const yy = Math.min(HEIGHT - 1, Math.max(0, y + k));
        sum += vertical.weights[k + vertical.radius] * field[yy * WIDTH + x];
      }
      pass1[y * WIDTH + x] = sum;
    }
  }
  const out = new Float64Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    const stretch = 1 / Math.max(Math.cos(latitudeOf(y)), 1e-3);
    const horizontal = kernel(Math.min(sigmaTexels * stretch, WIDTH / 6));
    for (let x = 0; x < WIDTH; x++) {
      let sum = 0;
      for (let k = -horizontal.radius; k <= horizontal.radius; k++) {
        const xx = (((x + k) % WIDTH) + WIDTH) % WIDTH;
        sum += horizontal.weights[k + horizontal.radius] * pass1[y * WIDTH + xx];
      }
      out[y * WIDTH + x] = sum;
    }
  }
  return out;
}

const elevationSum = new Float64Array(WIDTH * HEIGHT);
const elevationCount = new Float64Array(WIDTH * HEIGHT);
reduceToGrid(
  decodeGrayPng(readFileSync(elevationPath)),
  (value) => (value / 255) * SOURCE_ELEVATION_SCALE,
  elevationSum, elevationCount,
);

const cloudinessSum = new Float64Array(WIDTH * HEIGHT);
const cloudinessCount = new Float64Array(WIDTH * HEIGHT);
for (const name of readdirSync(cloudFractionDir).sort()) {
  reduceToGrid(
    decodeGrayPng(readFileSync(join(cloudFractionDir, name))),
    (value) => (value === CLOUD_FRACTION_NO_DATA ? null : value / CLOUD_FRACTION_SCALE),
    cloudinessSum, cloudinessCount,
  );
  console.log(`read ${name}`);
}

const cloudiness = cloudinessSum.map((sum, i) => (cloudinessCount[i] > 0 ? sum / cloudinessCount[i] : 0));
fillGapsAlongColumns(cloudiness, cloudinessCount);
const cloudinessBlurred = blurOnSphere(cloudiness, CLOUDINESS_BLUR_SIGMA);
const elevationBlurred = blurOnSphere(elevationSum.map((sum, i) => sum / elevationCount[i]), ELEVATION_BLUR_SIGMA);

const toByte = (value) => Math.round(Math.min(1, Math.max(0, value)) * 255);
const rgb = new Uint8Array(WIDTH * HEIGHT * 3);
for (let y = 0; y < HEIGHT; y++) {
  const latitude = latitudeOf(y);
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
