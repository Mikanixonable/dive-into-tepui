// 手順8-15の raw 走査参照と、現行帯鎖のA診断を同じ最後の拡大へ通して保存する。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { encodeRgbPng } from './png.mjs';
import { HEIGHT, seedOf, shotsDir, WIDTH, withLab, writeFloats } from './screen-space-lab.mjs';

const smoke = process.argv.includes('--smoke');
const rawPassArgument = process.argv.find((arg) => arg.startsWith('--raw-passes='));
const chainPassArgument = process.argv.find((arg) => arg.startsWith('--chain-passes='));
const RAW_PASSES = rawPassArgument === undefined ? 1024 : Number(rawPassArgument.split('=')[1]);
const CHAIN_PASSES = chainPassArgument === undefined ? 32 : Number(chainPassArgument.split('=')[1]);
if (!Number.isInteger(RAW_PASSES) || RAW_PASSES < 2 || RAW_PASSES % 2 !== 0
  || !Number.isInteger(CHAIN_PASSES) || CHAIN_PASSES < 1) {
  throw new Error('--raw-passes must be a positive even integer and --chain-passes a positive integer');
}
const outDir = path.join(shotsDir, 'ssd-8-15-reference', smoke ? 'smoke' : '');
const scenes = [
  { id: 'bay-earth-open', caseName: 'bay', shot: 'bay-earth-open' },
  { id: 'cornell-box', caseName: 'cornell-box', shot: 'cornell-box' },
  { id: 'bay-dark', caseName: 'bay', shot: 'bay-dark' },
];
const sceneArgument = process.argv.find((arg) => arg.startsWith('--scene='));
const selectedScenes = sceneArgument === undefined ? scenes : scenes.filter(({ id }) => id === sceneArgument.split('=')[1]);
if (selectedScenes.length === 0) throw new Error(`unknown scene in ${sceneArgument}`);
const rawTier = { scale: 0.25, sliceCount: 4, stepCount: 5, bandCount: 1, bandScale: 3 / 4 };
const SCAN_WIDTH = Math.round(WIDTH * rawTier.scale);
const SCAN_HEIGHT = Math.round(HEIGHT * rawTier.scale);
const chainTier = { ...rawTier, bandCount: 4 };
const HALF_PASSES = RAW_PASSES / 2;
mkdirSync(outDir, { recursive: true });

function averageImages(taken, count) {
  return taken.sums[0].map((image, texture) => {
    const rgba = new Float32Array(image.length);
    for (let i = 0; i < rgba.length; i++) {
      rgba[i] = (taken.sums[0][texture][i] + taken.sums[1][texture][i]) / count;
    }
    return rgba;
  });
}

function writeImage(file, buffer) { writeFileSync(file, buffer); }
function writeRgbPng(file, display) {
  const rgb = new Uint8Array(display.width * display.height * 3);
  for (let pixel = 0; pixel < display.width * display.height; pixel++) {
    for (let channel = 0; channel < 3; channel++) {
      rgb[pixel * 3 + channel] = Math.round(Math.max(0, Math.min(1, display.rgba[pixel * 4 + channel])) * 255);
    }
  }
  writeImage(file, encodeRgbPng(display.width, display.height, rgb));
}

function sameRgb(a, b) {
  for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 3; c++) if (a[i + c] !== b[i + c]) return false;
  return true;
}

