import { accumulateScaleRms, scaleRmsAccumulator, scaleRmsOf } from './screen-space-chain-scale-rms.mjs';
import { PIXELS } from './reflection-chain-common.mjs';
import { HEIGHT, WIDTH } from './screen-space-lab.mjs';

const BLOCK_COLUMNS = Math.ceil(WIDTH / 8);
const BLOCK_ROWS = Math.ceil(HEIGHT / 8);
const BLOCK_COUNT = BLOCK_COLUMNS * BLOCK_ROWS;
const BLOCK_OF_PIXEL = new Int32Array(PIXELS);
for (let pixel = 0; pixel < PIXELS; pixel++) {
  const row = Math.floor(pixel / WIDTH);
  const column = pixel % WIDTH;
  BLOCK_OF_PIXEL[pixel] = Math.floor(row / 8) * BLOCK_COLUMNS + Math.floor(column / 8);
}

export function pointMetrics(mean, samples, base, groups) {
  const result = {};
  const blockSums = new Float64Array(BLOCK_COUNT * 3);
  const blockCounts = new Int32Array(BLOCK_COUNT);
  for (const [name, mask] of Object.entries(groups)) {
    let structure = 0;
    let noise = 0;
    let blockNoise = 0;
    let count = 0;
    blockSums.fill(0);
    blockCounts.fill(0);
    for (let pixel = 0; pixel < PIXELS; pixel++) {
      if (!mask[pixel]) continue;
      count++;
      const offset = pixel * 4;
      const block = BLOCK_OF_PIXEL[pixel];
      blockCounts[block]++;
      for (let channel = 0; channel < 3; channel++) {
        const delta = mean[offset + channel] - base[offset + channel];
        structure += delta * delta;
      }
    }
    for (const sample of samples) {
      blockSums.fill(0);
      for (let pixel = 0; pixel < PIXELS; pixel++) {
        if (!mask[pixel]) continue;
        const offset = pixel * 4;
        const block = BLOCK_OF_PIXEL[pixel];
        for (let channel = 0; channel < 3; channel++) {
          const residual = sample[offset + channel] - mean[offset + channel];
          noise += residual * residual;
          blockSums[block * 3 + channel] += residual;
        }
      }
      for (let block = 0; block < BLOCK_COUNT; block++) {
        const pixels = blockCounts[block];
        if (!pixels) continue;
        for (let channel = 0; channel < 3; channel++) {
          const sum = blockSums[block * 3 + channel];
          blockNoise += pixels * (sum / pixels) ** 2;
        }
      }
    }
    result[name] = {
      S: Math.sqrt(structure / Math.max(count, 1)),
      N: Math.sqrt(noise / Math.max(count * samples.length, 1)),
      N8: Math.sqrt(blockNoise / Math.max(count * samples.length, 1)),
    };
  }
  return result;
}

export function metricGroups(mask, rough, curve, levelCurrent) {
  const groups = { all: mask };
  for (let value = 0; value < 4; value++) {
    groups[`rough-${value}`] = Uint8Array.from(mask,
      (inside, pixel) => Number(inside && rough[pixel] === value));
    groups[`curve-${value}`] = Uint8Array.from(mask,
      (inside, pixel) => Number(inside && curve[pixel] === value));
  }
  groups['no-rim'] = Uint8Array.from(mask,
    (inside, pixel) => Number(inside && curve[pixel] !== 3));
  groups['no-rim-fine'] = Uint8Array.from(mask,
    (inside, pixel) => Number(inside && curve[pixel] !== 3
      && levelCurrent[pixel] >= 0 && levelCurrent[pixel] < 2));
  return groups;
}

export function errorOf(image, base) {
  const result = new Float32Array(PIXELS);
  for (let pixel = 0; pixel < PIXELS; pixel++) {
    for (let channel = 0; channel < 3; channel++) result[pixel] += (image[pixel * 4 + channel] - base[pixel * 4 + channel]) ** 2;
  }
  return result;
}

export function absDifference(image, base) {
  const result = new Float32Array(image.length);
  for (let index = 0; index < image.length; index++) result[index] = image[index] - base[index];
  return result;
}

export function boxAverage(values, mask, radius) {
  const stride = WIDTH + 1;
  const area = (WIDTH + 1) * (HEIGHT + 1);
  const integral = new Float64Array(area);
  const counts = new Float64Array(area);
  for (let y = 0; y < HEIGHT; y++) {
    let row = 0;
    let rowCount = 0;
    for (let x = 0; x < WIDTH; x++) {
      const pixel = y * WIDTH + x;
      if (mask[pixel]) {
        row += values[pixel];
        rowCount++;
      }
      const index = (y + 1) * stride + x + 1;
      integral[index] = integral[index - stride] + row;
      counts[index] = counts[index - stride] + rowCount;
    }
  }
  const result = new Float32Array(PIXELS);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(WIDTH, x + radius + 1);
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(HEIGHT, y + radius + 1);
      const topLeft = y0 * stride + x0;
      const topRight = y0 * stride + x1;
      const bottomLeft = y1 * stride + x0;
      const bottomRight = y1 * stride + x1;
      const count = counts[bottomRight] - counts[topRight] - counts[bottomLeft] + counts[topLeft];
      const sum = integral[bottomRight] - integral[topRight] - integral[bottomLeft] + integral[topLeft];
      result[y * WIDTH + x] = count ? sum / count : 0;
    }
  }
  return result;
}

