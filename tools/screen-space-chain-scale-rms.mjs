import { SCAN_HEIGHT, SCAN_WIDTH } from './screen-space-chain-runs.mjs';

// ぼかしの標準偏差 [走査の画素]。帯は「0」= 画素 − G_1、「s」= G_s − G_2s、最後の 32 は G_32 そのもの。
const SIGMAS = [1, 2, 4, 8, 16, 32];
export const SCALES = [0, ...SIGMAS];
const PIXEL_COUNT = (mask) => mask.reduce((count, value) => count + (value ? 1 : 0), 0);

function kernelOf(sigma) {
  const radius = Math.ceil(3 * sigma);
  const weights = new Float64Array(radius * 2 + 1);
  for (let offset = -radius; offset <= radius; offset++) {
    weights[offset + radius] = Math.exp(-0.5 * (offset / sigma) ** 2);
  }
  return { radius, weights };
}

function blurAxis(values, maskWeights, sigma, horizontal, size, valuesAlreadyWeighted = false) {
  const { width, height } = size;
  const pixels = width * height;
  const { radius, weights } = kernelOf(sigma);
  const result = new Float64Array(pixels * 4);
  const limit = horizontal ? width : height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let total = 0;
      const coordinate = horizontal ? x : y;
      for (let delta = -radius; delta <= radius; delta++) {
        const adjacent = coordinate + delta;
        if (adjacent < 0 || adjacent >= limit) continue;
        const source = horizontal ? y * width + adjacent : adjacent * width + x;
        if (maskWeights[source] === 0) continue;
        const weight = weights[delta + radius];
        const weightedSample = weight * maskWeights[source];
        total += weightedSample;
        const valueWeight = valuesAlreadyWeighted ? weight : weightedSample;
        red += values[source * 3] * valueWeight;
        green += values[source * 3 + 1] * valueWeight;
        blue += values[source * 3 + 2] * valueWeight;
      }
      const target = (y * width + x) * 3;
      result[target] = red;
      result[target + 1] = green;
      result[target + 2] = blue;
      result[pixels * 3 + y * width + x] = total;
    }
  }
  return result;
}

function gaussianLevels(values, mask, size) {
  const pixels = size.width * size.height;
  const weighted = new Float64Array(pixels * 3);
  for (let p = 0; p < pixels; p++) {
    if (!mask[p]) continue;
    for (let c = 0; c < 3; c++) weighted[p * 3 + c] = values[p * 4 + c];
  }
  return [weighted, ...SIGMAS.map((sigma) => {
    const horizontal = blurAxis(weighted, mask, sigma, true, size);
    const horizontalMask = horizontal.subarray(pixels * 3);
    const vertical = blurAxis(horizontal, horizontalMask, sigma, false, size, true);
    const blurred = new Float64Array(pixels * 3);
    for (let p = 0; p < pixels; p++) {
      const denominator = vertical[pixels * 3 + p];
      if (!(denominator > 0)) continue;
      for (let c = 0; c < 3; c++) blurred[p * 3 + c] = vertical[p * 3 + c] / denominator;
    }
    return blurred;
  })];
}

function forEachScaleValue(levels, mask, size, visit) {
  const pixels = size.width * size.height;
  for (let scale = 0; scale < SCALES.length; scale++) {
    const fine = levels[scale];
    const coarse = levels[scale + 1];
    for (let p = 0; p < pixels; p++) {
      if (!mask[p]) continue;
      for (let c = 0; c < 3; c++) {
        const value = fine[p * 3 + c] - (coarse === undefined ? 0 : coarse[p * 3 + c]);
        visit(scale, p, c, value);
      }
    }
  }
}

export const scaleRmsAccumulator = () => new Float64Array(SCALES.length * 3);

export function accumulateScaleRms(squares, values, mask, size = { width: SCAN_WIDTH, height: SCAN_HEIGHT }) {
  const levels = gaussianLevels(values, mask, size);
  forEachScaleValue(levels, mask, size, (scale, _pixel, channel, value) => {
    squares[scale * 3 + channel] += value * value;
  });
}

export const scaleMapAccumulator = (pixels = SCAN_WIDTH * SCAN_HEIGHT) =>
  new Float64Array(pixels * SCALES.length * 4);

export function accumulateScaleSquareMaps(maps, values, mask, size = { width: SCAN_WIDTH, height: SCAN_HEIGHT }) {
  const levels = gaussianLevels(values, mask, size);
  forEachScaleValue(levels, mask, size, (scale, pixel, channel, value) => {
    maps[pixel * SCALES.length * 4 + scale * 4 + channel] += value * value;
  });
}

export function scaleValueMaps(maps, values, mask, size = { width: SCAN_WIDTH, height: SCAN_HEIGHT }) {
  const levels = gaussianLevels(values, mask, size);
  forEachScaleValue(levels, mask, size, (scale, pixel, channel, value) => {
    maps[pixel * SCALES.length * 4 + scale * 4 + channel] += value;
  });
}

export function scaleSquareMapsOf(maps, sampleCount = 1) {
  return mapsOf(maps, sampleCount, true);
}

export function scaleValueMapsOf(maps, sampleCount = 1) {
  return mapsOf(maps, sampleCount, false);
}

function mapsOf(maps, sampleCount, squareRoot) {
  const pixels = maps.length / (SCALES.length * 4);
  return Object.fromEntries(SCALES.map((scale, s) => [String(scale), Float32Array.from({ length: pixels * 4 }, (_, i) => {
    if (i % 4 === 3) return 1;
    const value = maps[Math.floor(i / 4) * SCALES.length * 4 + s * 4 + i % 4] / sampleCount;
    return squareRoot ? Math.sqrt(value) : value;
  })]));
}

export function scaleRmsOf(squares, mask, sampleCount = 1) {
  const divisor = PIXEL_COUNT(mask) * sampleCount;
  return Object.fromEntries(SCALES.map((scale, index) => [String(scale), Array.from({ length: 3 }, (_, channel) =>
    Math.sqrt(squares[index * 3 + channel] / divisor))]));
}
