import { PIXELS } from './reflection-chain-common.mjs';
import { HEIGHT, WIDTH } from './screen-space-lab.mjs';

const BLOCK_COLUMNS = (size) => Math.ceil(WIDTH / size);

export function blockIndex(size) {
  const result = new Int32Array(PIXELS);
  const columns = BLOCK_COLUMNS(size);
  for (let pixel = 0; pixel < PIXELS; pixel++) {
    const y = Math.floor(pixel / WIDTH);
    result[pixel] = Math.floor(y / size) * columns + Math.floor((pixel % WIDTH) / size);
  }
  return result;
}

function blockNoise(residuals, mask, size) {
  const indices = blockIndex(size);
  const blockCount = Math.ceil(WIDTH / size) * Math.ceil(HEIGHT / size);
  const sums = new Float64Array(blockCount * 3);
  const counts = new Int32Array(blockCount);
  let total = 0;
  for (const residual of residuals) {
    sums.fill(0);
    counts.fill(0);
    for (let pixel = 0; pixel < PIXELS; pixel++) {
      if (!mask[pixel]) continue;
      const block = indices[pixel];
      counts[block]++;
      for (let channel = 0; channel < 3; channel++) {
        sums[block * 3 + channel] += residual[pixel * 4 + channel];
      }
    }
    for (let block = 0; block < blockCount; block++) {
      const count = counts[block];
      if (!count) continue;
      for (let channel = 0; channel < 3; channel++) {
        total += sums[block * 3 + channel] ** 2 / count;
      }
    }
  }
  return total / Math.max(residuals.length * mask.reduce((sum, value) => sum + Number(Boolean(value)), 0), 1);
}

export function noiseBands(residuals, mask, sizes) {
  const pixels = mask.reduce((sum, value) => sum + Number(Boolean(value)), 0);
  const powers = Object.fromEntries(sizes.map((size) => [size, blockNoise(residuals, mask, size)]));
  const N = Math.sqrt(powers[1] ?? blockNoise(residuals, mask, 1));
  const shares = {};
  for (let index = 0; index < sizes.length - 1; index++) {
    const size = sizes[index];
    shares[String(size)] = N ? (powers[size] - powers[sizes[index + 1]]) / (N * N) : 0;
  }
  const last = sizes.at(-1);
  shares[`${last}+`] = N ? powers[last] / (N * N) : 0;
  return { pixels, energy: (N * N) * pixels, N, sizes: Object.fromEntries(sizes.map((size) => [size, Math.sqrt(powers[size])])), shares };
}

export function noiseMaps(residuals, mask) {
  const all = new Float32Array(PIXELS);
  const fine = new Float32Array(PIXELS);
  const coarse = new Float32Array(PIXELS);
  const indices = blockIndex(8);
  const blockCount = Math.ceil(WIDTH / 8) * Math.ceil(HEIGHT / 8);
  for (let seed = 0; seed < residuals.length; seed++) {
    const residual = residuals[seed];
    const sums = new Float64Array(blockCount * 3);
    const counts = new Int32Array(blockCount);
    for (let pixel = 0; pixel < PIXELS; pixel++) {
      if (!mask[pixel]) continue;
      const block = indices[pixel];
      counts[block]++;
      for (let channel = 0; channel < 3; channel++) sums[block * 3 + channel] += residual[pixel * 4 + channel];
    }
    for (let pixel = 0; pixel < PIXELS; pixel++) {
      if (!mask[pixel]) continue;
      const block = indices[pixel];
      let blockSquare = 0;
      let fineSquare = 0;
      let allSquare = 0;
      for (let channel = 0; channel < 3; channel++) {
        const mean = sums[block * 3 + channel] / counts[block];
        const value = residual[pixel * 4 + channel];
        blockSquare += mean * mean;
        fineSquare += (value - mean) ** 2;
        allSquare += value * value;
      }
      coarse[pixel] += blockSquare / residuals.length;
      fine[pixel] += fineSquare / residuals.length;
      all[pixel] += allSquare / residuals.length;
    }
  }
  for (let pixel = 0; pixel < PIXELS; pixel++) {
    all[pixel] = Math.sqrt(all[pixel]);
    fine[pixel] = Math.sqrt(fine[pixel]);
    coarse[pixel] = Math.sqrt(coarse[pixel]);
  }
  return { all, fine, coarse };
}

function leakMap(residuals, rawResiduals, mask, overall) {
  const indices = blockIndex(overall ? WIDTH + HEIGHT : 8);
  const blocks = overall ? 1 : Math.ceil(WIDTH / 8) * Math.ceil(HEIGHT / 8);
  const numerator = new Float64Array(blocks);
  const denominator = new Float64Array(blocks);
  for (let seed = 0; seed < residuals.length; seed++) {
    for (let pixel = 0; pixel < PIXELS; pixel++) {
      if (!mask[pixel]) continue;
      const block = overall ? 0 : indices[pixel];
      for (let channel = 0; channel < 3; channel++) {
        const raw = rawResiduals[seed][pixel * 4 + channel];
        numerator[block] += residuals[seed][pixel * 4 + channel] * raw;
        denominator[block] += raw * raw;
      }
    }
  }
  const result = new Float32Array(PIXELS);
  for (let pixel = 0; pixel < PIXELS; pixel++) {
    if (!mask[pixel]) continue;
    const block = overall ? 0 : indices[pixel];
    result[pixel] = denominator[block] ? numerator[block] / denominator[block] : 0;
  }
  return overall ? (denominator[0] ? numerator[0] / denominator[0] : 0) : result;
}

export const rawLeakOverall = (residuals, rawResiduals, mask) => leakMap(residuals, rawResiduals, mask, true);
export const rawLeak = (residuals, rawResiduals, mask) => leakMap(residuals, rawResiduals, mask, false);
