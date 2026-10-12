// 手順8.5-5。収束先(偶数と奇数の半分の両方)で見える負の拡散照度 E + C が、どの段で初めて出るかを切り分ける。
// E はオフの方式の拡散照度。行: 1 = 全解像度の B の補正(R_full)、1q = 中の段の走査の帯の 1024 パス平均(R_q)、
// 2 = R_q を鎖へ(C_0)、3 = R_q を最後の拡大だけへ(U)、2+3 = R_q を鎖と最後の拡大へ。
// 使い方: node tools/render-lab-screen-space-negative-irradiance.mjs(結果のある撮影は飛ばす。出力は ssd-8.5/negative3/、B は 8.5-after2)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { encodeRgbPng } from './png.mjs';
import { linearToSrgb } from './screen-space-error.mjs';
import {
  analyticRatiosOf, ENTRIES, entryInMode, fixed, HEIGHT, maskOf, readFloats, referenceMetaOf, referenceSumsOf, seedOf,
  shotsDir, table, TIERS, unpackedBand, WIDTH, windowRatiosOf, withLab, writeFloats,
} from './screen-space-lab.mjs';
import { reference } from './screen-space-reference.mjs';
import { gbufferTexelOf, scanMaskOf } from './screen-space-scan.mjs';

const OUTPUT = path.join(shotsDir, 'ssd-8.5', 'negative3');
const REFERENCE_NAME = '8.5-after2';
const REFERENCE_PASSES = 1024;
const SHOTS = ['bay-earth-open', 'bay-earth-overhead', 'bay-moon-open', 'bay', 'cornell-box'];
const TIER = TIERS.medium;
const SCAN_WIDTH = Math.round(WIDTH * TIER.scale);
const SCAN_HEIGHT = Math.round(HEIGHT * TIER.scale);
const SCAN_PIXELS = SCAN_WIDTH * SCAN_HEIGHT;
const PIXELS = WIDTH * HEIGHT;
const SCAN_PASSES = 1024;
const CHUNK_PASSES = 256;
const ROTATIONS_PER_HALF = 32;
const PRODUCTION_PASSES = 64;
const HALVES = ['even', 'odd'];
// 雑音の条件: 半分どうしの平均が見える下限を、標準誤差のこの倍数より深く下回る。標準誤差は、半分どうしの差 / 2 の二乗を
// 画素のまわり (2·NOISE_RADIUS + 1) 四方の測る画素(E > 0 のもの。光の無い画素は差が 0 で分散を薄める)で平均した分散の平方根。
const NOISE_MARGIN = 3;
const NOISE_RADIUS = 2;
// 表示の 1 LSB に当たる、黒の近くの線形の値(render-lab-screen-space-metrics.mjs と同じ)。
const DISPLAY_LSB = 1 / (255 * 12.92);
const MAP_SCALE = 2;
const LEGEND_HEIGHT = 24;

// 走査の画素 s の受け手が読む G バッファの画素の番号と、全解像度の画素 p を覆う走査の画素の番号。
const receiverPixels = Int32Array.from({ length: SCAN_PIXELS }, (_, s) => (
  gbufferTexelOf(Math.floor(s / SCAN_WIDTH), SCAN_HEIGHT, HEIGHT) * WIDTH + gbufferTexelOf(s % SCAN_WIDTH, SCAN_WIDTH, WIDTH)));
const scanPixelOf = (p) => Math.floor(Math.floor(p / WIDTH) * SCAN_HEIGHT / HEIGHT) * SCAN_WIDTH + Math.floor((p % WIDTH) * SCAN_WIDTH / WIDTH);

function unitOf(shot, modeName) {
  const base = ENTRIES.find((e) => e.key === shot);
  const entry = modeName === 'indirect' ? base : entryInMode(base, 'occlusion');
  return { entry, offEntry: { ...entry, mode: 0 }, dir: path.join(OUTPUT, entry.key.replace('@', '-')) };
}
const units = SHOTS.flatMap((shot) => ['occlusion', 'indirect'].map((modeName) => unitOf(shot, modeName)));

