// 近傍拡散補正の走査の解像度(1/8・1/4・1/2・1)ごとの、32 パス平均・1 パス・画素ごとの分散・偶奇の半分の差の撮影と、
// 全解像度の収束先 B と並べて見る閲覧ページ、数の表。手順 9 の撮影(--scenes で SCENES の名前を , で並べる。既定は全部)。
//
//   node tools/render-lab-screen-space-scan-scale.mjs [--scenes a,b] [--reference <Bの名前>]
//
// 先に .render-lab/ を組み(webpack --config webpack.render-lab.config.js --mode production)、撮影ごとに B を作っておくこと
// (render-lab-screen-space-metrics.mjs reference --name <Bの名前> --entries <撮影> --slices 4 --steps 5 --passes N)。
// 置き場は .render-lab-shots/ssd-9/<撮影>/ と、全撮影をまとめた ssd-9/index.html・summary.md。撮ったことのある撮影は
// 撮り直さず、保存した値から画像と表だけを作り直す。浮動小数のファイルは補正 ΔE のまま(分散は ΔE²)、表の統計は q = 露出係数·ΔE/π。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { encodeRgbPng } from './png.mjs';
import { SCENES, tierOf } from './screen-space-chain-setup.mjs';
import {
  builtMetaOf, fixed, HEIGHT, headHash, maskOf, readFloats, referenceFileOf, referenceSumsOf, seedOf, selectedEntries,
  shotsDir, table, WIDTH, withLab, writeFloats,
} from './screen-space-lab.mjs';

const PASSES = 32;
const ONE_PASS_SEEDS = 4;
const BAND_SCALE = 0.38;
const SCALES = [
  { tag: '1-8', label: '1/8', scale: 0.125 }, { tag: '1-4', label: '1/4', scale: 0.25 },
  { tag: '1-2', label: '1/2', scale: 0.5 }, { tag: '1', label: '1', scale: 1 },
];
const BASE = '1-4';
const PARTNER = { '1-8': '1-4', '1-4': '1-2', '1-2': '1-4', 1: '1-4' };
const GAINS = [1, 4];
// 最後の拡大の半径の下限 [走査の画素](correction-reconstruction.ts の UPSAMPLE_FLOOR_RADIUS)。
const FLOOR_SCAN_PX = 3 / Math.SQRT2;
const rootDir = path.join(shotsDir, 'ssd-9');
const PIXELS = WIDTH * HEIGHT;

// ---- 統計 ----

// 画素ごとに rgb を並べた values の、印 mask の立った画素での二乗平均平方根。
function rmsOf(values, mask) {
  let [total, count] = [0, 0];
  for (let p = 0; p < PIXELS; p++) {
    if (!mask[p]) continue;
    for (let c = 0; c < 3; c++) total += values[3 * p + c] ** 2;
    count += 3;
  }
  return Math.sqrt(total / count);
}

const maskedValues = (values, mask) => Array.from(values.keys()).filter((p) => mask[p]).map((p) => values[p]);
const meanOfList = (list) => list.reduce((a, b) => a + b, 0) / list.length;
const percentileOf = (list, q) => Float64Array.from(list).sort()[Math.floor(q * (list.length - 1))];
const difference = (a, b, scale = 1) => a.map((v, i) => scale * (v - b[i]));

// 偶奇のパスのモーメント slots(takeMoments の slots。成分 3 つ)から、ΔE の平均・偶 − 奇の差と、画素ごとの RGB 平均の分散
// (ΔE²。不偏)。
function momentsOf(slots) {
  const half = PASSES / 2;
  const [even, odd] = slots;
  const mean = new Float32Array(3 * PIXELS);
  const halfDifference = new Float32Array(3 * PIXELS);
  const variance = new Float32Array(PIXELS);
  for (let i = 0; i < 3 * PIXELS; i++) {
    const total = even.sum[i] + odd.sum[i];
    mean[i] = total / PASSES;
    halfDifference[i] = even.sum[i] / half - odd.sum[i] / half;
    variance[Math.floor(i / 3)] += (even.squareSum[i] + odd.squareSum[i] - total * total / PASSES) / (PASSES - 1) / 3;
  }
  return { mean, halfDifference, variance };
}

// ---- 撮影 ----

