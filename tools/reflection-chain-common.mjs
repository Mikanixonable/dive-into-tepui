import { encodeRgbPng } from './png.mjs';
import { HEIGHT, WIDTH } from './screen-space-lab.mjs';

export const GRID = 64;
export const PIXELS = WIDTH * HEIGHT;
export const ONE_PASS = 8;
export const BASE_GRAPHICS = {
  screenSpaceSpecular: true, screenSpaceSpecularDenoise: true, screenSpaceOcclusion: false,
  screenSpaceIndirect: false, antialias: 0, lens: false,
};
export const SCENES = [
  { key: 'metal-room', caseName: 'metal-room', shot: 'metal-room' },
  { key: 'metal-room-close', caseName: 'metal-room', shot: 'metal-room-close' },
  { key: 'bay-metal', caseName: 'bay', shot: 'bay-metal' },
  { key: 'ladder-no-planet', caseName: 'reflection-ladder', shot: 'ladder-no-planet' },
  { key: 'ladder-checker-no-planet', caseName: 'reflection-ladder-checker', shot: 'ladder-checker-no-planet' },
];

export async function receiveFloats(devTools, source, length) {
  const out = new Float32Array(length);
  const bytesPerChunk = 64 * WIDTH * 3 * 4;
  for (let start = 0; start < length * 4; start += bytesPerChunk) {
    const size = Math.min(bytesPerChunk, length * 4 - start);
    const base64 = await devTools.evaluate(`new Uint8Array(${source}.buffer, ${start}, ${size}).toBase64()`);
    const bytes = Buffer.from(base64, 'base64');
    out.set(new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + size)), start / 4);
  }
  return out;
}

export async function readImage(devTools, name) {
  const [width, height, length] = await devTools.evaluate(`window.renderLab.readFloat(${JSON.stringify(name)})
    .then((image) => { window.__reflectionImage = image; return [image.width, image.height, image.rgba.length]; })`);
  const rgba = await receiveFloats(devTools, 'window.__reflectionImage.rgba', length);
  await devTools.evaluate('delete window.__reflectionImage');
  return { width, height, rgba };
}

export function seedsOf() {
  const g = 1.324717957244746;
  const cells = [];
  const seen = new Set();
  for (let n = 0; cells.length < GRID * GRID; n++) {
    const x = Math.floor(((n / g) % 1) * GRID);
    const y = Math.floor(((n / g ** 2) % 1) * GRID);
    const key = y * GRID + x;
    if (seen.has(key)) continue;
    seen.add(key);
    cells.push([x, y]);
  }
  return cells;
}

export function qImage(image, far, exposure) {
  const q = new Float32Array(image.rgba.length);
  for (let p = 0; p < PIXELS; p++) {
    const weight = image.rgba[p * 4 + 3];
    for (let c = 0; c < 3; c++) q[p * 4 + c] = exposure * (image.rgba[p * 4 + c] - far.rgba[p * 4 + c] * weight);
    q[p * 4 + 3] = weight;
  }
  return q;
}

export function meanImage(first, second, count) {
  const out = new Float32Array(first.rgba.length);
  for (let i = 0; i < out.length; i++) out[i] = (first.rgba[i] + (second?.rgba[i] ?? 0)) / count;
  return { width: first.width, height: first.height, rgba: out };
}

export function difference(a, b) {
  const out = new Float32Array(a.length);
  for (let p = 0; p < PIXELS; p++) {
    for (let c = 0; c < 3; c++) out[p * 4 + c] = a[p * 4 + c] - b[p * 4 + c];
    out[p * 4 + 3] = 1;
  }
  return out;
}

export async function takeReflectionSums(devTools, seeds) {
  for (let first = 0; first < seeds.length; first += 128) {
    const batch = seeds.slice(first, first + 128);
    await devTools.evaluate(`window.renderLab.addReflectionPasses(${JSON.stringify(batch)}, ${first})`);
    console.log(`${new Date().toISOString()} passes ${Math.min(first + 128, seeds.length)} / ${seeds.length}`);
  }
  const sizes = await devTools.evaluate(`window.renderLab.takeReflectionSums()
    .then((sums) => { window.__reflectionSums = sums; return sums.map((parity) => parity.map(({ width, height, rgba }) => [width, height, rgba.length])); })`);
  const result = [];
  for (let parity = 0; parity < 2; parity++) {
    const images = [];
    for (let kind = 0; kind < 2; kind++) {
      const [width, height, length] = sizes[parity][kind];
      images.push({ width, height, rgba: await receiveFloats(devTools, `window.__reflectionSums[${parity}][${kind}].rgba`, length) });
    }
    result.push(images);
  }
  await devTools.evaluate('delete window.__reflectionSums');
  return result;
}

export function colorPng(image, gain) {
  const rgb = new Uint8Array(PIXELS * 3);
  for (let p = 0; p < PIXELS; p++) for (let c = 0; c < 3; c++) {
    rgb[p * 3 + c] = Math.round(255 * srgb(Math.max(0, Math.min(1, image[p * 4 + c] * gain))));
  }
  return encodeRgbPng(WIDTH, HEIGHT, rgb);
}

export function centeredPng(image, gain) {
  const rgb = new Uint8Array(PIXELS * 3);
  for (let p = 0; p < PIXELS; p++) for (let c = 0; c < 3; c++) {
    rgb[p * 3 + c] = Math.round(255 * Math.max(0, Math.min(1, 0.5 + gain * image[p * 4 + c])));
  }
  return encodeRgbPng(WIDTH, HEIGHT, rgb);
}

export function srgb(value) {
  return value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
}

export function powerOfTwoAtMost(value) {
  return 2 ** Math.floor(Math.log2(Math.max(value, 2 ** -30)));
}

export function argumentOf(name) {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

export function graphicsOf(argument) {
  if (argument === undefined) return BASE_GRAPHICS;
  const parsed = JSON.parse(argument);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object'
      || Object.values(parsed).some((value) => typeof value !== 'boolean' && !Number.isFinite(value))) {
    throw new Error('--graphics must be a JSON object with boolean or numeric values');
  }
  return { ...BASE_GRAPHICS, ...parsed };
}

export function logStep(scene, step) {
  console.log(`${new Date().toISOString()} ${scene}: ${step}`);
}