const records = [];
const differenceImages = [];
const halfDifferenceImages = [];
for (const scene of selectedScenes) {
try {
await withLab(async (lab) => {
  try {
    const dir = path.join(outDir, scene.id);
    mkdirSync(dir, { recursive: true });
    await lab.show({ caseName: scene.caseName, shot: scene.shot, mode: 2, set: 'tuning', key: scene.id });
    const exposure = await lab.exposureFactor();
    const blueNoiseSeed = seedOf(0);

    // raw 1/4走査を512ずつ積み、半分ごとの差を残してから全1024パスを平均する。
    await lab.setTier(rawTier);
    await lab.render();
    await lab.accumulateWhitePasses(0, HALF_PASSES);
    const firstHalf = await lab.takePassSums();
    await lab.accumulateWhitePasses(HALF_PASSES, HALF_PASSES);
    const secondHalf = await lab.takePassSums();
    const combinedSums = [0, 1].map((parity) => firstHalf.sums[parity].map((values, texture) => (
      Float32Array.from(values, (value, index) => value + secondHalf.sums[parity][texture][index]))));
    const rawMean = averageImages({ sums: combinedSums }, RAW_PASSES);
    const rawHalfA = averageImages(firstHalf, HALF_PASSES)[0];
    const rawHalfB = averageImages(secondHalf, HALF_PASSES)[0];
    writeFloats(path.join(dir, 'raw-half-0.rgba.f32'), rawHalfA);
    writeFloats(path.join(dir, 'raw-half-1.rgba.f32'), rawHalfB);
    const [scanWidth, scanHeight] = await lab.floatSizeOf('packed-bands-0');
    if (rawHalfA.length !== scanWidth * scanHeight * 4 || rawHalfB.length !== scanWidth * scanHeight * 4) {
      throw new Error(`${scene.id}: raw half shape ${rawHalfA.length}/${rawHalfB.length}, expected ${scanWidth}×${scanHeight}×4`);
    }
    const halfDifference = new Float32Array(rawHalfA.length);
    for (let i = 0; i < halfDifference.length; i += 4) {
      for (let c = 0; c < 3; c++) halfDifference[i + c] = rawHalfA[i + c] - rawHalfB[i + c];
      halfDifference[i + 3] = 1;
    }
    writeFloats(path.join(dir, 'raw-half-difference.rgba.f32'), halfDifference);
    halfDifferenceImages.push({ scene: scene.id, width: scanWidth, height: scanHeight, rgba: halfDifference });
    const rawPacked = rawMean[0];
    for (let i = 3; i < rawPacked.length; i += 4) rawPacked[i] = 1;
    writeFloats(path.join(dir, 'raw1024-scan-average-a1.rgba.f32'), rawPacked);
    await lab.writePackedBands(0, rawPacked);
    await lab.setStageRange('chain');
    await lab.setUpsampleAlphaOne(true);
    await lab.render();
    const rawCorrection = await lab.readFloat('correction', 4);
    writeFloats(path.join(dir, 'raw1024-a1.rgba.f32'), rawCorrection);
    writeImage(path.join(dir, 'raw1024-a1.scene.png'), await lab.capturePng());
    writeImage(path.join(dir, 'raw1024-a1.signed.png'), await lab.signedCorrectionPng(
      { width: WIDTH, height: HEIGHT, rgba: rawCorrection }));

    // 鎖の帯入力を独立32パス平均し、同じ入力で A=1 と実際のAを切り替える。
    await lab.setTier(chainTier);
    await lab.setStageRange('all');
    await lab.render();
    await lab.accumulateWhitePasses(0, CHAIN_PASSES);
    const chainTaken = await lab.takePassSums();
    const chainMean = averageImages(chainTaken, CHAIN_PASSES);
    const firstSeed = seedOf(0);
    await lab.setStageRange('all');
    await lab.setWhiteNoisePass(null);
    await lab.setSeed(firstSeed);
    await lab.setUpsampleAlphaOne(false);
    await lab.render();
    const onePassCorrection = await lab.readFloat('correction', 4);
    writeFloats(path.join(dir, 'chain1-actual-a.rgba.f32'), onePassCorrection);
    writeImage(path.join(dir, 'chain1-actual-a.scene.png'), await lab.capturePng());
    writeImage(path.join(dir, 'chain1-actual-a.signed.png'), await lab.signedCorrectionPng(
      { width: WIDTH, height: HEIGHT, rgba: onePassCorrection }));

    for (const [index, rgba] of chainMean.entries()) {
      writeFloats(path.join(dir, `chain32-input-${index}.rgba.f32`), rgba);
      await lab.writePackedBands(index, rgba);
    }
    await lab.setStageRange('chain');
    await lab.setUpsampleAlphaOne(true);
    await lab.render();
    const chainA1 = await lab.readFloat('correction', 4);
    const mergeA1 = await lab.readFloat('merged-0', 4);
    writeFloats(path.join(dir, 'chain32-a1.rgba.f32'), chainA1);
    writeFloats(path.join(dir, 'chain32-merged-0-a1.rgba.f32'), mergeA1);
    for (let level = 0; level < chainTier.bandCount; level++) {
      const count = Math.ceil(3 * (chainTier.bandCount - level) / 4);
      for (let index = 0; index < count; index++) {
        const name = level === 0 ? `packed-bands-${index}` : `reduced-${level}-${index}`;
        writeFloats(path.join(dir, `chain32-level-${level}-packed-${index}.rgba.f32`), await lab.readFloat(name, 4));
      }
    }
    for (let level = 0; level < chainTier.bandCount - 1; level++) {
      writeFloats(path.join(dir, `chain32-merged-${level}.rgba.f32`), await lab.readFloat(`merged-${level}`, 4));
    }
    writeImage(path.join(dir, 'chain32-a1.scene.png'), await lab.capturePng());
    writeImage(path.join(dir, 'chain32-a1.signed.png'), await lab.signedCorrectionPng(
      { width: WIDTH, height: HEIGHT, rgba: chainA1 }));

    await lab.setUpsampleAlphaOne(false);
    await lab.render();
    const chainActualA = await lab.readFloat('correction', 4);
    const mergeActualA = await lab.readFloat('merged-0', 4);
    if (!sameRgb(mergeA1, mergeActualA)) throw new Error(`${scene.id}: A toggle changed merged RGB`);
    writeFloats(path.join(dir, 'chain32-actual-a.rgba.f32'), chainActualA);
    writeFloats(path.join(dir, 'chain32-merged-0-actual-a.rgba.f32'), mergeActualA);
    writeImage(path.join(dir, 'chain32-actual-a.scene.png'), await lab.capturePng());
    writeImage(path.join(dir, 'chain32-actual-a.signed.png'), await lab.signedCorrectionPng(
      { width: WIDTH, height: HEIGHT, rgba: chainActualA }));

    // raw と鎖の差分は同じ signedCorrectionDisplay・同じ露出で符号付きに表示する。
    const diff = { width: WIDTH, height: HEIGHT, rgba: new Float32Array(rawCorrection.length) };
    for (let i = 0; i < diff.rgba.length; i += 4) {
      for (let c = 0; c < 3; c++) diff.rgba[i + c] = rawCorrection[i + c] - chainA1[i + c];
      diff.rgba[i + 3] = 1;
    }
    writeFloats(path.join(dir, 'raw1024-minus-chain32-a1.rgba.f32'), diff.rgba);
    differenceImages.push({ scene: scene.id, rgba: diff.rgba });
    await lab.setUpsampleAlphaOne(false);
    await lab.setStageRange('all');
    records.push({
      scene: scene.id, caseName: scene.caseName, shot: scene.shot,
      viewport: [WIDTH, HEIGHT], scanResolution: [SCAN_WIDTH, SCAN_HEIGHT], scanTier: rawTier, chainTier,
      rawPasses: RAW_PASSES, rawHalfPasses: HALF_PASSES, chainAveragePasses: CHAIN_PASSES,
      seeds: 'seeds.json', exposureFactor: exposure,
      alphaTogglePreservedMergedRgb: true,
      outputs: [
        'raw1024-a1.scene.png', 'chain1-actual-a.scene.png', 'chain32-a1.scene.png', 'chain32-actual-a.scene.png',
        'raw1024-minus-chain32-a1.signed.png', 'raw-half-0.rgba.f32', 'raw-half-1.rgba.f32',
        'raw1024-scan-average-a1.rgba.f32',
        'raw-half-difference.signed.png', 'chain32-level-0-packed-0.rgba.f32', 'chain32-level-1-packed-0.rgba.f32',
        'chain32-level-2-packed-0.rgba.f32', 'chain32-level-3-packed-0.rgba.f32',
        'chain32-merged-0-a1.rgba.f32', 'chain32-merged-0-actual-a.rgba.f32',
      ],
      blueNoiseSeed,
    });
    console.log(`${scene.id}: completed (${RAW_PASSES} raw, ${CHAIN_PASSES} chain)`);
  } finally {
    await lab.setUpsampleAlphaOne(false);
    await lab.setStageRange('all');
  }
});
} catch (error) {
  if (error?.code !== 'EPERM' || !records.some(({ scene: id }) => id === scene.id)) throw error;
  console.warn(`${scene.id}: capture saved; Chrome temp profile cleanup returned EPERM`);
}
writeFileSync(path.join(outDir, 'record.json'), JSON.stringify({ createdAt: new Date().toISOString(), records }, null, 2));
}

