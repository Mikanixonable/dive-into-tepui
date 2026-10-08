// 手順8-15の帯鎖を、走査解像度の構造誤差と1パス雑音に分けて撮る。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { encodeRgbPng } from './png.mjs';
import { HEIGHT, seedOf, shotsDir, WIDTH, withLab, writeFloats } from './screen-space-lab.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUTPUT = path.join(shotsDir, 'ssd-8-15-chain-metrics');
const CHUNK_PASSES = 256;
const NOISE_PASSES = 32;
const NOISE_FIRST_PASS = 5000;
const INVARIANT_PASS = 7000;
const SCAN_WIDTH = WIDTH / 4;
const SCAN_HEIGHT = HEIGHT / 4;
const PIXELS = SCAN_WIDTH * SCAN_HEIGHT;
const TIER = { scale: 0.25, sliceCount: 4, stepCount: 5, bandCount: 4, bandScale: 0.75 };
const SCENES = [
  { name: 'bay-earth-open', caseName: 'bay', shot: 'bay-earth-open', rois: { target: [125, 30, 31, 19] } },
  { name: 'cornell-box', caseName: 'cornell-box', shot: 'cornell-box', rois: { target: [30, 42, 28, 33] } },
  { name: 'bay-dark', caseName: 'bay', shot: 'bay-dark', rois: { target: [105, 30, 46, 43] } },
  // 各板の内側の床。core は蝶番から 0.75 m まで、wide は 1.5 m から 4 m まで、板の中心線の幅 ±0.3 m。
  // gap は隣り合う板の隙間の真後ろの床(半径 10.3〜11.5 m、隙間の中央から ±0.5 m)。
  // カメラの投影で床の4隅を走査画素へ落とし、外接箱を内側へ丸めて、板に掛かる行を除いた。
  {
    name: 'angled-bounce', caseName: 'angled-bounce', shot: 'angled-bounce',
    rois: {
      'core-30': [38, 75, 11, 5], 'core-60': [80, 70, 8, 4], 'core-90': [116, 69, 8, 3],
      'core-120': [152, 70, 8, 4], 'core-150': [191, 76, 11, 4],
      'wide-30': [39, 84, 17, 25], 'wide-60': [80, 78, 12, 22], 'wide-90': [114, 77, 12, 20],
      'wide-120': [148, 78, 12, 22], 'wide-150': [184, 84, 17, 25],
      'gap-30-60': [57, 65, 14, 6], 'gap-60-90': [96, 63, 12, 4],
      'gap-90-120': [132, 63, 12, 4], 'gap-120-150': [169, 65, 14, 6],
    },
  },
];
const passesArgument = process.argv.find((arg) => arg.startsWith('--passes='));
const PASSES = passesArgument === undefined ? 1024 : Number(passesArgument.split('=')[1]);
if (![1024, 2048, 4096].includes(PASSES)) throw new Error('--passes must be 1024, 2048, or 4096');
const sceneArgument = process.argv.find((arg) => arg.startsWith('--scene='));
const scenes = sceneArgument === undefined ? SCENES : SCENES.filter(({ name }) => name === sceneArgument.split('=')[1]);
if (scenes.length === 0) throw new Error(`unknown scene: ${sceneArgument}`);

function sourceSignature() {
  const hash = createHash('sha256').update('ssd-8-15-chain-metrics-v1');
  const folders = ['src/render/pipeline', 'tools/render-lab'];
  const visit = (folder) => {
    for (const item of readdirSync(path.join(ROOT, folder), { withFileTypes: true })) {
      const relative = path.join(folder, item.name);
      if (item.isDirectory()) visit(relative);
      else if (item.name.endsWith('.ts') && (folder !== 'tools/render-lab' || item.name.includes('case'))) {
        hash.update(relative).update(readFileSync(path.join(ROOT, relative)));
      }
    }
  };
  for (const folder of folders) visit(folder);
  hash.update(readFileSync(path.join(ROOT, 'tools/screen-space-lab.mjs')));
  hash.update(JSON.stringify(TIER));
  return hash.digest('hex').slice(0, 16);
}