// Chrome のプロファイル削除の EPERM は結果と無関係なので、work が終わっていれば捨てる。
async function withLabIgnoringCleanup(work) {
  let completed = false;
  try {
    await withLab(async (lab) => {
      await work(lab);
      completed = true;
    });
  } catch (error) {
    if (error?.code !== 'EPERM' || !completed) throw error;
    console.warn('Chrome profile cleanup returned EPERM (ignored)');
  }
}

// ---- 撮影 ----

// B(REFERENCE_NAME)に無い撮影 entry を足す。reference は ENTRIES から撮影を引くので、無い方式の key は ENTRIES へ足してから呼ぶ。
async function ensureReference(entry) {
  if ((referenceMetaOf(REFERENCE_NAME, entry)?.passes ?? 0) >= REFERENCE_PASSES) return;
  if (!ENTRIES.some((e) => e.key === entry.key)) ENTRIES.push(entry);
  const options = { name: REFERENCE_NAME, entries: entry.key, slices: '4', steps: '5', passes: String(REFERENCE_PASSES) };
  try {
    await reference({ options });
  } catch (error) {
    if (error?.code !== 'EPERM' || (referenceMetaOf(REFERENCE_NAME, entry)?.passes ?? 0) < REFERENCE_PASSES) throw error;
  }
}

const packedFile = (dir, half, texture) => path.join(dir, `rq-${half}-${texture}.f32`);
const packedOf = (dir, half) => [0, 1, 2].map((texture) => readFloats(packedFile(dir, half, texture)));

// 帯の和(画素ごとに rgb)。
function bandSumOf(packed) {
  const sum = new Float32Array(SCAN_PIXELS * 3);
  for (let band = 0; band < TIER.bandCount; band++) {
    const values = unpackedBand(packed, band);
    for (let i = 0; i < sum.length; i++) sum[i] += values[i];
  }
  return sum;
}

const rgbaOfRgb = (rgb) => Float32Array.from({ length: rgb.length / 3 * 4 }, (_, i) => (i % 4 === 3 ? 1 : rgb[Math.floor(i / 4) * 3 + i % 4]));

// 走査の描き直しの準備: 段 tier・段の範囲 range・A を固定するかを決めて 1 度全段を描く。
async function prepare(lab, tier, alphaOne) {
  await lab.setTier(tier);
  await lab.setWhiteNoisePass(null);
  await lab.setSeed(seedOf(0));
  await lab.setStageRange('all');
  await lab.setUpsampleAlphaOne(false);
  await lab.render();
  await lab.setUpsampleAlphaOne(alphaOne);
}

// 中の段の走査の帯の SCAN_PASSES パス平均(白色雑音)を、偶数番目と奇数番目の半分ごとに rq-*.f32 へ。
async function captureScanBands(lab, dir) {
  await prepare(lab, TIER, false);
  const sums = HALVES.map(() => [0, 1, 2].map(() => new Float64Array(SCAN_PIXELS * 4)));
  for (let first = 0; first < SCAN_PASSES; first += CHUNK_PASSES) {
    await lab.accumulateWhitePasses(first, CHUNK_PASSES);
    const taken = await lab.takePassSums(false);
    for (const [parity, textures] of taken.sums.entries()) {
      for (const [texture, values] of textures.entries()) {
        for (let i = 0; i < values.length; i++) sums[parity][texture][i] += values[i];
      }
    }
    console.log(`  scan passes ${first}–${first + CHUNK_PASSES - 1}`);
  }
  for (const [parity, half] of HALVES.entries()) {
    for (const [texture, sum] of sums[parity].entries()) {
      writeFloats(packedFile(dir, half, texture), Float32Array.from(sum, (v) => v / (SCAN_PASSES / 2)));
    }
  }
}

// 半分ごとに、帯 packed(3 枚)を鎖の入力へ書き、seed を ROTATIONS_PER_HALF 通り回して全解像度の補正を平均する。
// 半分ごとに使う seed は重ならない(回転の雑音が半分どうしの差に出る)。返り値は半分ごとの全解像度の平均。
async function averageOverRotations(lab, inputs) {
  for (const [half, writes] of inputs.entries()) {
    for (const [texture, rgba] of writes.entries()) await lab.writePackedBands(texture, rgba);
    for (let k = 0; k < ROTATIONS_PER_HALF; k++) {
      await lab.setSeed(seedOf(half * ROTATIONS_PER_HALF + k));
      await lab.render();
      await lab.accumulateFloat('correction', 3, half);
    }
  }
  const sums = await lab.takeAccumulated('correction', inputs.length);
  return sums.map((sum) => sum.map((v) => v / ROTATIONS_PER_HALF));
}

