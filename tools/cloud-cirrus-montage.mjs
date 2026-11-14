// 巻雲層だけの生成と実写を 1 枚に並べたモンタージュ。cloud-lab-compare の cirrusStructure
// が測るのと同じ対・同じ箱・同じ矩形で、左に生成の巻雲層の撮影の輝度
// (.cloud-lab/render-capture-cirrus)、右に帯 13 の輝度温度から切り分けた高層雲の冷たさ
// (.cloud-lab/reference-fine の band13 フレーム) を 0..1 の濃淡で並べる。
// 対ごとに 512×512 (片側 256×512 の箱へ縦横比を保って内接) のグレースケール PNG を
// .cloud-lab/cirrus-montage/<地域>-<梯子>.png へ書く。
//
// 実行: node tools/cloud-cirrus-montage.mjs

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng } from './png.mjs';
import { cropField, fieldToGrayPng } from './gray-image.mjs';
import { resampleCaptureToBox } from './cloud-fine-structure.mjs';
import {
  coldnessField,
  invertBrightnessTemperature,
  parseBand13Colormap,
} from './cloud-brightness-temperature.mjs';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, '.cloud-lab', 'cirrus-montage');
// 実写フレームと同じ箱の格子 [px]。対の矩形はこの格子の上で取る。
const BOX_WIDTH = 960;
const BOX_HEIGHT = 540;
// 出力の寸法 [px] と片側の幅。
const TILE = 512;
const PANEL_WIDTH = 256;

// sRGB の 8bit 値 → 線形の 0..1。
function linearOf(srgb) {
  const c = srgb / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

// 線形の 0..1 → sRGB の 0..1。
function srgbOf(linear) {
  const c = Math.min(1, Math.max(0, linear));
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

// 8bit・非インターレースの RGB / RGBA の PNG を、線形化した R・G・B の平均 (輝度 0..1) の場で返す。
function decodeLuminancePng(png) {
  const { width, height, channels, data } = decodePng(png);
  const out = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const p = i * channels;
    out[i] = (linearOf(data[p]) + linearOf(data[p + 1]) + linearOf(data[p + 2])) / 3;
  }
  return { width, height, data: out };
}

// 場を w × h へ双一次で縮める。モンタージュへ並べるための表示用の変換。
function resizeField(field, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const py = (y + 0.5) * (field.height / h) - 0.5;
    const y0 = Math.max(0, Math.floor(py));
    const y1 = Math.min(field.height - 1, y0 + 1);
    const fy = Math.min(1, Math.max(0, py - y0));
    for (let x = 0; x < w; x++) {
      const px = (x + 0.5) * (field.width / w) - 0.5;
      const x0 = Math.max(0, Math.floor(px));
      const x1 = Math.min(field.width - 1, x0 + 1);
      const fx = Math.min(1, Math.max(0, px - x0));
      out[y * w + x] = field.data[y0 * field.width + x0] * (1 - fx) * (1 - fy)
        + field.data[y0 * field.width + x1] * fx * (1 - fy)
        + field.data[y1 * field.width + x0] * (1 - fx) * fy
        + field.data[y1 * field.width + x1] * fx * fy;
    }
  }
  return { width: w, height: h, data: out };
}

// 生成と実写の場を左右へ並べた 512×512 の場。両側は同じ矩形の写しで寸法が同じなので、
// 共通の縮尺で片側 256×512 の箱へ内接させ、余白は 0 のまま残す。
// 左は撮影が見せていた明るさ (sRGB) へ戻した輝度、右は冷たさの値をそのまま濃淡にする。
function montagePair(generated, reference) {
  const scale = Math.min(PANEL_WIDTH / generated.width, TILE / generated.height);
  const w = Math.max(1, Math.round(generated.width * scale));
  const h = Math.max(1, Math.round(generated.height * scale));
  const generatedTile = resizeField(generated, w, h);
  const referenceTile = resizeField(reference, w, h);
  const x0 = Math.floor((PANEL_WIDTH - w) / 2);
  const y0 = Math.floor((TILE - h) / 2);
  const out = new Float32Array(TILE * TILE);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      out[(y0 + y) * TILE + x0 + x] = srgbOf(generatedTile.data[i]);
      out[(y0 + y) * TILE + PANEL_WIDTH + x0 + x] = Math.min(1, Math.max(0, referenceTile.data[i]));
    }
  }
  return { width: TILE, height: TILE, data: out };
}

function main() {
  const capManifestPath = path.join(root, '.cloud-lab/render-capture-cirrus/manifest.json');
  const fineManifestPath = path.join(root, '.cloud-lab/reference-fine/manifest.json');
  const cirrusManifestPath = path.join(root, '.cloud-lab/reference-cirrus/manifest.json');
  for (const file of [capManifestPath, fineManifestPath, cirrusManifestPath]) {
    if (!existsSync(file)) throw new Error(`${file} が無い — 撮影と参照の取り込みを先に実行すること`);
  }
  const capManifest = JSON.parse(readFileSync(capManifestPath, 'utf8'));
  const fineManifest = JSON.parse(readFileSync(fineManifestPath, 'utf8'));
  const cirrusManifest = JSON.parse(readFileSync(cirrusManifestPath, 'utf8'));
  const colormapEntries = parseBand13Colormap(
    readFileSync(path.join(root, '.cloud-lab/reference-cirrus', cirrusManifest.colormap.file), 'utf8'));

  mkdirSync(outDir, { recursive: true });
  let written = 0;
  for (const capture of capManifest.captures) {
    const ladder = capture.name.slice(capture.region.length + 1);
    const btFrame = fineManifest.frames.find(
      (frame) => frame.region === capture.region && frame.ladder === ladder && frame.suffix === 'band13');
    if (btFrame === undefined) {
      console.log(`${capture.name}: 帯 13 の参照が無く、対を組めない`);
      continue;
    }
    const captureField = decodeLuminancePng(
      readFileSync(path.join(root, '.cloud-lab/render-capture-cirrus', capture.file)));
    const resampled = resampleCaptureToBox(
      captureField, capture.latitudeDeg, capture.longitudeDeg, capture.cameraDistanceKm,
      capManifest.fovDeg, btFrame.box, BOX_WIDTH, BOX_HEIGHT);
    if (resampled.validRect === null) {
      console.log(`${capture.name}: 撮影が箱を覆わず、有効矩形が無い`);
      continue;
    }
    const rect = resampled.validRect;
    const generatedLayer = cropField(resampled, rect.x0, rect.y0, rect.width, rect.height);
    const btField = invertBrightnessTemperature(
      decodePng(readFileSync(path.join(root, btFrame.file))), colormapEntries);
    const referenceLayer = cropField(coldnessField(btField), rect.x0, rect.y0, rect.width, rect.height);
    const file = path.join(outDir, `${capture.name}.png`);
    writeFileSync(file, fieldToGrayPng(montagePair(generatedLayer, referenceLayer)));
    written++;
  }
  console.log(`モンタージュ ${written} 枚を ${outDir} へ書いた`);
}

main();