async function captureScale(lab, entry, { tag, scale }, outDir, exposureOf) {
  await lab.show(entry);
  await lab.setTier({ ...tierOf(BAND_SCALE), scale });
  await lab.setWhiteNoisePass(null);
  await lab.setStageRange('all');
  await lab.setUpsampleAlphaOne(false);
  await lab.setSeed(seedOf(0));
  await lab.capturePng();
  exposureOf(await lab.exposureFactor());
  const onePass = [];
  const started = Date.now();
  for (let k = 0; k < PASSES; k++) {
    await lab.setSeed(seedOf(k));
    await lab.render();
    if (k < ONE_PASS_SEEDS) onePass.push(await lab.readFloat('correction', 3));
    await lab.accumulateMoments('correction', 3, k % 2);
  }
  const secondsPerPass = (Date.now() - started) / 1000 / PASSES;
  const { slots } = await lab.takeMoments('correction', 2);
  const moments = momentsOf(slots);
  moments.mean.forEach((v, i) => { if (!Number.isFinite(v)) throw new Error(`${tag}: non-finite mean at ${i}`); });
  writeFloats(path.join(outDir, `${tag}-mean.f32`), moments.mean);
  writeFloats(path.join(outDir, `${tag}-variance.f32`), moments.variance);
  writeFloats(path.join(outDir, `${tag}-half-difference.f32`), moments.halfDifference);
  for (const [k, values] of onePass.entries()) writeFloats(path.join(outDir, `${tag}-onepass-seed${k}.f32`), values);
  return { ...moments, onePass, secondsPerPass };
}

// captureScale が保存した解像度 tag の値を読み戻す。保存が無ければ null。
function loadScale(outDir, tag) {
  const file = (name) => path.join(outDir, `${tag}-${name}.f32`);
  if (!existsSync(file('mean')) || !existsSync(path.join(outDir, 'capture.json'))) return null;
  return {
    mean: readFloats(file('mean')), variance: readFloats(file('variance')), halfDifference: readFloats(file('half-difference')),
    onePass: Array.from({ length: ONE_PASS_SEEDS }, (_, k) => readFloats(file(`onepass-seed${k}`))),
    secondsPerPass: JSON.parse(readFileSync(path.join(outDir, 'capture.json'), 'utf8')).secondsPerPass[tag],
  };
}

// ---- 画像 ----

const codeOf = (v) => Math.round(255 * Math.min(1, Math.max(0, v)));
const linearToSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

// 画素ごとの 3 成分 values を、成分ごとに gain 倍して符号つきの補正の表示にした PNG(撮影の中で同じ尺度)。
async function signedPng(lab, values, gain) {
  const rgba = new Float32Array(4 * PIXELS);
  for (let p = 0; p < PIXELS; p++) {
    for (let c = 0; c < 3; c++) rgba[4 * p + c] = gain * values[3 * p + c];
    rgba[4 * p + 3] = 1;
  }
  return lab.signedCorrectionPng({ width: WIDTH, height: HEIGHT, rgba });
}

// 画素ごとの 1 値 values(0 が黒、scale が白)の PNG。sRGB の符号化で暗い所を見せる。
const grayPng = (values, scale) => encodeRgbPng(WIDTH, HEIGHT, Uint8Array.from(
  { length: 3 * PIXELS }, (_, i) => codeOf(linearToSrgb(values[Math.floor(i / 3)] / scale))));

// 画素ごとの 3 成分 values の、0.5 + k·v(土台の画像を足さない)の PNG。
const offsetPng = (values, k) => encodeRgbPng(WIDTH, HEIGHT, Uint8Array.from({ length: 3 * PIXELS }, (_, i) => codeOf(0.5 + k * values[i])));

// ---- 本体 ----

const options = Object.fromEntries(process.argv.slice(2).flatMap((a, i, all) => (a.startsWith('--') ? [[a.slice(2), all[i + 1]]] : [])));
const referenceName = options.reference ?? '9-b';
const sceneNames = options.scenes?.split(',') ?? SCENES.map((s) => s.name);
const started = Date.now();
const results = [];
mkdirSync(rootDir, { recursive: true });