export function curvatureOf(encodedNormals, depth) {
  const normals = new Float32Array(PIXELS * 3);
  for (let pixel = 0; pixel < PIXELS; pixel++) {
    const x = encodedNormals[pixel * 4] * 2 - 1;
    const y = encodedNormals[pixel * 4 + 1] * 2 - 1;
    const z = 1 - Math.abs(x) - Math.abs(y);
    let nx = x;
    let ny = y;
    const nz = z;
    if (z < 0) {
      nx = (1 - Math.abs(y)) * Math.sign(x || 1);
      ny = (1 - Math.abs(x)) * Math.sign(y || 1);
    }
    const length = Math.hypot(nx, ny, nz) || 1;
    normals.set([nx / length, ny / length, nz / length], pixel * 3);
  }
  const result = new Float32Array(PIXELS);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const pixel = y * WIDTH + x;
      if (depth[pixel * 4] === 0) continue;
      const left = x ? vectorDifference(normals, pixel, pixel - 1) : Infinity;
      const right = x + 1 < WIDTH ? vectorDifference(normals, pixel, pixel + 1) : Infinity;
      const up = y ? vectorDifference(normals, pixel, pixel - WIDTH) : Infinity;
      const down = y + 1 < HEIGHT ? vectorDifference(normals, pixel, pixel + WIDTH) : Infinity;
      result[pixel] = Math.max(Math.min(left, right), Math.min(up, down));
    }
  }
  return result;
}

function vectorDifference(normals, first, second) {
  let sum = 0;
  for (let channel = 0; channel < 3; channel++) sum += (normals[first * 3 + channel] - normals[second * 3 + channel]) ** 2;
  return Math.sqrt(sum);
}

export function band(value, cuts) {
  if (value < cuts[0]) return 0;
  if (value < cuts[1]) return 1;
  if (value < cuts[2]) return 2;
  return 3;
}

export function rms(values, mask) {
  let sum = 0;
  let count = 0;
  for (let pixel = 0; pixel < PIXELS; pixel++) {
    if (!mask[pixel]) continue;
    sum += values[pixel];
    count++;
  }
  return Math.sqrt(sum / Math.max(count, 1));
}

export function quantile(image, mask, fraction) {
  const values = [];
  for (let pixel = 0; pixel < PIXELS; pixel++) {
    if (mask[pixel]) {
      for (let channel = 0; channel < 3; channel++) values.push(Math.abs(image[pixel * 4 + channel]));
    }
  }
  values.sort((first, second) => first - second);
  return values[Math.floor((values.length - 1) * fraction)] ?? 0;
}

export function groupMetrics(mask, current, balanced, production, oracle, base, productionNoise, oracleNoise, rough, curve) {
  const groups = [['all', () => true]];
  for (let value = 0; value < 4; value++) groups.push([`rough-${value}`, (pixel) => rough[pixel] === value]);
  for (let value = 0; value < 4; value++) groups.push([`curve-${value}`, (pixel) => curve[pixel] === value]);
  for (let roughness = 0; roughness < 4; roughness++) {
    for (let curvature = 0; curvature < 4; curvature++) {
      groups.push([`rough-${roughness}-curve-${curvature}`, (pixel) => rough[pixel] === roughness && curve[pixel] === curvature]);
    }
  }
  const result = {};
  for (const [name, select] of groups) {
    const indices = [];
    for (let pixel = 0; pixel < PIXELS; pixel++) {
      if (mask[pixel] && select(pixel)) indices.push(pixel);
    }
    result[name] = { count: indices.length,
      metrics: stats(indices, current, balanced, production, oracle, base, productionNoise, oracleNoise) };
  }
  return result;
}

function stats(indices, current, balanced, production, oracle, base, productionNoise, oracleNoise) {
  let currentLevel = 0;
  let balancedLevel = 0;
  let over = 0;
  let under = 0;
  let productionStructure = 0;
  let oracleStructure = 0;
  let productionNoiseSum = 0;
  let oracleNoiseSum = 0;
  for (const pixel of indices) {
    const difference = current[pixel] - balanced[pixel];
    currentLevel += current[pixel];
    balancedLevel += balanced[pixel];
    over += difference >= 1 ? 1 : 0;
    under += difference <= -1 ? 1 : 0;
    for (let channel = 0; channel < 3; channel++) {
      productionStructure += (production[pixel * 4 + channel] - base[pixel * 4 + channel]) ** 2;
      oracleStructure += (oracle[pixel * 4 + channel] - base[pixel * 4 + channel]) ** 2;
    }
    productionNoiseSum += productionNoise[pixel];
    oracleNoiseSum += oracleNoise[pixel];
  }
  const count = Math.max(indices.length, 1);
  return {
    meanLcur: currentLevel / count,
    meanLbal: balancedLevel / count,
    overAtLeastOne: over / count,
    overAtMostMinusOne: under / count,
    productionStructuralRms: Math.sqrt(productionStructure / count),
    oracleStructuralRms: Math.sqrt(oracleStructure / count),
    productionNoiseRms: Math.sqrt(productionNoiseSum / count),
    oracleNoiseRms: Math.sqrt(oracleNoiseSum / count),
  };
}

export function scaleMetrics(production, oracle, base, sampleProduction, sampleOracle, mask) {
  const result = {};
  const metrics = [
    ['production-minus-b', absDifference(production, base)],
    ['oracle-minus-b', absDifference(oracle, base)],
    ['sample-production', absDifference(sampleProduction, production)],
    ['sample-oracle', absDifference(sampleOracle, oracle)],
  ];
  for (const [name, image] of metrics) {
    const sums = scaleRmsAccumulator({ width: WIDTH, height: HEIGHT });
    accumulateScaleRms(sums, image, mask, { width: WIDTH, height: HEIGHT });
    result[name] = scaleRmsOf(sums, mask, 1, { width: WIDTH, height: HEIGHT });
  }
  return result;
}