function fixedSignedPng(file, width, height, rgba, scale) {
  const rgb = new Uint8Array(width * height * 3);
  for (let pixel = 0; pixel < width * height; pixel++) for (let channel = 0; channel < 3; channel++) {
    rgb[pixel * 3 + channel] = Math.round(127.5 + 127.5 * Math.max(-1, Math.min(1, rgba[pixel * 4 + channel] / scale)));
  }
  writeImage(file, encodeRgbPng(width, height, rgb));
}
function maximumAbsoluteRgb(images) {
  let maximum = 0;
  for (const { rgba } of images) for (let i = 0; i < rgba.length; i += 4) {
    maximum = Math.max(maximum, Math.abs(rgba[i]), Math.abs(rgba[i + 1]), Math.abs(rgba[i + 2]));
  }
  return Math.max(maximum, 1e-12);
}
for (const record of records) {
  const dir = path.join(outDir, record.scene);
  const readF32 = (name) => {
    const bytes = readFileSync(path.join(dir, name));
    return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  };
  const first = readF32('raw-half-0.rgba.f32');
  const second = readF32('raw-half-1.rgba.f32');
  const mean = new Float32Array(first.length);
  for (let i = 0; i < mean.length; i += 4) {
    for (let c = 0; c < 3; c++) mean[i + c] = (first[i + c] + second[i + c]) / 2;
    mean[i + 3] = 1;
  }
  writeFloats(path.join(dir, 'raw1024-scan-average-a1.rgba.f32'), mean);
  writeFileSync(path.join(dir, 'seeds.json'), JSON.stringify({
    rawWhiteNoisePassIndices: Array.from({ length: RAW_PASSES }, (_, index) => index),
    chainWhiteNoisePassIndices: Array.from({ length: CHAIN_PASSES }, (_, index) => index),
    firstBlueNoiseSeed: record.blueNoiseSeed,
  }, null, 2));
}
const differenceScale = maximumAbsoluteRgb(differenceImages);
const halfDifferenceScale = maximumAbsoluteRgb(halfDifferenceImages);
for (const { scene, rgba } of differenceImages) {
  fixedSignedPng(path.join(outDir, scene, 'raw1024-minus-chain32-a1.signed.png'), WIDTH, HEIGHT, rgba, differenceScale);
}
for (const { scene, width, height, rgba } of halfDifferenceImages) {
  fixedSignedPng(path.join(outDir, scene, 'raw-half-difference.signed.png'), width, height, rgba, halfDifferenceScale);
}
writeFileSync(path.join(outDir, 'difference-scales.json'), JSON.stringify({ differenceScale, halfDifferenceScale }, null, 2));
writeFileSync(path.join(outDir, 'record.json'), JSON.stringify({ createdAt: new Date().toISOString(), records,
  differenceScale, halfDifferenceScale }, null, 2));