function readFloats(file) {
  const bytes = readFileSync(file);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function rgbDifference(a, b) {
  const result = new Float32Array(a.length);
  for (let i = 0; i < result.length; i += 4) {
    for (let c = 0; c < 3; c++) result[i + c] = a[i + c] - b[i + c];
    result[i + 3] = 1;
  }
  return result;
}

function rms(values, roi) {
  const [left, top, width, height] = roi;
  let squares = 0;
  for (let y = top; y < top + height; y++) for (let x = left; x < left + width; x++) {
    const p = (y * SCAN_WIDTH + x) * 4;
    for (let c = 0; c < 3; c++) squares += values[p + c] ** 2;
  }
  return Math.sqrt(squares / (width * height * 3));
}

function invariantDifference(raw, bandSum) {
  let sum = 0, maximum = 0;
  for (let i = 0; i < raw.length; i += 4) for (let c = 0; c < 3; c++) {
    const delta = Math.abs(raw[i + c] - bandSum[i + c]);
    sum += delta;
    maximum = Math.max(maximum, delta);
  }
  return { meanAbsolute: sum / (PIXELS * 3), maximumAbsolute: maximum };
}

function alphaMap(merged) {
  return Float32Array.from({ length: PIXELS }, (_, p) => merged[p * 4 + 3]);
}

function chunkFile(cache, first, texture) {
  return path.join(cache, `sum-${String(first).padStart(4, '0')}-packed-${texture}.f32`);
}

function cachedMean(cache, first, end) {
  const sums = Array.from({ length: 3 }, () => new Float64Array(PIXELS * 4));
  for (let pass = first; pass < end; pass += CHUNK_PASSES) {
    for (let texture = 0; texture < 3; texture++) {
      const values = readFloats(chunkFile(cache, pass, texture));
      if (values.length !== PIXELS * 4) throw new Error(`invalid cached scan chunk ${pass}/${texture}`);
      const sum = sums[texture];
      for (let i = 0; i < sum.length; i++) sum[i] += values[i];
    }
  }
  return sums.map((values) => Float32Array.from(values, (value) => value / (end - first)));
}

async function mergedOf(lab, packed) {
  for (const [index, rgba] of packed.entries()) await lab.writePackedBands(index, rgba);
  await lab.setStageRange('chain');
  await lab.render();
  return { bandSum: await lab.readFloat('band-sum', 4), merged: await lab.readFloat('merged-0', 4) };
}

async function clayPng(lab) {
  const rgba = await lab.readFloat('diffuse', 4);
  for (let i = 0; i < rgba.length; i += 4) {
    for (let c = 0; c < 3; c++) rgba[i + c] = Math.max(0, rgba[i + c]);
    rgba[i + 3] = 1;
  }
  const display = await lab.composite({ width: WIDTH, height: HEIGHT, rgba });
  const rgb = new Uint8Array(WIDTH * HEIGHT * 3);
  for (let p = 0; p < WIDTH * HEIGHT; p++) for (let c = 0; c < 3; c++) {
    rgb[p * 3 + c] = Math.round(255 * Math.max(0, Math.min(1, display.rgba[p * 4 + c])));
  }
  return encodeRgbPng(WIDTH, HEIGHT, rgb);
}

function signedRgb(values, scale) {
  const rgb = new Uint8Array(PIXELS * 3);
  for (let p = 0; p < PIXELS; p++) for (let c = 0; c < 3; c++) {
    rgb[p * 3 + c] = Math.round(127.5 + 127.5 * Math.max(-1, Math.min(1, values[p * 4 + c] / scale)));
  }
  return rgb;
}

function signedPng(values, scale) {
  return encodeRgbPng(SCAN_WIDTH, SCAN_HEIGHT, signedRgb(values, scale));
}

// 帯和を signedPng の写像で描き、ROI の枠を1画素の白で重ねる。
function roisPng(bandSum, rois) {
  const rgb = signedRgb(bandSum, imageScale([{ bandSum }], 'bandSum', 0.999, false));
  const mark = (x, y) => rgb.fill(255, (y * SCAN_WIDTH + x) * 3, (y * SCAN_WIDTH + x) * 3 + 3);
  for (const [left, top, width, height] of Object.values(rois)) {
    for (let x = left; x < left + width; x++) { mark(x, top); mark(x, top + height - 1); }
    for (let y = top; y < top + height; y++) { mark(left, y); mark(left + width - 1, y); }
  }
  return encodeRgbPng(SCAN_WIDTH, SCAN_HEIGHT, rgb);
}

function magnitudePng(values, scale) {
  const rgb = new Uint8Array(PIXELS * 3);
  for (let p = 0; p < PIXELS; p++) {
    const i = p * 4;
    const magnitude = Math.sqrt((values[i] ** 2 + values[i + 1] ** 2 + values[i + 2] ** 2) / 3);
    const code = Math.round(255 * Math.max(0, Math.min(1, magnitude / scale)));
    for (let c = 0; c < 3; c++) rgb[p * 3 + c] = code;
  }
  return encodeRgbPng(SCAN_WIDTH, SCAN_HEIGHT, rgb);
}

function imageScale(records, key, quantile, magnitude) {
  const values = [];
  for (const record of records) for (let i = 0; i < record[key].length; i += 4) {
    const rgb = record[key];
    if (magnitude) values.push(Math.hypot(rgb[i], rgb[i + 1], rgb[i + 2]) / Math.sqrt(3));
    else for (let c = 0; c < 3; c++) values.push(Math.abs(rgb[i + c]));
  }
  values.sort((a, b) => a - b);
  return Math.max(values[Math.floor(quantile * (values.length - 1))], 1e-12);
}

mkdirSync(OUTPUT, { recursive: true });
const signature = sourceSignature();
const records = [];
for (const scene of scenes) {
  const dir = path.join(OUTPUT, scene.name);
  const cache = path.join(OUTPUT, 'cache', signature, scene.name);
  mkdirSync(dir, { recursive: true });
  mkdirSync(cache, { recursive: true });
  try {
    await withLab(async (lab) => {
    await lab.show({ caseName: scene.caseName, shot: scene.shot, mode: 2, set: 'tuning', key: scene.name });
    const exposure = await lab.exposureFactor();
    await lab.setTier({ ...TIER, bandCount: 1 });
    await lab.setWhiteNoisePass(INVARIANT_PASS);
    await lab.render();
    const rawOne = await lab.readFloat('band-sum', 4);
    await lab.setTier(TIER);
    await lab.render();
    const bandOne = await lab.readFloat('band-sum', 4);
    const mergedOne = await lab.readFloat('merged-0', 4);
    const sumInvariant = invariantDifference(rawOne, bandOne);
    if (sumInvariant.meanAbsolute > 1e-4 || sumInvariant.maximumAbsolute > 0.01) {
      throw new Error(`${scene.name}: one-pass band sum changed: ${JSON.stringify(sumInvariant)}`);
    }
    const baselineDir = path.join(OUTPUT, 'a-baseline');
    const baselineFile = path.join(baselineDir, `${scene.name}.f32`);
    mkdirSync(baselineDir, { recursive: true });
    const alpha = alphaMap(mergedOne);
    if (!existsSync(baselineFile)) writeFloats(baselineFile, alpha);
    const baseline = readFloats(baselineFile);
    if (baseline.length !== alpha.length) throw new Error(`${scene.name}: A baseline size changed`);
    let alphaMaximumDifference = 0, alphaDifferentPixels = 0, alphaDifferenceSum = 0;
    for (let i = 0; i < alpha.length; i++) {
      const delta = Math.abs(alpha[i] - baseline[i]);
      alphaMaximumDifference = Math.max(alphaMaximumDifference, delta);
      alphaDifferenceSum += delta;
      if (delta !== 0) alphaDifferentPixels++;
    }
    writeFloats(path.join(dir, 'one-pass-a.f32'), alpha);
    if (alphaMaximumDifference > 0.001) {
      throw new Error(`${scene.name}: one-pass A changed: max ${alphaMaximumDifference}, ${alphaDifferentPixels} pixels`);
    }
    const zeros = Array.from({ length: 3 }, () => new Float32Array(PIXELS * 4));
    const zeroRgb = await mergedOf(lab, zeros);
    let alphaChangeFromRgb = 0;
    for (let p = 0; p < PIXELS; p++) {
      alphaChangeFromRgb = Math.max(alphaChangeFromRgb, Math.abs(zeroRgb.merged[p * 4 + 3] - alpha[p]));
    }
    if (alphaChangeFromRgb !== 0) throw new Error(`${scene.name}: changing only band RGB changed A by ${alphaChangeFromRgb}`);
    await lab.setStageRange('all');
    console.log(`${scene.name}: one-pass invariants checked`);

    for (let first = 0; first < PASSES; first += CHUNK_PASSES) {
      const files = [0, 1, 2].map((texture) => chunkFile(cache, first, texture));
      if (files.every((file) => existsSync(file) && readFileSync(file).byteLength === PIXELS * 4 * 4)) continue;
      await lab.accumulateWhitePasses(first, CHUNK_PASSES);
      const taken = await lab.takePassSums();
      for (let texture = 0; texture < 3; texture++) {
        const even = taken.sums[0][texture], odd = taken.sums[1][texture];
        const sum = Float32Array.from(even, (value, i) => value + odd[i]);
        writeFloats(files[texture], sum);
      }
      console.log(`${scene.name}: cached scan passes ${first}–${first + CHUNK_PASSES - 1}`);
    }
    const mean = cachedMean(cache, 0, PASSES);
    for (const [index, packed] of mean.entries()) writeFloats(path.join(cache, `mean-${PASSES}-packed-${index}.f32`), packed);
    const full = await mergedOf(lab, mean);
    const structure = rgbDifference(full.bandSum, full.merged);
    const firstHalf = await mergedOf(lab, cachedMean(cache, 0, PASSES / 2));
    const secondHalf = await mergedOf(lab, cachedMean(cache, PASSES / 2, PASSES));
    const structureHalfDifference = rgbDifference(
      rgbDifference(firstHalf.bandSum, firstHalf.merged),
      rgbDifference(secondHalf.bandSum, secondHalf.merged));
    writeFloats(path.join(dir, `structure-${PASSES}.rgba.f32`), structure);
    writeFloats(path.join(dir, `structure-half-difference-${PASSES}.rgba.f32`), structureHalfDifference);
    writeFloats(path.join(dir, `band-sum-${PASSES}.rgba.f32`), full.bandSum);
    writeFloats(path.join(dir, `merged-${PASSES}.rgba.f32`), full.merged);

    const noiseSquares = new Float64Array(PIXELS * 4);
    let onePassAlphaMaximumDifference = 0;
    await lab.setStageRange('all');
    for (let pass = NOISE_FIRST_PASS; pass < NOISE_FIRST_PASS + NOISE_PASSES; pass++) {
      await lab.setWhiteNoisePass(pass);
      await lab.render();
      const one = await lab.readFloat('merged-0', 4);
      for (let i = 0; i < one.length; i += 4) {
        for (let c = 0; c < 3; c++) noiseSquares[i + c] += (one[i + c] - full.merged[i + c]) ** 2;
        onePassAlphaMaximumDifference = Math.max(onePassAlphaMaximumDifference, Math.abs(one[i + 3] - full.merged[i + 3]));
      }
    }
    const noise = Float32Array.from(noiseSquares, (sum, i) => i % 4 === 3 ? 1 : Math.sqrt(sum / NOISE_PASSES));
    writeFloats(path.join(dir, `noise-rms-${PASSES}.rgba.f32`), noise);
    if (onePassAlphaMaximumDifference !== 0) throw new Error(`${scene.name}: A varied across one-pass seeds`);

    await lab.setWhiteNoisePass(null);
    await lab.setSeed(seedOf(0));
    await lab.render();
    const oneCorrection = await lab.readFloat('correction', 4);
    writeFileSync(path.join(dir, 'one-pass-correction.png'), await lab.signedCorrectionPng(
      { width: WIDTH, height: HEIGHT, rgba: oneCorrection }));
    writeFileSync(path.join(dir, 'one-pass-diffuse-clay.png'), await clayPng(lab));
    await mergedOf(lab, mean);
    await lab.setUpsampleAlphaOne(true);
    await lab.render();
    const convergedCorrection = await lab.readFloat('correction', 4);
    writeFileSync(path.join(dir, `mean-${PASSES}-correction.png`), await lab.signedCorrectionPng(
      { width: WIDTH, height: HEIGHT, rgba: convergedCorrection }));
    writeFileSync(path.join(dir, `mean-${PASSES}-diffuse-clay.png`), await clayPng(lab));
    await lab.setTier({ ...TIER, bandCount: 1 });
    await lab.render();
    await lab.writePackedBands(0, full.bandSum);
    await lab.setStageRange('chain');
    await lab.setUpsampleAlphaOne(true);
    await lab.render();
    const bypassCorrection = await lab.readFloat('correction', 4);
    writeFileSync(path.join(dir, `bypass-mean-${PASSES}-correction.png`), await lab.signedCorrectionPng(
      { width: WIDTH, height: HEIGHT, rgba: bypassCorrection }));
    writeFileSync(path.join(dir, `bypass-mean-${PASSES}-diffuse-clay.png`), await clayPng(lab));
    await lab.setUpsampleAlphaOne(false);
    const rois = Object.fromEntries(Object.entries(scene.rois).map(([name, rect]) => {
      const structureRms = rms(structure, rect);
      const residualRms = rms(structureHalfDifference, rect) / 2;
      return [name, {
        rect, structureRms, residualRms,
        residualToStructureRatio: residualRms / Math.max(structureRms, 1e-12),
        noiseRms: rms(noise, rect), signalRms: rms(full.bandSum, rect),
      }];
    }));
    const result = {
      scene: scene.name, passes: PASSES, sourceSignature: signature, exposure,
      onePassBandSum: sumInvariant, onePassAlphaMaximumDifference: alphaMaximumDifference,
      onePassAlphaDifferentPixels: alphaDifferentPixels,
      onePassAlphaMeanAbsoluteDifference: alphaDifferenceSum / alpha.length,
      alphaChangeFromRgb,
      alphaVariationAcrossNoisePasses: onePassAlphaMaximumDifference,
      rois,
      referenceCache: path.relative(OUTPUT, cache).replaceAll('\\', '/'),
    };
    records.push({ ...result, structure, structureHalfDifference, noise, bandSum: full.bandSum, rects: scene.rois });
    writeFileSync(path.join(dir, 'metrics.json'), JSON.stringify(result, null, 2));
    for (const [name, m] of Object.entries(rois)) {
      console.log(`${scene.name}/${name}: structure ${m.structureRms.toFixed(6)}, `
        + `residual/structure ${(m.residualToStructureRatio * 100).toFixed(1)}%, `
        + `noise ${m.noiseRms.toFixed(6)}, signal ${m.signalRms.toFixed(6)}`);
    }
    });
  } catch (error) {
    if (error?.code !== 'EPERM' || !records.some(({ scene: name }) => name === scene.name)) throw error;
    console.warn(`${scene.name}: images saved; Chrome profile cleanup returned EPERM`);
  }
}

const structureScale = imageScale(records, 'structure', 0.999, false);
const halfDifferenceScale = structureScale;
const noiseScale = imageScale(records, 'noise', 0.995, true);
for (const record of records) {
  const dir = path.join(OUTPUT, record.scene);
  writeFileSync(path.join(dir, `structure-${PASSES}.png`), signedPng(record.structure, structureScale));
  writeFileSync(path.join(dir, `structure-half-difference-${PASSES}.png`),
    signedPng(record.structureHalfDifference, halfDifferenceScale));
  writeFileSync(path.join(dir, `noise-rms-${PASSES}.png`), magnitudePng(record.noise, noiseScale));
  writeFileSync(path.join(dir, 'rois.png'), roisPng(record.bandSum, record.rects));
}
const metrics = records.map(({ structure, structureHalfDifference, noise, bandSum, rects, ...record }) => record);
writeFileSync(path.join(OUTPUT, 'record.json'), JSON.stringify({ passes: PASSES, sourceSignature: signature,
  structureScale, halfDifferenceScale, noiseScale, structureQuantile: 0.999, noiseQuantile: 0.995,
  metrics }, null, 2));
const cards = metrics.flatMap(({ scene }) => [
  [`${scene}/rois.png`, `評価範囲: ${PASSES}パスの収束帯和と ROI の枠`],
  [`${scene}/structure-${PASSES}.png`, '構造誤差: 4帯の収束帯和 − 縮小・合流'],
  [`${scene}/structure-half-difference-${PASSES}.png`, '収束確認: 前半と後半の構造誤差の差'],
  [`${scene}/noise-rms-${PASSES}.png`, '1パス雑音: 合流後 − 収束合流後の32パス二乗平均'],
  [`${scene}/one-pass-correction.png`, '1パスの補正項'],
  [`${scene}/bypass-mean-${PASSES}-correction.png`, `${PASSES}パスの帯和を鎖迂回した補正項（A=1）`],
  [`${scene}/mean-${PASSES}-correction.png`, `${PASSES}パス走査平均後の補正項（A=1）`],
  [`${scene}/one-pass-diffuse-clay.png`, '1パスの拡散照度（負値を0へ切ったクレイ）'],
  [`${scene}/bypass-mean-${PASSES}-diffuse-clay.png`, `${PASSES}パスの帯和を鎖迂回した拡散照度クレイ（A=1）`],
  [`${scene}/mean-${PASSES}-diffuse-clay.png`, `${PASSES}パス走査平均後の拡散照度クレイ（A=1）`],
].map(([file, label]) => `<figure><img src="${file}"><figcaption>${scene} — ${label}</figcaption></figure>`));
writeFileSync(path.join(OUTPUT, 'index.html'), `<!doctype html><html lang="ja"><meta charset="utf-8">
<title>8-15 帯鎖の指標</title><style>body{margin:24px;background:#17191d;color:#eee;font:14px system-ui}
main{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:18px}figure{margin:0}
img{display:block;width:100%;background:#222;image-rendering:auto}figcaption{padding:7px}</style>
<h1>8-15 帯鎖の指標</h1><p>${PASSES}パスの4帯走査平均を鎖へ入力。差分はすべて240×135画素。
符号付き画像は中間灰が0。各種類の表示尺度は record.json に記録。</p><main>${cards.join('\n')}</main></html>`);