// 行 2・2+3(鎖あり)と行 3(最後の拡大だけ)を撮る。
async function captureChainRows(lab, dir) {
  await prepare(lab, TIER, false);
  await lab.setStageRange('chain');
  for (const half of HALVES) {
    for (const [texture, rgba] of packedOf(dir, half).entries()) await lab.writePackedBands(texture, rgba);
    await lab.render();
    writeFloats(path.join(dir, `c2-${half}.f32`), await lab.readFloat('scan-correction', 3));
  }
  const chained = await averageOverRotations(lab, HALVES.map((half) => packedOf(dir, half)));
  HALVES.forEach((half, h) => writeFloats(path.join(dir, `u23-${half}.f32`), chained[h]));
  await prepare(lab, { ...TIER, bandCount: 1 }, true);
  await lab.setStageRange('chain');
  const sums = await averageOverRotations(lab, HALVES.map((half) => [rgbaOfRgb(bandSumOf(packedOf(dir, half)))]));
  HALVES.forEach((half, h) => writeFloats(path.join(dir, `u3-${half}.f32`), sums[h]));
}

// 本番(ブルーノイズの seed 0〜PRODUCTION_PASSES − 1)の最終出力の補正を 1 パスずつ撮り、E + C の見える負の画素の数を
// パスごとに、補正の平均と不偏分散を画素・成分ごとに残す。最初のパスでは、拡散照度の読み戻しが E + C に合うかも調べる。
async function captureProduction(lab, dir, e, mask, exposure) {
  await prepare(lab, TIER, false);
  const sums = new Float64Array(PIXELS * 3);
  const squares = new Float64Array(PIXELS * 3);
  const counts = [];
  let diffuseMismatchPixels = 0;
  for (let k = 0; k < PRODUCTION_PASSES; k++) {
    await lab.setSeed(seedOf(k));
    await lab.render();
    const c = await lab.readFloat('correction', 3);
    if (k === 0) {
      const diffuse = await lab.readFloat('diffuse', 3);
      for (let i = 0; i < diffuse.length; i++) {
        if (Math.abs(diffuse[i] - (e[i] + c[i])) > 2 ** -9 * (Math.abs(e[i]) + Math.abs(c[i])) + 1e-6) diffuseMismatchPixels++;
      }
    }
    for (let i = 0; i < c.length; i++) {
      sums[i] += c[i];
      squares[i] += c[i] * c[i];
    }
    const { visibleCount, negativeCount } = flagsOf(e, c, mask, exposure);
    counts.push({ visibleCount, negativeCount });
    console.log(`  production pass ${k}`);
  }
  writeFloats(path.join(dir, 'prod-mean.f32'), Float32Array.from(sums, (v) => v / PRODUCTION_PASSES));
  writeFloats(path.join(dir, 'prod-variance.f32'), Float32Array.from(sums, (sum, i) => (
    (squares[i] - sum * sum / PRODUCTION_PASSES) / (PRODUCTION_PASSES - 1))));
  return { passes: counts, diffuseMismatchPixels };
}

async function captureUnit(lab, { entry, offEntry, dir }) {
  const started = Date.now();
  await lab.show(offEntry);
  await lab.capturePng();
  const e = await lab.readFloat('diffuse', 3);
  const exposureOff = await lab.exposureFactor();
  writeFloats(path.join(dir, 'e.f32'), e);
  await lab.show(entry);
  await lab.capturePng();
  const exposure = await lab.exposureFactor();
  const radius = await lab.readFloat('projected-radius', 1);
  writeFloats(path.join(dir, 'radius.f32'), radius);
  if (!existsSync(packedFile(dir, 'odd', 2))) await captureScanBands(lab, dir);
  await captureChainRows(lab, dir);
  const production = await captureProduction(lab, dir, e, maskOf(radius, TIER.scale), exposure);
  writeFileSync(path.join(dir, 'capture.json'), JSON.stringify({
    exposure, exposureOff, production, seconds: (Date.now() - started) / 1000 }, null, 1));
}

// ---- 数え方 ----

