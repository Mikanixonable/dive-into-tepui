// assets-src/climate/ の標高画像(fetch-climate-source.mjs が取り込む)から、天気のモデルが読む
// 地球の気候の事前テクスチャ src/assets/earth-climate.png(正距円筒、RGB8)を焼く。
//   R: 平均気温 −40..40 °C を 0..255 に(緯度の余弦と、標高による気温減率から)
//   G: 平均湿度 0..1(海を 1、陸を 0 として球面上でぼかしたもの)
//   B: 標高 0..8000 m を 0..255 に(ぼかしたもの)
// 行 0 が北極、列 0 が経度 −180°(西端)。雲に比べてはるかに低周波の量なので解像度は粗くてよい。
//
// 実行: node tools/export-climate.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeGrayPng, encodeRgbPng } from './png.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = join(repoRoot, 'assets-src', 'climate', 'gebco_08_rev_elev_21600x10800.png');
const outPath = join(repoRoot, 'src', 'assets', 'earth-climate.png');

const WIDTH = 512;
const HEIGHT = 256;
// 標高画像の階調 255 に当たる標高 [m]。
const SOURCE_ELEVATION_SCALE = 6400;
// 出力の目盛り。
const TEMPERATURE_MIN = -40;
const TEMPERATURE_SPAN = 80;
const ELEVATION_SPAN = 8000;
// 平均気温 [°C] = TEMPERATURE_EQUATOR_OFFSET + TEMPERATURE_LATITUDE_AMPLITUDE × cos(緯度) − LAPSE_RATE × 標高。
const TEMPERATURE_EQUATOR_OFFSET = -5;
const TEMPERATURE_LATITUDE_AMPLITUDE = 35;
const LAPSE_RATE = 6.5e-3;
// 球面上のぼかしの σ [m]。湿度は海の影響が沿岸まで及ぶ幅、標高は風向との内積が滑らかになる幅。
const HUMIDITY_BLUR_SIGMA = 500e3;
const ELEVATION_BLUR_SIGMA = 200e3;
const EARTH_RADIUS = 6371e3;

const source = decodeGrayPng(readFileSync(sourcePath));

// 出力格子へ箱型で縮小する。標高は平均、海は「標高 0 の画素の割合」。
const elevationSum = new Float64Array(WIDTH * HEIGHT);
const seaSum = new Float64Array(WIDTH * HEIGHT);
const count = new Float64Array(WIDTH * HEIGHT);
for (let y = 0; y < source.height; y++) {
  const row = Math.floor((y * HEIGHT) / source.height) * WIDTH;
  for (let x = 0; x < source.width; x++) {
    const bin = row + Math.floor((x * WIDTH) / source.width);
    const value = source.data[y * source.width + x];
    elevationSum[bin] += (value / 255) * SOURCE_ELEVATION_SCALE;
    seaSum[bin] += value === 0 ? 1 : 0;
    count[bin] += 1;
  }
}
const elevation = elevationSum.map((sum, i) => sum / count[i]);
const sea = seaSum.map((sum, i) => sum / count[i]);

const latitudeOf = (y) => ((0.5 - (y + 0.5) / HEIGHT) * Math.PI);
const texelRadians = (2 * Math.PI) / WIDTH;

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

const humidity = blurOnSphere(sea, HUMIDITY_BLUR_SIGMA);
const elevationBlurred = blurOnSphere(elevation, ELEVATION_BLUR_SIGMA);

const toByte = (value) => Math.round(Math.min(1, Math.max(0, value)) * 255);
const rgb = new Uint8Array(WIDTH * HEIGHT * 3);
for (let y = 0; y < HEIGHT; y++) {
  const latitude = latitudeOf(y);
  for (let x = 0; x < WIDTH; x++) {
    const i = y * WIDTH + x;
    const temperature = TEMPERATURE_EQUATOR_OFFSET + TEMPERATURE_LATITUDE_AMPLITUDE * Math.cos(latitude)
      - LAPSE_RATE * elevationBlurred[i];
    rgb[i * 3] = toByte((temperature - TEMPERATURE_MIN) / TEMPERATURE_SPAN);
    rgb[i * 3 + 1] = toByte(humidity[i]);
    rgb[i * 3 + 2] = toByte(elevationBlurred[i] / ELEVATION_SPAN);
  }
}

const png = encodeRgbPng(WIDTH, HEIGHT, rgb);
writeFileSync(outPath, png);
console.log(`wrote ${outPath} (${WIDTH}x${HEIGHT}, ${png.length} bytes)`);
