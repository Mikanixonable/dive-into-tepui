// 手順8-15の収束した走査出力を、帯ごとに同じ尺度のPNGへ戻す。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { encodeRgbPng } from './png.mjs';
import { shotsDir, unpackedBand } from './screen-space-lab.mjs';

const root = path.join(shotsDir, 'ssd-8-15-chain-metrics');
const output = path.join(root, 'band-debug');
const runs = ['before-a', 'a'];
const scenes = ['angled-bounce', 'cornell-box'];
const width = 240, height = 135, bands = 4;
const results = [];

function floats(file) {
  const bytes = readFileSync(file);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

for (const scene of scenes) {
  const images = [];
  for (const run of runs) {
    const metrics = JSON.parse(readFileSync(path.join(root, 'runs', run, scene, 'metrics.json'), 'utf8'));
    const cache = path.join(root, 'cache', scene, metrics.cacheKey);
    const packed = Array.from({ length: 3 }, (_, index) => floats(path.join(cache, `mean-1024-packed-${index}.f32`)));
    for (let band = 0; band < bands; band++) images.push({ run, band, values: unpackedBand(packed, band) });
  }
  const magnitudes = images.flatMap(({ values }) => Array.from(values, Math.abs)).sort((a, b) => a - b);
  const scale = magnitudes[Math.floor(0.999 * (magnitudes.length - 1))] || 1;
  for (const image of images) {
    const dir = path.join(output, scene, image.run);
    mkdirSync(dir, { recursive: true });
    const rgb = Uint8Array.from(image.values, (value) =>
      Math.round(127.5 + 127.5 * Math.max(-1, Math.min(1, value / scale))));
    writeFileSync(path.join(dir, `band-${image.band}.png`), encodeRgbPng(width, height, rgb));
    const meanAbsolute = image.values.reduce((sum, value) => sum + Math.abs(value), 0) / image.values.length;
    const rms = Math.sqrt(image.values.reduce((sum, value) => sum + value * value, 0) / image.values.length);
    results.push({ scene, run: image.run, band: image.band, scale, meanAbsolute, rms });
  }
}

writeFileSync(path.join(output, 'metrics.json'), JSON.stringify(results, null, 2));
const rows = scenes.map((scene) => `<h2>${scene}</h2>${runs.map((run) =>
  `<h3>${run}</h3><div class="row">${Array.from({ length: bands }, (_, band) =>
    `<figure><img src="${scene}/${run}/band-${band}.png"><figcaption>band ${band}</figcaption></figure>`).join('')}</div>`).join('')}`).join('');
writeFileSync(path.join(output, 'index.html'), `<!doctype html><meta charset="utf-8"><title>8-15 band debug</title>
<style>body{background:#222;color:white;font:16px sans-serif} .row{display:flex;gap:12px}figure{margin:0}
img{width:480px;height:270px;image-rendering:pixelated}</style>${rows}`);
console.log(path.join(output, 'index.html'));