// E + C の最小成分が、見えるほど(アルベド 1 の表示で 1 LSB 以上)・0 未満で負の画素の印と数。mask の外は印を立てない。
function flagsOf(e, c, mask, exposure) {
  const visibleLimit = -DISPLAY_LSB * Math.PI / exposure;
  const visible = new Uint8Array(mask.length);
  const negative = new Uint8Array(mask.length);
  let [visibleCount, negativeCount] = [0, 0];
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    const lowest = Math.min(e[3 * p] + c[3 * p], e[3 * p + 1] + c[3 * p + 1], e[3 * p + 2] + c[3 * p + 2]);
    if (lowest < visibleLimit) { visible[p] = 1; visibleCount++; }
    if (lowest < 0) { negative[p] = 1; negativeCount++; }
  }
  return { visible, negative, visibleCount, negativeCount };
}

const countOf = (flags) => flags.reduce((total, v) => total + v, 0);
const bothOf = (a, b) => a.map((v, i) => v & b[i]);
const halfMean = (halves) => Float32Array.from(halves[0], (v, i) => (v + halves[1][i]) / 2);
const sampledAtReceivers = (full) => Float32Array.from({ length: SCAN_PIXELS * 3 }, (_, i) => full[receiverPixels[Math.floor(i / 3)] * 3 + i % 3]);

// 偶数と奇数の半分 halves(補正の組、行の解像度が width 幅)の E + C の、両方の半分で満たす画素の印の組 { visible, negative } と、
// 半分の平均が見える下限を標準誤差の NOISE_MARGIN 倍より深く下回る画素の印 robust。
function bothHalvesFlags(e, halves, mask, exposure, width) {
  const [first, second] = halves.map((c) => flagsOf(e, c, mask, exposure));
  const limit = -DISPLAY_LSB * Math.PI / exposure;
  const lowestChannels = Uint8Array.from(mask, (_, p) => {
    const sums = [0, 1, 2].map((c) => e[3 * p + c] + (halves[0][3 * p + c] + halves[1][3 * p + c]) / 2);
    return sums.indexOf(Math.min(...sums));
  });
  const halfDifferenceSquares = Float64Array.from(mask, (_, p) => ((halves[0][3 * p + lowestChannels[p]] - halves[1][3 * p + lowestChannels[p]]) / 2) ** 2);
  const height = mask.length / width;
  const robust = Uint8Array.from(mask, (m, p) => {
    if (!m) return 0;
    let [sum, count] = [0, 0];
    for (let y = Math.max(0, Math.floor(p / width) - NOISE_RADIUS); y <= Math.min(height - 1, Math.floor(p / width) + NOISE_RADIUS); y++) {
      for (let x = Math.max(0, (p % width) - NOISE_RADIUS); x <= Math.min(width - 1, (p % width) + NOISE_RADIUS); x++) {
        if (mask[y * width + x] && e[3 * (y * width + x) + lowestChannels[y * width + x]] > 0) { sum += halfDifferenceSquares[y * width + x]; count++; }
      }
    }
    const c = lowestChannels[p];
    const lowest = e[3 * p + c] + (halves[0][3 * p + c] + halves[1][3 * p + c]) / 2;
    return lowest < limit - NOISE_MARGIN * Math.sqrt(sum / count) ? 1 : 0;
  });
  return { visible: bothOf(first.visible, second.visible), negative: bothOf(first.negative, second.negative), robust };
}

// ---- 地図 ----

const ATTRIBUTION_COLORS = [[255, 40, 40], [255, 210, 0], [0, 220, 255], [255, 0, 255]];
const MARGIN_COLORS = [[255, 40, 40], [255, 255, 0], [255, 140, 0], [40, 200, 80], [150, 150, 150], [20, 40, 110], [0, 0, 0]];

