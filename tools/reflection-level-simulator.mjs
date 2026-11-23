import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ONE_PASS, PIXELS } from './reflection-chain-common.mjs';
import { band, curvatureOf } from './reflection-read-level-metrics.mjs';

export function loadLevels(dir) {
  return Array.from({ length: ONE_PASS }, (_, seed) => floats(
    path.join(dir, `level-production-s${seed}.f32`), PIXELS));
}

export function averageLevels(maps) {
  const result = new Float32Array(PIXELS);
  for (let pixel = 0; pixel < PIXELS; pixel++) {
    let total = 0;
    let count = 0;
    for (const map of maps) {
      if (map[pixel] < 0) continue;
      total += map[pixel];
      count++;
    }
    result[pixel] = count ? total / count : -1;
  }
  return result;
}

export function makeRoughBand(dir) {
  const roughness = floats(path.join(dir, 'roughness.f32'), PIXELS * 4);
  return Uint8Array.from({ length: PIXELS }, (_, pixel) =>
    band(roughness[pixel * 4] / 255, [0.1, 0.2, 0.3]));
}

export function makeCurveBand(dir) {
  const normal = floats(path.join(dir, 'normal.f32'), PIXELS * 4);
  const depth = floats(path.join(dir, 'depth.f32'), PIXELS * 4);
  return Uint8Array.from(curvatureOf(normal, depth), (value) => band(value, [0.002, 0.01, 0.05]));
}

export function floats(file, count) {
  const bytes = readFileSync(file);
  if (bytes.byteLength !== count * 4) throw new Error(`${file}: invalid float count`);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function loadLevelStack(dir, meta) {
  const means = [];
  const samples = [];
  for (let level = 0; level <= meta.lmax; level++) {
    means.push(readFloats(path.join(dir, level ? `q-L${level}.f32` : 'q-b.f32'), PIXELS * 4));
    samples.push(Array.from({ length: ONE_PASS }, (_, index) => readFloats(
      path.join(dir, `sample-L${level}-s${index}.f32`), PIXELS * 4)));
  }
  return { means, samples, lmax: meta.lmax };
}

export function composeMean(stack, lambda) {
  return compose(stack.means, lambda);
}

export function composeSample(stack, lambda, seed) {
  return compose(stack.samples.map((level) => level[seed]), lambda);
}

export function shifted(levels, amount) {
  return Float32Array.from(levels, (level) => Math.max(0, level + amount));
}

export function simulatedPoint(stack, maps) {
  const samples = maps.map((levels, seed) => composeSample(stack, levels, seed));
  const levels = new Float32Array(PIXELS);
  for (let pixel = 0; pixel < PIXELS; pixel++) {
    let total = 0;
    let count = 0;
    for (const map of maps) {
      if (map[pixel] < 0) continue;
      total += map[pixel];
      count++;
    }
    levels[pixel] = count ? total / count : 0;
  }
  return { mean: composeMean(stack, levels), samples };
}

function compose(images, lambda) {
  const result = new Float32Array(PIXELS * 4);
  for (let pixel = 0; pixel < PIXELS; pixel++) {
    const level = Math.max(0, Math.min(images.length - 1, lambda[pixel]));
    const lower = Math.floor(level);
    const upper = Math.min(images.length - 1, lower + 1);
    const mix = level - lower;
    const offset = pixel * 4;
    for (let channel = 0; channel < 4; channel++) {
      result[offset + channel] = images[lower][offset + channel] * (1 - mix)
        + images[upper][offset + channel] * mix;
    }
  }
  return result;
}

function readFloats(file, count) {
  const bytes = readFileSync(file);
  if (bytes.byteLength !== count * 4) throw new Error(`${file}: invalid float count`);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
