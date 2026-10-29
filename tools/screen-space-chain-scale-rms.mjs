import { SCAN_HEIGHT, SCAN_WIDTH } from './screen-space-chain-runs.mjs';

// ぼかしの標準偏差 [走査の画素]。帯は「0」= 画素 − G_1、「s」= G_s − G_2s、最後の 32 は G_32 そのもの。
const SIGMAS = [1, 2, 4, 8, 16, 32];
export const SCALES = [0, ...SIGMAS];
const PIXELS = SCAN_WIDTH * SCAN_HEIGHT;
const PIXEL_COUNT = (mask) => mask.reduce((count, value) => count + (value ? 1 : 0), 0);

function kernelOf(sigma) {
  const radius = Math.ceil(3 * sigma);
  const weights = new Float64Array(radius * 2 + 1);
  for (let offset = -radius; offset <= radius; offset++) weights[offset + radius] = Math.exp(-0.5 * (offset / sigma) ** 2);
  return { radius, weights };
}

function blurAxis(values, maskWeights, sigma, horizontal, valuesAlreadyWeighted = false) {
  const { radius, weights } = kernelOf(sigma);
  const result = new Float64Array(PIXELS * 4);
  const limit = horizontal ? SCAN_WIDTH : SCAN_HEIGHT;
  for (let y = 0; y < SCAN_HEIGHT; y++) for (let x = 0; x < SCAN_WIDTH; x++) {
    let red = 0, green = 0, blue = 0, total = 0;
    const coordinate = horizontal ? x : y;
    for (let delta = -radius; delta <= radius; delta++) {
      const adjacent = coordinate + delta;
      if (adjacent < 0 || adjacent >= limit) continue;
      const source = horizontal ? y * SCAN_WIDTH + adjacent : adjacent * SCAN_WIDTH + x;
      if (maskWeights[source] === 0) continue;
      const weight = weights[delta + radius];
      const weightedSample = weight * maskWeights[source];
      total += weightedSample;
      const valueWeight = valuesAlreadyWeighted ? weight : weightedSample;
      red += values[source * 3] * valueWeight;
      green += values[source * 3 + 1] * valueWeight;
      blue += values[source * 3 + 2] * valueWeight;
    }
    const target = (y * SCAN_WIDTH + x) * 3;
    result[target] = red;
    result[target + 1] = green;
    result[target + 2] = blue;
    result[PIXELS * 3 + y * SCAN_WIDTH + x] = total;
  }
  return result;
}

function gaussianLevels(values, mask) {
  const weighted = new Float64Array(PIXELS * 3);
  for (let p = 0; p < PIXELS; p++) if (mask[p]) {
    for (let c = 0; c < 3; c++) weighted[p * 3 + c] = values[p * 4 + c];
  }
  return [weighted, ...SIGMAS.map((sigma) => {
    const horizontal = blurAxis(weighted, mask, sigma, true);
    const horizontalMask = horizontal.subarray(PIXELS * 3);
    const vertical = blurAxis(horizontal, horizontalMask, sigma, false, true);
    const blurred = new Float64Array(PIXELS * 3);
    for (let p = 0; p < PIXELS; p++) {
      const denominator = vertical[PIXELS * 3 + p];
      if (denominator > 0) for (let c = 0; c < 3; c++) blurred[p * 3 + c] = vertical[p * 3 + c] / denominator;
    }
    return blurred;
  })];
}

function addBandSquares(squares, levels, mask) {
  for (let scale = 0; scale < SCALES.length; scale++) {
    const fine = levels[scale];
    const coarse = levels[scale + 1];
    const offset = scale * 3;
    for (let p = 0; p < PIXELS; p++) if (mask[p]) for (let c = 0; c < 3; c++) {
      const value = fine[p * 3 + c] - (coarse === undefined ? 0 : coarse[p * 3 + c]);
      squares[offset + c] += value * value;
    }
  }
}

export const scaleRmsAccumulator = () => new Float64Array(SCALES.length * 3);

export function accumulateScaleRms(squares, values, mask) {
  addBandSquares(squares, gaussianLevels(values, mask), mask);
}

export function scaleRmsOf(squares, mask, sampleCount = 1) {
  const divisor = PIXEL_COUNT(mask) * sampleCount;
  return Object.fromEntries(SCALES.map((scale, index) => [String(scale), Array.from({ length: 3 }, (_, channel) =>
    Math.sqrt(squares[index * 3 + channel] / divisor))]));
}