// 解像度 WIDTH × HEIGHT の画素ごとの色 colorOf(p) を MAP_SCALE 倍にして、下に凡例の色 swatches を並べた PNG。
function mapPng(colorOf, swatches) {
  const [width, height] = [WIDTH * MAP_SCALE, HEIGHT * MAP_SCALE + LEGEND_HEIGHT];
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < HEIGHT * MAP_SCALE; y++) {
    for (let x = 0; x < width; x++) rgb.set(colorOf(Math.floor(y / MAP_SCALE) * WIDTH + Math.floor(x / MAP_SCALE)), (y * width + x) * 3);
  }
  for (const [i, color] of swatches.entries()) {
    for (let y = HEIGHT * MAP_SCALE + 4; y < height - 4; y++) {
      for (let x = 8 + i * 72; x < 8 + i * 72 + 64; x++) rgb.set(color, (y * width + x) * 3);
    }
  }
  return encodeRgbPng(width, height, rgb);
}

// 最初に出た段(1・2・3・2 と 3 の重なり)の色。出ない画素は、E + C の輝度の灰色。
function attributionPng(stages, gray) {
  return mapPng((p) => (stages[p] ? ATTRIBUTION_COLORS[stages[p] - 1] : gray[p]), ATTRIBUTION_COLORS);
}

// 1q の余裕 exposure·min(E_rx + R_q)/π を LSB で色分けした走査の解像度の地図。色は MARGIN_COLORS の順に、負・0〜4・4〜16・
// 16〜64・64 以上・E_rx が 16 LSB 未満で暗い受け手・測らない画素。
const MARGIN_LIMITS = [0, 4, 16, 64];
function marginPng(marginLsb, litLsb, scanMask) {
  const classOf = (s) => {
    if (!scanMask[s]) return 6;
    if (litLsb[s] < 16) return 5;
    const index = MARGIN_LIMITS.findIndex((limit) => marginLsb[s] < limit);
    return index === -1 ? MARGIN_LIMITS.length : index;
  };
  return mapPng((p) => MARGIN_COLORS[classOf(scanPixelOf(p))], MARGIN_COLORS);
}

// ---- 解析 ----

const lowestOf = (values, p) => Math.min(values[3 * p], values[3 * p + 1], values[3 * p + 2]);

// 1・1q に見える負の画素(印 flags)のうち E + C が最も低い 5 画素の座標と値。receivers は E、correction は補正の平均(どちらも
// 行の解像度で、画素ごとに rgb)。
function worstPixels(label, width, receivers, correction, flags) {
  const lowestSumAt = (p) => Math.min(...[0, 1, 2].map((c) => receivers[3 * p + c] + correction[3 * p + c]));
  const worst = Array.from(flags.keys()).filter((p) => flags[p]).sort((a, b) => lowestSumAt(a) - lowestSumAt(b));
  return worst.slice(0, 5).map((p) => {
    const take = (values) => [0, 1, 2].map((c) => values[3 * p + c]);
    const [eValue, rValue] = [take(receivers), take(correction)];
    return { row: label, x: p % width, y: Math.floor(p / width), E: eValue, R: rValue,
      blockedFraction: eValue.map((v, c) => (v > 0 ? -rValue[c] / v : null)) };
  });
}

function windowRatiosFrom(entry, e, corrections) {
  if (entry.shot !== 'bay-earth-open' && entry.shot !== 'bay-moon-open') return null;
  return corrections.map((c) => windowRatiosOf(entry, Float32Array.from(e, (v, i) => v + c[i]))[0]);
}