// 撮影ごとにページを開き直す — 1 つのページで続けると、画像を作る段が途中で応答しなくなる。
for (const name of sceneNames) {
  const scene = SCENES.find((s) => s.name === name);
  if (scene === undefined) throw new Error(`no scene ${name} in SCENES`);
  const [entry] = selectedEntries({ entries: scene.shot });
  if (entry.key !== scene.shot || entry.caseName !== scene.caseName) throw new Error(`the ${name} entry does not match SCENES`);
  results.push(await withLab((lab) => sceneResult(lab, scene, entry)));
}
writeCombined(results);
console.log(`所要 ${((Date.now() - started) / 1000).toFixed(0)} s -> ${rootDir}`);

// 撮影 scene の撮影(保存が無い解像度だけ)と、統計・画像。lab は withLab の口。
async function sceneResult(lab, scene, entry) {
  const outDir = path.join(rootDir, scene.name);
  mkdirSync(outDir, { recursive: true });
  const meta = builtMetaOf(referenceName, entry);
  const [evenSum, oddSum] = referenceSumsOf(referenceName, entry, 'correction');
  const bHalf = meta.passes / 2;
  const bMean = evenSum.map((v, i) => (v + oddSum[i]) / meta.passes);
  const bHalfDifference = evenSum.map((v, i) => v / bHalf - oddSum[i] / bHalf);
  const radius = readFloats(referenceFileOf(referenceName, entry, 'radius.f32'));
  // 全解像度で補正を受ける(最も粗い 1/8 の走査でフェードの外にある)画素。
  const commonMask = maskOf(radius, SCALES[0].scale);
  const component = Uint8Array.from({ length: 3 * PIXELS }, (_, i) => commonMask[Math.floor(i / 3)]);
  const exposures = new Set([meta.exposure]);
  const captured = {};
  for (const s of SCALES) {
    captured[s.tag] = loadScale(outDir, s.tag) ?? await captureScale(lab, entry, s, outDir, (e) => exposures.add(e));
    console.log(`${scene.name} ${s.label}: ${captured[s.tag].secondsPerPass.toFixed(2)} s/pass`);
  }
  if ([...exposures].some((e) => Math.abs(e - meta.exposure) > 1e-9)) throw new Error(`${scene.name}: exposure differs: ${[...exposures]}, B ${meta.exposure}`);
  writeFileSync(path.join(outDir, 'capture.json'), JSON.stringify({
    secondsPerPass: Object.fromEntries(SCALES.map((s) => [s.tag, captured[s.tag].secondsPerPass])), exposure: meta.exposure }));
  const toQ = meta.exposure / Math.PI;
  const stats = {};
  for (const s of SCALES) {
    const c = captured[s.tag];
    const ownMask = maskOf(radius, s.scale);
    const sd = c.variance.map((v) => Math.sqrt(v) * toQ);
    stats[s.tag] = {
      ...s,
      scanWidth: Math.ceil(WIDTH * s.scale),
      floorRadius: s.scale === 1 ? null : FLOOR_SCAN_PX * WIDTH / Math.ceil(WIDTH * s.scale),
      secondsPerPass: c.secondsPerPass,
      varianceMean: meanOfList(maskedValues(c.variance, commonMask)) * toQ ** 2,
      varianceMeanOwnMask: meanOfList(maskedValues(c.variance, ownMask)) * toQ ** 2,
      sdP99: percentileOf(maskedValues(sd, commonMask), 0.99),
      noiseRms: rmsOf(c.halfDifference, commonMask) * toQ / 2,
      meanRms: rmsOf(c.mean, commonMask) * toQ,
      meanVsB: rmsOf(difference(c.mean, bMean), commonMask) * toQ,
    };
  }
  const bNoise = rmsOf(bHalfDifference, commonMask) * toQ / 2;
  for (const s of SCALES) {
    const st = stats[s.tag];
    st.varianceRatio = st.varianceMean / stats[BASE].varianceMean;
    st.noiseOverMean = st.noiseRms / st.meanRms;
    st.partner = PARTNER[s.tag];
    st.partnerDifference = rmsOf(difference(captured[s.tag].mean, captured[st.partner].mean), commonMask) * toQ;
    st.pairNoiseOverDifference = Math.hypot(st.noiseRms, stats[st.partner].noiseRms) / st.partnerDifference;
    if (!(st.meanRms > 0) || !Number.isFinite(st.varianceMean)) throw new Error(`${scene.name} ${s.label}: empty or non-finite correction`);
  }
  // 画像の尺度: 標準偏差は全解像度の p99 の最大を白に、半分の差は全解像度と B の |偶 − 奇| の 99.9 百分位で飽和しない 2 の冪 k。
  const sdWhite = Math.max(...SCALES.map((s) => stats[s.tag].sdP99));
  const halfAbsolutes = [bHalfDifference, ...SCALES.map((s) => captured[s.tag].halfDifference)]
    .flatMap((values) => maskedValues(values.map(Math.abs), component));
  const halfP999 = percentileOf(halfAbsolutes, 0.999) * toQ;
  const halfK = 2 ** Math.floor(Math.log2(0.5 / halfP999));
  const put = (file, png) => writeFileSync(path.join(outDir, file), png);
  for (const s of SCALES) {
    const c = captured[s.tag];
    const sd = c.variance.map((v) => Math.sqrt(v) * toQ);
    for (const g of GAINS) {
      put(`${s.tag}-mean-x${g}.png`, await signedPng(lab, c.mean, g));
      for (const [k, values] of c.onePass.entries()) put(`${s.tag}-seed${k}-x${g}.png`, await signedPng(lab, values, g));
      put(`${s.tag}-sd-x${g}.png`, grayPng(sd, sdWhite / g));
      put(`${s.tag}-half-x${g}.png`, offsetPng(c.halfDifference.map((v) => v * toQ), halfK * g));
    }
  }
  for (const g of GAINS) {
    put(`B-mean-x${g}.png`, await signedPng(lab, bMean, g));
    put(`B-half-x${g}.png`, offsetPng(bHalfDifference.map((v) => v * toQ), halfK * g));
  }
  return { scene, stats, bNoise, meta, sdWhite, halfK, halfP999 };
}

