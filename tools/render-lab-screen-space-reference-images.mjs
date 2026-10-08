// 8-15参照のfloat差分と、同じ座標の拡大クロップ・画素列を出力する。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng, encodeRgbPng } from './png.mjs';
import { HEIGHT, WIDTH } from './screen-space-lab.mjs';

const root = path.resolve(import.meta.dirname, '..');
const base = path.join(root, '.render-lab-shots', 'ssd-8-15-reference');
const record = JSON.parse(readFileSync(path.join(base, 'record.json'), 'utf8'));
const fullWidth = WIDTH;
const fullHeight = HEIGHT;
const scanScale = record.records[0].scanTier.scale;
const scanWidth = Math.round(fullWidth * scanScale);
const scanHeight = Math.round(fullHeight * scanScale);
const stageDifferences = [];
const alphaDifferences = [];
const roiAlphaMetrics = [];

function readFloat(file) {
  const bytes = readFileSync(file);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
function writeFloat(file, values) {
  writeFileSync(file, Buffer.from(values.buffer, values.byteOffset, values.byteLength));
}
function maximumRgb(images) {
  let maximum = 0;
  for (const { rgba } of images) for (let i = 0; i < rgba.length; i += 4) {
    maximum = Math.max(maximum, Math.abs(rgba[i]), Math.abs(rgba[i + 1]), Math.abs(rgba[i + 2]));
  }
  return Math.max(maximum, 1e-12);
}
function signedPng(file, width, height, rgba, scale) {
  const rgb = new Uint8Array(width * height * 3);
  for (let p = 0; p < width * height; p++) for (let c = 0; c < 3; c++) {
    rgb[p * 3 + c] = Math.round(127.5 + 127.5 * Math.max(-1, Math.min(1, rgba[p * 4 + c] / scale)));
  }
  writeFileSync(file, encodeRgbPng(width, height, rgb));
}
function cropNearest(source, destination, rect, scale = 4) {
  const { width, height, channels, data } = decodePng(readFileSync(source));
  const x0 = Math.max(0, rect.x), y0 = Math.max(0, rect.y);
  const x1 = Math.min(width, rect.x + rect.width), y1 = Math.min(height, rect.y + rect.height);
  const cropWidth = x1 - x0, cropHeight = y1 - y0;
  const rgb = new Uint8Array(cropWidth * cropHeight * scale * scale * 3);
  for (let y = 0; y < cropHeight * scale; y++) for (let x = 0; x < cropWidth * scale; x++) {
    const sourcePixel = ((y0 + Math.floor(y / scale)) * width + x0 + Math.floor(x / scale)) * channels;
    const outputPixel = (y * cropWidth * scale + x) * 3;
    for (let c = 0; c < 3; c++) rgb[outputPixel + c] = data[sourcePixel + c];
  }
  writeFileSync(destination, encodeRgbPng(cropWidth * scale, cropHeight * scale, rgb));
}
function scanBandSum(packed, pixels) {
  const sum = new Float32Array(pixels * 4);
  for (let p = 0; p < pixels; p++) {
    for (let band = 0; band < 4; band++) for (let c = 0; c < 3; c++) {
      const channel = band * 3 + c;
      sum[p * 4 + c] += packed[Math.floor(channel / 4)][p * 4 + channel % 4];
    }
    sum[p * 4 + 3] = 1;
  }
  return sum;
}
function appendLine(file, headers, rows) {
  writeFileSync(file, `${headers.join(',')}\n${rows.map((row) => row.join(',')).join('\n')}\n`);
}

for (const shot of record.records) {
  const dir = path.join(base, shot.scene);
  writeFileSync(path.join(dir, 'seeds.json'), JSON.stringify({
    rawWhiteNoisePassIndices: Array.from({ length: shot.rawPasses }, (_, index) => index),
    chainWhiteNoisePassIndices: Array.from({ length: shot.chainAveragePasses }, (_, index) => index),
    firstBlueNoiseSeed: shot.blueNoiseSeed,
  }, null, 2));
  const pixels = scanWidth * scanHeight;
  const packed = [0, 1, 2].map((i) => readFloat(path.join(dir, `chain32-input-${i}.rgba.f32`)));
  const chainScan = scanBandSum(packed, pixels);
  const rawAveragePath = path.join(dir, 'raw1024-scan-average-a1.rgba.f32');
  let rawScan;
  if (existsSync(rawAveragePath)) rawScan = readFloat(rawAveragePath);
  else {
    const first = readFloat(path.join(dir, 'raw-half-0.rgba.f32'));
    const second = readFloat(path.join(dir, 'raw-half-1.rgba.f32'));
    rawScan = new Float32Array(first.length);
    for (let i = 0; i < rawScan.length; i += 4) {
      for (let c = 0; c < 3; c++) rawScan[i + c] = (first[i + c] + second[i + c]) / 2;
      rawScan[i + 3] = 1;
    }
    writeFloat(rawAveragePath, rawScan);
  }
  const merged = readFloat(path.join(dir, 'chain32-merged-0-a1.rgba.f32'));
  const chainLoss = new Float32Array(chainScan.length);
  const samplingDifference = new Float32Array(chainScan.length);
  for (let i = 0; i < chainScan.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      chainLoss[i + c] = chainScan[i + c] - merged[i + c];
      samplingDifference[i + c] = rawScan[i + c] - chainScan[i + c];
    }
    chainLoss[i + 3] = samplingDifference[i + 3] = 1;
  }
  writeFloat(path.join(dir, 'chain32-band-sum-scan.rgba.f32'), chainScan);
  writeFloat(path.join(dir, 'chain32-band-sum-minus-merged0.rgba.f32'), chainLoss);
  writeFloat(path.join(dir, 'raw1024-scan-minus-chain32-band-sum.rgba.f32'), samplingDifference);
  stageDifferences.push({ scene: shot.scene, kind: 'chain-loss', width: scanWidth, height: scanHeight, rgba: chainLoss });
  stageDifferences.push({ scene: shot.scene, kind: 'sampling', width: scanWidth, height: scanHeight, rgba: samplingDifference });

  const rawFull = readFloat(path.join(dir, 'raw1024-a1.rgba.f32'));
  const chainFull = readFloat(path.join(dir, 'chain32-a1.rgba.f32'));
  const actualFull = readFloat(path.join(dir, 'chain32-actual-a.rgba.f32'));
  const alphaDifference = new Float32Array(chainFull.length);
  for (let i = 0; i < chainFull.length; i += 4) {
    for (let c = 0; c < 3; c++) alphaDifference[i + c] = chainFull[i + c] - actualFull[i + c];
    alphaDifference[i + 3] = 1;
  }
  writeFloat(path.join(dir, 'chain32-a1-minus-actual-a.rgba.f32'), alphaDifference);
  alphaDifferences.push({ scene: shot.scene, width: fullWidth, height: fullHeight, rgba: alphaDifference });
  const roi = shot.scene === 'bay-earth-open'
    ? { x: 500, y: 120, width: 121, height: 71 }
    : shot.scene === 'cornell-box' ? { x: 120, y: 170, width: 111, height: 131 }
      : { x: 420, y: 120, width: 181, height: 171 };
  let roiMax = 0, roiSum = 0, roiSquares = 0, roiCount = 0;
  for (let y = roi.y; y < roi.y + roi.height; y++) for (let x = roi.x; x < roi.x + roi.width; x++) {
    const p = (y * fullWidth + x) * 4;
    for (let c = 0; c < 3; c++) {
      const delta = alphaDifference[p + c];
      roiMax = Math.max(roiMax, Math.abs(delta));
      roiSum += Math.abs(delta);
      roiSquares += delta * delta;
      roiCount++;
    }
  }
  roiAlphaMetrics.push({ scene: shot.scene, roi, comparedRgbValues: roiCount,
    maximumAbsoluteDifference: roiMax, meanAbsoluteDifference: roiSum / roiCount,
    rmsDifference: Math.sqrt(roiSquares / roiCount) });
  appendLine(path.join(dir, 'roi-a1-minus-actual-a.csv'), ['x', 'y', 'deltaR', 'deltaG', 'deltaB'],
    Array.from({ length: roi.height }, (_, dy) => Array.from({ length: roi.width }, (_, dx) => {
      const x = roi.x + dx, y = roi.y + dy, p = (y * fullWidth + x) * 4;
      return [x, y, alphaDifference[p], alphaDifference[p + 1], alphaDifference[p + 2]];
    })).flat());
  const fullRows = [];
  const lineY = Math.floor(roi.y + roi.height / 2);
  for (let x = roi.x; x < roi.x + roi.width; x++) {
    const p = (lineY * fullWidth + x) * 4;
    fullRows.push([x, lineY, ...[rawFull, chainFull, actualFull].flatMap((image) => [
      image[p], image[p + 1], image[p + 2], image[p + 3],
    ])]);
  }
  appendLine(path.join(dir, `pixels-main-roi-line-y${lineY}.csv`), [
    'x', 'y', 'rawR', 'rawG', 'rawB', 'rawA', 'chainA1R', 'chainA1G', 'chainA1B', 'chainA1A',
    'chainActualR', 'chainActualG', 'chainActualB', 'chainActualA',
  ], fullRows);
  const roiRows = [];
  for (let y = roi.y; y < roi.y + roi.height; y++) for (let x = roi.x; x < roi.x + roi.width; x++) {
    const p = (y * fullWidth + x) * 4;
    roiRows.push([x, y, ...[rawFull, chainFull, actualFull].flatMap((image) => [
      image[p], image[p + 1], image[p + 2],
    ])]);
  }
  appendLine(path.join(dir, 'pixels-main-roi.csv'), [
    'x', 'y', 'rawR', 'rawG', 'rawB', 'chainA1R', 'chainA1G', 'chainA1B',
    'chainActualR', 'chainActualG', 'chainActualB',
  ], roiRows);
  const scanRect = shot.scene === 'bay-earth-open'
    ? { x: 125, y: 30, width: 31, height: 19 }
    : shot.scene === 'cornell-box' ? { x: 30, y: 42, width: 28, height: 33 }
      : { x: 105, y: 30, width: 46, height: 43 };
  const scanRows = [];
  for (let y = scanRect.y; y < scanRect.y + scanRect.height; y++) for (let x = scanRect.x; x < scanRect.x + scanRect.width; x++) {
    const p = (y * scanWidth + x) * 4;
    scanRows.push([x, y,
      rawScan[p], rawScan[p + 1], rawScan[p + 2],
      chainScan[p], chainScan[p + 1], chainScan[p + 2],
      merged[p], merged[p + 1], merged[p + 2],
    ]);
  }
  appendLine(path.join(dir, `scan-pixels-x${scanRect.x}-${scanRect.x + scanRect.width - 1}-y${scanRect.y}-${scanRect.y + scanRect.height - 1}.csv`), [
    'x', 'y', 'raw1024R', 'raw1024G', 'raw1024B', 'chain32BandSumR', 'chain32BandSumG', 'chain32BandSumB',
    'chain32Merged0R', 'chain32Merged0G', 'chain32Merged0B',
  ], scanRows);
  shot.outputs.push(
    'raw1024-scan-average-a1.rgba.f32', 'chain32-band-sum-scan.rgba.f32',
    'chain32-band-sum-minus-merged0.rgba.f32', 'chain32-band-sum-minus-merged0.signed.png',
    'raw1024-scan-minus-chain32-band-sum.rgba.f32', 'raw1024-scan-minus-chain32-band-sum.signed.png',
    'pixels-main-roi.csv', `pixels-main-roi-line-y${lineY}.csv`,
    'chain32-a1-minus-actual-a.rgba.f32', 'chain32-a1-minus-actual-a.signed.png', 'roi-a1-minus-actual-a.csv',
    `scan-pixels-x${scanRect.x}-${scanRect.x + scanRect.width - 1}-y${scanRect.y}-${scanRect.y + scanRect.height - 1}.csv`,
    'raw1024-a1.crop.png', 'chain1-actual-a.crop.png', 'chain32-a1.crop.png', 'chain32-actual-a.crop.png',
  );

  const rect = shot.scene === 'bay-earth-open'
    ? { x: 500, y: 120, width: 120, height: 70 }
    : shot.scene === 'cornell-box' ? { x: 120, y: 170, width: 111, height: 131 }
      : { x: 420, y: 120, width: 180, height: 170 };
  for (const name of ['raw1024-a1', 'chain1-actual-a', 'chain32-a1', 'chain32-actual-a']) {
    cropNearest(path.join(dir, `${name}.scene.png`), path.join(dir, `${name}.crop.png`), rect);
  }
}