// 撮影 unit の撮った値と B から、見える負の画素の数・帰属・確かめ方の確かめ・有界性・窓の比を求め、地図を書く。
function analyzeUnit({ entry, dir }) {
  const read = (name) => readFloats(path.join(dir, name));
  const { exposure, exposureOff, production } = JSON.parse(readFileSync(path.join(dir, 'capture.json'), 'utf8'));
  const [e, radius] = [read('e.f32'), read('radius.f32')];
  const [fullMask, scanMask] = [maskOf(radius, TIER.scale), scanMaskOf(radius, TIER.scale, SCAN_WIDTH, SCAN_HEIGHT)];
  const erx = sampledAtReceivers(e);
  const perHalf = (name) => HALVES.map((half) => read(`${name}-${half}.f32`));
  const rq = HALVES.map((half) => bandSumOf(packedOf(dir, half)));
  const corrections = {
    '1': referenceSumsOf(REFERENCE_NAME, entry, 'correction').map((sum) => sum.map((v) => v / (REFERENCE_PASSES / 2))),
    '1q': rq, '2': perHalf('c2'), '3': perHalf('u3'), '2+3': perHalf('u23'),
  };
  const rows = [['1', e, fullMask, WIDTH], ['1q', erx, scanMask, SCAN_WIDTH], ['2', erx, scanMask, SCAN_WIDTH],
    ['3', e, fullMask, WIDTH], ['2+3', e, fullMask, WIDTH]];
  const flags = {};
  const counts = {};
  for (const [id, receivers, mask, width] of rows) {
    flags[id] = bothHalvesFlags(receivers, corrections[id], mask, exposure, width);
    counts[id] = { visible: countOf(flags[id].visible), negative: countOf(flags[id].negative), robust: countOf(flags[id].robust) };
  }
  const stopDetails = ['1', '1q'].filter((id) => counts[id].robust > 0).flatMap((id) => {
    const [, receivers, , width] = rows.find(([rowId]) => rowId === id);
    return worstPixels(id, width, receivers, halfMean(corrections[id]), flags[id].robust);
  });
  const stages = Uint8Array.from({ length: PIXELS }, (_, p) => {
    const s = scanPixelOf(p);
    if (flags['1'].robust[p] || flags['1q'].robust[s]) return 1;
    if (flags['2'].visible[s]) return 2;
    if (flags['3'].visible[p]) return 3;
    return flags['2+3'].visible[p] ? 4 : 0;
  });
  const classes = [1, 2, 3, 4].map((stage) => stages.filter((v) => v === stage).length);
  const chained = halfMean(corrections['2+3']);
  const gray = Array.from({ length: PIXELS }, (_, p) => {
    const luminance = [0.2126, 0.7152, 0.0722].reduce((total, w, c) => total + w * Math.max(0, e[3 * p + c] + chained[3 * p + c]), 0);
    const code = Math.round(127 * linearToSrgb(Math.min(1, exposure * luminance / Math.PI)));
    return [code, code, code];
  });
  const scale = exposure / Math.PI / DISPLAY_LSB;
  const rqMean = halfMean(rq);
  const marginLsb = Float32Array.from({ length: SCAN_PIXELS }, (_, s) => scale * Math.min(
    ...[0, 1, 2].map((c) => erx[3 * s + c] + rqMean[3 * s + c])));
  const litLsb = Float32Array.from({ length: SCAN_PIXELS }, (_, s) => scale * lowestOf(erx, s));
  const mapsDir = path.join(OUTPUT, 'maps');
  mkdirSync(mapsDir, { recursive: true });
  writeFileSync(path.join(mapsDir, `${path.basename(dir)}.attribution.png`), attributionPng(stages, gray));
  writeFileSync(path.join(mapsDir, `${path.basename(dir)}.margin.png`), marginPng(marginLsb, litLsb, scanMask));
  const stuck = marginLsb.filter((v, s) => scanMask[s] && litLsb[s] >= 16 && v >= 0 && v < 4).length;
  const result = {
    key: entry.key, exposure, exposureOff, measuredFull: countOf(fullMask), measuredScan: countOf(scanMask),
    counts, classes, stuckReceivers: stuck, stopDetails, production,
    check: checkOf(fullMask, corrections['2+3'], read('prod-mean.f32'), read('prod-variance.f32')),
    windows: windowRatiosFrom(entry, e, [halfMean(corrections['1']), chained, read('prod-mean.f32')]),
  };
  writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 1));
  return result;
}

// 確かめ方の確かめ: 2+3 の半分 halves の平均と本番の 64 パス平均 productionMean の差の RMS と、両者の雑音の見積もり
// (本番は画素・成分ごとの不偏分散 productionVariance / 64 の平均、2+3 は半分どうしの差の RMS / 2)の比。測る画素 mask の
// 成分あたり。meanDifference は 2+3 − 本番 の平均(偏り)。
function checkOf(mask, halves, productionMean, productionVariance) {
  const chained = halfMean(halves);
  let [differenceSquares, varianceSum, halfDifferenceSquares, differenceSum, components] = [0, 0, 0, 0, 0];
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    for (let i = 3 * p; i < 3 * p + 3; i++) {
      const difference = chained[i] - productionMean[i];
      differenceSquares += difference ** 2;
      differenceSum += difference;
      varianceSum += productionVariance[i];
      halfDifferenceSquares += (halves[0][i] - halves[1][i]) ** 2;
      components++;
    }
  }
  const rms = Math.sqrt(differenceSquares / components);
  const productionNoise = Math.sqrt(varianceSum / components / PRODUCTION_PASSES);
  const chainNoise = Math.sqrt(halfDifferenceSquares / components) / 2;
  return { rms, productionNoise, chainNoise, ratio: rms / Math.hypot(productionNoise, chainNoise),
    meanDifference: differenceSum / components };
}

