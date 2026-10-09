// 近傍拡散補正の盲検の刺激を、描画テスト環境のページの中で組む口。刺激 1 つは同じ方式・同じスライス数とパス数の独立な
// GROUP_COUNT 組の完成補正で、組の統計(組 0・組 1・平均・平均からの偏差・分散)をページの window.__ssdBlind.result に
// 積み、表示の PNG(data URL)にして受け取る。補正はどれも描画バッファの寸法の、画素ごとに rgb の Float32Array。
import { HEIGHT, seedOf, WIDTH } from './screen-space-lab.mjs';

// 刺激 1 つの組の数。組 g のパス p は seed の番号 g × SEEDS_PER_GROUP + p で描く(パス数は SEEDS_PER_GROUP まで)。
const GROUP_COUNT = 32;
const SEEDS_PER_GROUP = 4;
// 補正項の表示の写し方。gpu は描画テスト環境の符号つきの補正の合成(signedCorrectionPng)、cpu は同じ写像の CPU の写し
// (signedCorrectionDisplay)を与えた露出係数で掛けたもの。
export const CORRECTION_DISPLAY = { gpu: 'signed-correction-debug-gpu-v1', cpu: 'signed-correction-cpu-v1' };
// 偏差(成分ごとの符号つき)と分散(成分の平均)の表示が飽和する値。
const DEVIATION_FULL_SCALE = 0.1;
const VARIANCE_FULL_SCALE = 0.01;

// 露出係数が続く 2 フレームで変わらなくなるまで描く。{ frames, factor } を返し、8 フレームで落ち着かなければ投げる。
export async function stabilizeExposure(devTools) {
  const values = await devTools.evaluate(`(async()=>{
    const values=[];
    for(let frame=0;frame<8;frame++){
      window.renderLab.render();values.push(window.renderLab.exposureFactor());
      if(values.length>=2){const a=values.at(-2),b=values.at(-1);if(Math.abs(a-b)<=Math.max(1,Math.abs(a),Math.abs(b))*1e-7)return values;}
      await new Promise(requestAnimationFrame);
    }
    return values;
  })()`);
  const previous = values.at(-2), current = values.at(-1);
  if (previous === undefined || current === undefined
    || Math.abs(previous - current) > Math.max(1, Math.abs(previous), Math.abs(current)) * 1e-7) {
    throw new Error(`exposure did not stabilize: ${JSON.stringify(values)}`);
  }
  return { frames: values, factor: current };
}

// 統計の器 window.__ssdBlind を空で作る。
export async function initStats(devTools) {
  await devTools.evaluate(`(() => { window.__ssdBlind = (() => {
    const n = ${WIDTH * HEIGHT * 3};
    return { width: ${WIDTH}, height: ${HEIGHT}, sum: new Float32Array(n), squareSum: new Float32Array(n),
      groupCount: 0, first: null, second: null };
  })(); })()`);
}

// seeds の順にパスを描いた完成補正を描画先 'correction' へ置く。1 本ならふつうの 1 フレーム、2 本以上ならその平均。
async function renderCompletedPaths(devTools, seeds) {
  await devTools.evaluate('window.renderLab.setScanWhiteNoisePass(null)');
  if (seeds.length === 1) {
    const [x, y] = seeds[0];
    await devTools.evaluate(`window.renderLab.setScanSeed(${x}, ${y}); window.renderLab.render()`);
  } else {
    const result = await devTools.evaluate(
      `window.renderLab.measureScreenSpacePaths(${JSON.stringify(seeds)}, 1)`,
    );
    if (!result.gpuSupported) throw new Error('GPU timestamp queries unavailable during completed-path capture');
  }
}

// 描画先 'correction' の完成補正を組 group として器へ積む。組 0・1 は写しを控える。
async function accumulateGroup(devTools, group) {
  await devTools.evaluate(`window.renderLab.readFloat('correction').then(({ rgba }) => {
    const s = window.__ssdBlind, n = s.sum.length, out = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i += 3, j += 4) {
      for (let c = 0; c < 3; c++) {
        const v = rgba[j + c]; out[i + c] = v; s.sum[i + c] += v; s.squareSum[i + c] += v * v;
      }
    }
    if (${group} === 0) s.first = out;
    if (${group} === 1) s.second = out;
    s.groupCount++;
  })`);
}

// 積んだ組から統計 result = { first, second, mean, deviation0, deviation1, variance } を作り、和を捨てる。
async function finalizeStats(devTools) {
  await devTools.evaluate(`(() => {
    const s = window.__ssdBlind, n = s.sum.length, mean = new Float32Array(n), variance = new Float32Array(n);
    const deviation0 = new Float32Array(n), deviation1 = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const m = s.sum[i] / s.groupCount;
      mean[i] = m;
      variance[i] = Math.max(0, s.squareSum[i] / s.groupCount - m * m);
      deviation0[i] = s.first[i] - m;
      deviation1[i] = s.second[i] - m;
    }
    s.result = { mean, variance, deviation0, deviation1, first: s.first, second: s.second };
    s.sum = null; s.squareSum = null;
  })()`);
}