// ---- 表とページ ----

function scaleTables({ scene, stats, bNoise, meta, sdWhite, halfK, halfP999 }) {
  const rows = SCALES.map((s) => {
    const st = stats[s.tag];
    return [s.label, fixed(st.varianceMean, 8), fixed(st.varianceRatio, 2), fixed(st.varianceMeanOwnMask, 8), fixed(st.sdP99, 5), fixed(st.secondsPerPass, 2)];
  });
  const convergence = SCALES.map((s) => {
    const st = stats[s.tag];
    return [s.label, fixed(st.noiseRms, 6), fixed(st.meanRms, 5), fixed(st.noiseOverMean, 3), fixed(st.partnerDifference, 6),
      stats[st.partner].label, fixed(st.pairNoiseOverDifference, 3), fixed(st.meanVsB, 6)];
  });
  return [
    `## ${scene.name}`, '',
    `B = ${referenceName}(${meta.passes} パス)の残りの雑音 RMS(偶奇の半分の差 / 2): ${fixed(bNoise, 6)}(q)。統計は全解像度で補正を受ける画素(近傍の半径 > ${2 / SCALES[0].scale} 画素)での q = 露出係数·ΔE/π。`, '',
    ...table(['解像度', '分散の画面平均 [q²]', '1/4 に対する倍率', '(各解像度の自分のマスク)', '標準偏差の p99 [q]', '1 パスの所要 [s]'], rows), '',
    ...table(['解像度', '残りの雑音 RMS(偶奇 / 2)', '平均の補正の RMS', '雑音 / 平均', '相手との平均の差 RMS', '相手', '差の雑音 / 差', '平均 − B の RMS'], convergence), '',
    `半分の差の画像の k = ${halfK}(全解像度と B の |偶 − 奇| の 99.9 百分位 q ${fixed(halfP999, 5)} で飽和しない 2 の冪)。標準偏差の白 = q ${fixed(sdWhite, 5)}。`, '',
  ];
}