const alphaScale = maximumRgb(alphaDifferences);
for (const image of alphaDifferences) {
  signedPng(path.join(base, image.scene, 'chain32-a1-minus-actual-a.signed.png'), image.width, image.height, image.rgba, alphaScale);
}

const stageScale = maximumRgb(stageDifferences);
for (const image of stageDifferences) {
  const suffix = image.kind === 'chain-loss' ? 'chain32-band-sum-minus-merged0' : 'raw1024-scan-minus-chain32-band-sum';
  signedPng(path.join(base, image.scene, `${suffix}.signed.png`), image.width, image.height, image.rgba, stageScale);
}
for (const shot of record.records) shot.outputs = [...new Set(shot.outputs)];
record.stageDifferenceScale = stageScale;
record.alphaDifferenceScale = alphaScale;
record.alphaDifferenceRoi = roiAlphaMetrics;
record.stageDifferenceScaleMeaning = 'maximum absolute RGB across all scan-resolution stage differences; zero is neutral gray';
writeFileSync(path.join(base, 'record.json'), JSON.stringify(record, null, 2));
writeFileSync(path.join(base, 'difference-scales.json'), JSON.stringify({
  fullResolution: record.differenceScale, rawHalfScan: record.halfDifferenceScale, scanStages: stageScale,
  chainA1MinusActualA: alphaScale,
}, null, 2));
const cards = record.records.flatMap((shot) => [
  ['raw1024-a1.scene.png', 'raw1024 A=1, 1024 scan paths'],
  ['chain1-actual-a.scene.png', 'chain, one path, actual A'],
  ['chain32-a1.scene.png', 'chain mean, 32 paths, A=1'],
  ['chain32-actual-a.scene.png', 'chain mean, 32 paths, actual A'],
  ['raw1024-minus-chain32-a1.signed.png', 'raw minus chain A=1, fixed scale'],
  ['chain32-a1-minus-actual-a.signed.png', 'chain A=1 minus actual A, fixed scale'],
  ['chain32-band-sum-minus-merged0.signed.png', 'chain band sum minus merged-0, fixed scale'],
  ['raw1024-scan-minus-chain32-band-sum.signed.png', 'raw scan minus chain band sum, fixed scale'],
].map(([file, label]) => `<figure><img src="${shot.scene}/${file}"><figcaption>${shot.scene} — ${label}</figcaption></figure>`));
writeFileSync(path.join(base, 'index.html'), `<!doctype html><meta charset="utf-8"><title>8-15 quality reference</title>
<style>body{margin:24px;background:#17191d;color:#eee;font:14px system-ui}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:18px}figure{margin:0}img{display:block;width:100%;background:#222}figcaption{padding:7px}</style>
<h1>8-15 quality reference</h1><p>Full-frame comparison PNGs use the same capture pipeline per scene. Signed difference PNGs use fixed scales listed in difference-scales.json.</p><main>${cards.join('\n')}</main>`);
