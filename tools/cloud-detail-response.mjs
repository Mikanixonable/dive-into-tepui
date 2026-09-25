// render-lab の既知波を、同じ shot の高解像画像を面積縮小した参照と比較する。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from './png.mjs';

const root = join(import.meta.dirname, '..', '.render-lab', 'native-shots');
const stem = 'earth-cloud-c1-raster-200km-medium-diagnostic';
const orientations = [0, 45, 90, 135];
const minimumRetainedAmplitude = 0.50;
let failed = false;

async function pixels(suffix, scale = 1) {
  const path = join(root, `${stem}-${suffix}${scale === 1 ? '' : '-1.5scale'}.png`);
  return decodePng(readFileSync(path));
}

function linear(byte) {
  const value = byte / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(image, factor) {
  if (image.width !== 720 * factor || image.height !== 405 * factor || image.channels !== 4) {
    throw new Error(`unexpected screenshot dimensions ${image.width}x${image.height}x${image.channels}`);
  }
  const result = new Float64Array(720 * 405);
  for (let y = 0; y < 405; y += 1) {
    for (let x = 0; x < 720; x += 1) {
      let sum = 0;
      for (let fy = 0; fy < factor; fy += 1) {
        for (let fx = 0; fx < factor; fx += 1) {
          const offset = ((y * factor + fy) * image.width + x * factor + fx) * 4;
          sum += 0.2126 * linear(image.data[offset])
            + 0.7152 * linear(image.data[offset + 1])
            + 0.0722 * linear(image.data[offset + 2]);
        }
      }
      result[y * 720 + x] = sum / (factor * factor);
    }
  }
  return result;
}

for (const direction of orientations) {
  const suffix = `wave-2km-${direction}deg`;
  const inverseSuffix = `wave-invert-2km-${direction}deg`;
  const [native, inverseNative, reference, inverseReference] = await Promise.all([
    pixels(suffix).then((image) => luminance(image, 1)),
    pixels(inverseSuffix).then((image) => luminance(image, 1)),
    pixels(suffix, 1.5).then((image) => luminance(image, 2)),
    pixels(inverseSuffix, 1.5).then((image) => luminance(image, 2)),
  ]);
  let sumN = 0;
  let sumR = 0;
  let sumNN = 0;
  let sumRR = 0;
  let sumNR = 0;
  let count = 0;
  // 中央領域はタイルの全寄与内に収まり、球面端・夕夜境界を含めない。
  for (let y = 101; y < 304; y += 1) {
    for (let x = 180; x < 540; x += 1) {
      const index = y * 720 + x;
      const n = native[index] - inverseNative[index];
      const r = reference[index] - inverseReference[index];
      sumN += n;
      sumR += r;
      sumNN += n * n;
      sumRR += r * r;
      sumNR += n * r;
      count += 1;
    }
  }
  const covariance = sumNR - sumN * sumR / count;
  const nativeVariance = sumNN - sumN * sumN / count;
  const referenceVariance = sumRR - sumR * sumR / count;
  if (referenceVariance <= 0 || nativeVariance <= 0) {
    throw new Error(`no measurable 2 km modulation at ${direction} degrees`);
  }
  const slope = covariance / referenceVariance;
  const correlation = covariance / Math.sqrt(nativeVariance * referenceVariance);
  const pass = slope >= minimumRetainedAmplitude;
  failed ||= !pass;
  console.log(JSON.stringify({ wavelengthKm: 2, directionDeg: direction, retainedAmplitude: slope, correlation, referenceRms: Math.sqrt(referenceVariance / count), pass }));
}
if (failed) process.exitCode = 1;