function writeCombined(all) {
  const text = [`# 走査の解像度(${PASSES} パス、commit ${headHash()})`, '', ...all.flatMap(scaleTables)].join('\n');
  writeFileSync(path.join(rootDir, 'summary.md'), text);
  writeFileSync(path.join(rootDir, 'summary.json'), JSON.stringify({
    commit: headHash(), reference: referenceName, passes: PASSES,
    scenes: Object.fromEntries(all.map(({ scene, ...rest }) => [scene.name, rest])) }, null, 1));
  const scaleButtons = [...SCALES.map((s) => [s.tag, s.label]), ['B', 'B']];
  const kinds = [['mean', '平均'], ...Array.from({ length: ONE_PASS_SEEDS }, (_, k) => [`seed${k}`, `1 パス seed${k}`]), ['sd', '標準偏差'], ['half', '半分の差']];
  const sceneButtons = all.map(({ scene }) => [scene.name, scene.name]);
  const floors = SCALES.map((s) => `${s.label}: ${s.scale === 1 ? '最後の拡大なし' : fixed(FLOOR_SCAN_PX * WIDTH / Math.ceil(WIDTH * s.scale), 2)}`).join(' / ');
  const fixedRows = [
    ['commit', headHash()], ['方式', '遮蔽と照り返し'], ['スライス × 歩数', '4 × 片側 5'], ['帯の数 / κ', `4 / ${BAND_SCALE}`],
    ['パス数', `${PASSES}(seed = seedOf(0..${PASSES - 1}))、1 パスは seedOf(0..${ONE_PASS_SEEDS - 1})`],
    ['r_floor [描画画素]', floors], ['B', `${referenceName}(全解像度・均しなし、${all[0].meta.passes} パス)`],
    ['尺度', '補正は符号つき表示で撮影の中の全解像度と B に共通(×4 は ΔE を 4 倍)。標準偏差は白 = 撮影ごとの p99 の最大(sRGB 符号化)。半分の差は 0.5 + k·(偶 − 奇) q'],
    ...all.map(({ scene, sdWhite, halfK }) => [scene.name, `標準偏差の白 q ${fixed(sdWhite, 4)}、半分の差の k ${halfK}(×4 は ${4 * halfK})`]),
  ];
  const html = `<!doctype html><meta charset="utf-8"><title>scan scale</title>
<style>body{font:14px sans-serif;margin:8px;background:#222;color:#ddd}td{padding:1px 8px}button{margin:2px}.on{background:#68a;color:#fff}img{display:block;margin-top:8px}</style>
<table>${fixedRows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>
<div id="scene"></div><div id="scale"></div><div id="kind"></div><div id="gain"></div><img id="view" width="${WIDTH}" height="${HEIGHT}">
<script>
const scenes = ${JSON.stringify(sceneButtons)}, scales = ${JSON.stringify(scaleButtons)}, kinds = ${JSON.stringify(kinds)}, gains = ${JSON.stringify(GAINS)};
const state = { scene: 0, scale: 1, kind: 0, gain: 0 };
const options = { scene: scenes, scale: scales, kind: kinds, gain: gains.map((g) => [g, '×' + g]) };
function show() {
  const [scene] = scenes[state.scene], [scale] = scales[state.scale], [kind] = kinds[state.kind], gain = gains[state.gain];
  const usable = scale !== 'B' || kind === 'mean' || kind === 'half';
  document.getElementById('view').src = usable ? scene + '/' + scale + '-' + kind + '-x' + gain + '.png' : '';
  for (const key of Object.keys(options)) for (const [i, b] of [...document.getElementById(key).children].entries()) b.className = i === state[key] ? 'on' : '';
}
for (const key of Object.keys(options)) {
  const box = document.getElementById(key);
  for (const [i, [, label]] of options[key].entries()) {
    const b = document.createElement('button'); b.textContent = label; b.onclick = () => { state[key] = i; show(); }; box.append(b);
  }
}
addEventListener('keydown', (e) => {
  const step = (key, d) => { state[key] = (state[key] + d + options[key].length) % options[key].length; show(); };
  if (e.key === 'ArrowLeft') step('scale', -1); else if (e.key === 'ArrowRight') step('scale', 1);
  else if (e.key === 'ArrowUp') step('kind', -1); else if (e.key === 'ArrowDown') step('kind', 1);
  else if (e.key === 'g') step('gain', 1); else if (e.key === 's') step('scene', 1); else return;
  e.preventDefault();
});
show();
</script>`;
  writeFileSync(path.join(rootDir, 'index.html'), html);
}