// いまの方式と段で、パス数 pathCount の完成補正を GROUP_COUNT 組描いて統計を作る。label は進みの表示に添える名前。
export async function captureGroups(devTools, pathCount, label) {
  if (pathCount > SEEDS_PER_GROUP) throw new Error(`at most ${SEEDS_PER_GROUP} paths per group`);
  await initStats(devTools);
  for (let group = 0; group < GROUP_COUNT; group++) {
    if (group % 8 === 0) console.log(`${label}: group ${group}/${GROUP_COUNT}`);
    const seeds = Array.from({ length: pathCount }, (_, p) => seedOf(group * SEEDS_PER_GROUP + p));
    await renderCompletedPaths(devTools, seeds);
    await accumulateGroup(devTools, group);
  }
  await finalizeStats(devTools);
}

// ページの式 source が指す補正を、表示 transform(CORRECTION_DISPLAY の値)で PNG の data URL にする。exposureFactor は
// cpu の表示が掛ける露出係数。
export async function correctionPng(devTools, source, transform, exposureFactor) {
  return devTools.evaluate(`(async () => {
    const src = ${source}, rgba = new Float32Array(${WIDTH * HEIGHT * 4});
    for (let p = 0, i = 0; p < src.length; p += 3, i += 4) {
      rgba[i] = src[p]; rgba[i + 1] = src[p + 1]; rgba[i + 2] = src[p + 2]; rgba[i + 3] = 1;
    }
    if (${JSON.stringify(transform)} !== ${JSON.stringify(CORRECTION_DISPLAY.cpu)}) {
      return window.renderLab.signedCorrectionPng({ width: ${WIDTH}, height: ${HEIGHT}, rgba });
    }
    const display = window.renderLab.signedCorrectionDisplay({ width: ${WIDTH}, height: ${HEIGHT}, rgba }, ${exposureFactor});
    const canvas = document.createElement('canvas');
    canvas.width = ${WIDTH}; canvas.height = ${HEIGHT};
    const ctx = canvas.getContext('2d', { alpha: false });
    const image = ctx.createImageData(${WIDTH}, ${HEIGHT});
    for (let i = 0; i < display.rgba.length; i++) image.data[i] = Math.max(0, Math.min(255, Math.round(display.rgba[i] * 255)));
    ctx.putImageData(image, 0, 0);
    return canvas.toDataURL('image/png');
  })()`);
}

// 統計の偏差(view は 'deviation0' か 'deviation1'。成分ごとに ±DEVIATION_FULL_SCALE で飽和する 50% 中心の色)か分散
// ('variance'。成分の平均が VARIANCE_FULL_SCALE で飽和する灰色)を PNG にする。{ dataUrl, saturatedFraction } を返し、
// saturatedFraction は飽和した(偏差はどれかの成分が)画素の割合。
export async function spreadPng(devTools, view) {
  return devTools.evaluate(`(() => {
    const s = window.__ssdBlind.result, canvas = document.createElement('canvas');
    canvas.width = ${WIDTH}; canvas.height = ${HEIGHT};
    const ctx = canvas.getContext('2d', { alpha: false });
    const image = ctx.createImageData(${WIDTH}, ${HEIGHT});
    const putByte = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
    let saturated = 0;
    if (${JSON.stringify(view)} === 'variance') {
      const src = s.variance;
      for (let p = 0, i = 0; p < src.length; p += 3, i += 4) {
        const ratio = (src[p] + src[p + 1] + src[p + 2]) / 3 / ${VARIANCE_FULL_SCALE};
        if (ratio > 1) saturated++;
        const value = putByte(Math.min(1, ratio));
        image.data[i] = value; image.data[i + 1] = value; image.data[i + 2] = value; image.data[i + 3] = 255;
      }
    } else {
      const src = s[${JSON.stringify(view)}];
      for (let p = 0, i = 0; p < src.length; p += 3, i += 4) {
        let clipped = false;
        for (let c = 0; c < 3; c++) {
          const ratio = src[p + c] / ${DEVIATION_FULL_SCALE};
          if (Math.abs(ratio) > 1) clipped = true;
          image.data[i + c] = putByte(0.5 + 0.5 * Math.max(-1, Math.min(1, ratio)));
        }
        if (clipped) saturated++;
        image.data[i + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    return { dataUrl: canvas.toDataURL('image/png'), saturatedFraction: saturated / ${WIDTH * HEIGHT} };
  })()`);
}
