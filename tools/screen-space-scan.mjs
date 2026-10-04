// 近傍拡散補正の走査の解像度の画素ごとの量の、測る画素の印、パスの塊ごとの和からの統計、目で見る画像と、帯の撮影が残す
// 1 パスごとの帯の置き場。量は画素ごとに rgb を並べ、行は上から。
import path from 'node:path';
import { encodeRgbPng } from './png.mjs';
import { HEIGHT, maskOf, WIDTH } from './screen-space-lab.mjs';

// seed の列を k mod BLOCKS で分ける塊の数。塊 0・2 が偶数番目、1・3 が奇数番目のパス。
export const BLOCKS = 4;

// 走査(寸法 size)の画素の座標 pixel が読む、G バッファ(寸法 fullSize)の画素の座標
// (src/render/pipeline/screen-space/hemisphere-scan.ts の gbufferTexelOf)。
export const gbufferTexelOf = (pixel, size, fullSize) => Math.floor((2 * pixel + 1) * fullSize / (2 * size));

// 解像度 scale の走査(width × height)の画素ごとの、測る画素の印。走査の画素が読む G バッファの画素での、近傍の半径
// radius(絵の画素ごと)の印 maskOf。
export function scanMaskOf(radius, scale, width, height) {
  const full = maskOf(radius, scale);
  return Uint8Array.from({ length: width * height }, (_, p) => (
    full[gbufferTexelOf(Math.floor(p / width), height, HEIGHT) * WIDTH + gbufferTexelOf(p % width, width, WIDTH)]));
}

// 塊ごとの和と二乗和 slots(塊の番号順の { sum, squareSum }。画素ごとに rgb を並べた Float64Array)の、ΔE から q への
// 係数 scale での画素ごとの統計 { mean, variance, halves, blockVariances }。どれも画素ごとに rgb を並べた Float64Array で、
// mean と variance は全 passes パスの平均と不偏分散、halves は偶数番目と奇数番目のパスの平均の組、blockVariances は塊ごとの
// 不偏分散。
export function statisticsOf(slots, scale, passes) {
  const length = slots[0].sum.length;
  const mean = new Float64Array(length);
  const variance = new Float64Array(length);
  const halves = [new Float64Array(length), new Float64Array(length)];
  const blockVariances = slots.map(() => new Float64Array(length));
  for (let i = 0; i < length; i++) {
    let [sum, squareSum] = [0, 0];
    for (const [b, slot] of slots.entries()) {
      const [blockSum, blockSquareSum] = [scale * slot.sum[i], scale * scale * slot.squareSum[i]];
      blockVariances[b][i] = unbiasedVarianceOf(blockSum, blockSquareSum, passes / BLOCKS);
      halves[b % 2][i] += blockSum / (passes / 2);
      sum += blockSum;
      squareSum += blockSquareSum;
    }
    mean[i] = sum / passes;
    variance[i] = unbiasedVarianceOf(sum, squareSum, passes);
  }
  return { mean, variance, halves, blockVariances };
}

// n 個の値の和 sum と二乗和 squareSum からの不偏分散。
const unbiasedVarianceOf = (sum, squareSum, n) => (squareSum - sum * sum / n) / (n - 1);

// 測る画素の印の外の色(sRGB の符号値)。
const UNMEASURED = [0, 0, 80];

// 解像度 width × height の画素 p ごとの表示の色 colorOf(p)(rgb、[0, 1] へ切る)を、最近傍で絵の寸法へ広げた PNG。
// 印 mask の外は UNMEASURED。
export function scanPngOf(width, height, mask, colorOf) {
  const codes = new Uint8Array(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const p = Math.floor(y * height / HEIGHT) * width + Math.floor(x * width / WIDTH);
      if (!mask[p]) {
        codes.set(UNMEASURED, (y * WIDTH + x) * 3);
        continue;
      }
      const color = colorOf(p);
      for (let c = 0; c < 3; c++) codes[(y * WIDTH + x) * 3 + c] = Math.round(255 * Math.min(1, Math.max(0, color[c])));
    }
  }
  return encodeRgbPng(WIDTH, HEIGHT, codes);
}

// 帯の撮影が残す、撮影 key の候補 label の先頭のパスの、帯を詰めた描画先の texture 枚目の値の置き場(dir の data/)。
// 中身はパスの順に、走査の解像度の画素ごとに RGBA の ΔE を半精度で並べたもの。
export const keptPassesFileOf = (dir, key, label, texture) => path.join(
  dir, 'data', `${key}.${label}.packed${texture}.passes.f16`);