// ---- 表 ----

function writeTable(results) {
  const rowIds = ['1', '1q', '2', '3', '2+3'];
  const pair = (c) => `${c.visible} / ${c.negative} / ${c.robust}`;
  const lines = [
    '# 負の照度の切り分け(手順8.5-5)', '',
    '見える負の画素 / 0 未満の画素(どちらも偶数と奇数の半分の両方で満たすもの)/ 見える負で、1024 パス平均が標準誤差(5×5 の測る画素で束ねた分散)の 3 倍より深いもの(雑音の条件)。1・3・2+3 は全解像度の画素、1q・2 は走査の画素。', '',
    ...table(['撮影', '測る画素(全 / 走査)', ...rowIds], results.map((r) => [
      r.key, `${r.measuredFull} / ${r.measuredScan}`, ...rowIds.map((id) => pair(r.counts[id]))])),
    '', '## 帰属(全解像度の画素。最初に出た段)', '',
    ...table(['撮影', '1', '2', '3', '2 と 3 の重なり', '1q の余裕 0〜4 LSB の受け手(走査)'], results.map((r) => [
      r.key, ...r.classes, r.stuckReceivers])),
    '', '## 確かめ方の確かめ(2+3 と本番の 64 パス平均。成分あたり、測る画素)', '',
    ...table(['撮影', '差の RMS', '本番の雑音', '2+3 の雑音', '比 = RMS / √(雑音²の和)', '2+3 − 本番 の平均'], results.map((r) => [
      r.key, ...[r.check.rms, r.check.productionNoise, r.check.chainNoise].map((v) => v.toExponential(2)),
      fixed(r.check.ratio, 2), r.check.meanDifference.toExponential(2)])),
    '', '## 本番の最終出力(64 パスの 1 パスごと)の見える負の画素 最小 / 中央 / 最大', '',
    ...table(['撮影', '見える', '0 未満', '拡散照度の読み戻しと E + C が合わない画素'], results.map((r) => {
      const range = (field) => {
        const sorted = r.production.passes.map((pass) => pass[field]).sort((a, b) => a - b);
        return `${sorted[0]} / ${sorted[Math.floor(sorted.length / 2)]} / ${sorted.at(-1)}`;
      };
      return [r.key, range('visibleCount'), range('negativeCount'), r.production.diffuseMismatchPixels];
    })),
    '', '## 窓の比(P_in / P_out の拡散照度の輝度比)', '',
    ...table(['撮影', '解析値', 'B', '2+3', '本番 64 パス'], results.filter((r) => r.windows !== null).map((r) => [
      r.key, analyticRatiosOf(r.key).map((v) => fixed(v, 3)).join(' / '), ...r.windows.map((v) => fixed(v, 3))])),
    '',
  ];
  writeFileSync(path.join(OUTPUT, 'table.md'), lines.join('\n'));
  return lines.join('\n');
}

// ---- 実行 ----

async function main() {
  mkdirSync(OUTPUT, { recursive: true });
  const results = [];
  for (const unit of units) {
    mkdirSync(unit.dir, { recursive: true });
    if (!existsSync(path.join(unit.dir, 'result.json'))) {
      await ensureReference(unit.entry);
      if (!existsSync(path.join(unit.dir, 'capture.json'))) await withLabIgnoringCleanup((lab) => captureUnit(lab, unit));
      analyzeUnit(unit);
    }
    const result = JSON.parse(readFileSync(path.join(unit.dir, 'result.json'), 'utf8'));
    results.push(result);
    console.log(`${unit.entry.key}: ${JSON.stringify(result.counts)}`);
    if (result.stopDetails.length > 0) {
      console.error(`STOP: 1 か 1q に見える負の画素 ${unit.entry.key}\n${JSON.stringify(result.stopDetails, null, 1)}`);
      process.exit(2);
    }
  }
  console.log(writeTable(results));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
