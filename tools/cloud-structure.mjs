// 場の多尺度の構造テンソル。ある尺度で「どれだけ・どの向きに伸びているか」を画素ごとに測り、
// 領域の集計(局所の伸び・向きの揃い・卓越する筋の向き)と、向きを色にした画像を出す。
// 行方向スペクトルが見られない異方性を、尺度ごとに分けて読むためのもの。
import { encodeRgbPng } from './png.mjs';

// 箱ぼかし 3 回で σ [px] のガウスを近似するときの、1 回の半径 [px]。3 回の分散の和を σ² に
// 合わせたもの。0 に丸まる σ ではぼかさない。
function boxRadiusFor(sigmaPx) {
  return Math.max(0, Math.round((Math.sqrt(1 + 4 * sigmaPx * sigmaPx) - 1) / 2));
}

// 横 1 行を半径 radius の箱で均す。走査は running sum なので半径に依らず 1 画素あたり一定。
// wrap なら経度で巻き、そうでなければ端を伸ばす。
function blurRow(src, dst, row, width, radius, wrap) {
  if (radius <= 0) {
    dst.set(src.subarray(row, row + width), row);
    return;
  }
  const at = wrap
    ? (x) => src[row + ((x % width) + width) % width]
    : (x) => src[row + Math.min(width - 1, Math.max(0, x))];
  let sum = 0;
  for (let x = -radius; x <= radius; x++) sum += at(x);
  const scale = 1 / (radius * 2 + 1);
  for (let x = 0; x < width; x++) {
    dst[row + x] = sum * scale;
    sum += at(x + radius + 1) - at(x - radius);
  }
}

// 縦 1 列を半径 radius の箱で均す。端は伸ばす(緯度は巻かない)。
function blurColumn(src, dst, x, width, height, radius) {
  if (radius <= 0) {
    for (let y = 0; y < height; y++) dst[y * width + x] = src[y * width + x];
    return;
  }
  const at = (y) => src[Math.min(height - 1, Math.max(0, y)) * width + x];
  let sum = 0;
  for (let y = -radius; y <= radius; y++) sum += at(y);
  const scale = 1 / (radius * 2 + 1);
  for (let y = 0; y < height; y++) {
    dst[y * width + x] = sum * scale;
    sum += at(y + radius + 1) - at(y - radius);
  }
}

// data(width × height)を地表で σ [km] のガウスに近い幅で均す。rowKmPerPx は行ごとの横 1 px の
// 地表距離 [km] なので、正距円筒では高緯度ほど広い画素幅で均される。
function blurField(data, width, height, rowKmPerPx, kmPerPxY, wrapX, sigmaKm) {
  const columnRadius = boxRadiusFor(sigmaKm / kmPerPxY);
  const rowRadius = Array.from(rowKmPerPx, (km) => boxRadiusFor(sigmaKm / km));
  let src = Float32Array.from(data);
  let dst = new Float32Array(data.length);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < height; y++) blurRow(src, dst, y * width, width, rowRadius[y], wrapX);
    [src, dst] = [dst, src];
    for (let x = 0; x < width; x++) blurColumn(src, dst, x, width, height, columnRadius);
    [src, dst] = [dst, src];
  }
  return src;
}

// field を尺度 scaleKm [km] で見た構造テンソルの不変量。rowKmPerPx は行ごとの横 1 px の地表距離
// [km]、kmPerPxY は縦 1 px の地表距離 [km]、wrapX は横が経度で巻くかどうか。返す mean と diff は
// 固有値の和・差の半分、angle は勾配の主軸 [rad](東から反時計回り)。
export function structureTensor(field, rowKmPerPx, kmPerPxY, wrapX, scaleKm) {
  const { width, height, data } = field;
  const smoothed = blurField(data, width, height, rowKmPerPx, kmPerPxY, wrapX, scaleKm / 4);
  const xx = new Float32Array(data.length);
  const yy = new Float32Array(data.length);
  const xy = new Float32Array(data.length);
  const wrapAt = (x) => ((x % width) + width) % width;
  for (let y = 0; y < height; y++) {
    const north = Math.max(0, y - 1) * width;
    const south = Math.min(height - 1, y + 1) * width;
    const row = y * width;
    // 緯度に沿った勾配は 1 px が張る地表距離で割る。北を正に取るので、行の増える向きとは逆。
    const eastScale = 1 / (2 * rowKmPerPx[y]);
    const northScale = 1 / (2 * kmPerPxY);
    for (let x = 0; x < width; x++) {
      const right = wrapX ? wrapAt(x + 1) : Math.min(width - 1, x + 1);
      const left = wrapX ? wrapAt(x - 1) : Math.max(0, x - 1);
      const gx = (smoothed[row + right] - smoothed[row + left]) * eastScale;
      const gy = (smoothed[north + x] - smoothed[south + x]) * northScale;
      xx[row + x] = gx * gx;
      yy[row + x] = gy * gy;
      xy[row + x] = gx * gy;
    }
  }
  const bxx = blurField(xx, width, height, rowKmPerPx, kmPerPxY, wrapX, scaleKm / 2);
  const byy = blurField(yy, width, height, rowKmPerPx, kmPerPxY, wrapX, scaleKm / 2);
  const bxy = blurField(xy, width, height, rowKmPerPx, kmPerPxY, wrapX, scaleKm / 2);
  const mean = new Float32Array(data.length);
  const diff = new Float32Array(data.length);
  const angle = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const half = (bxx[i] - byy[i]) / 2;
    mean[i] = (bxx[i] + byy[i]) / 2;
    diff[i] = Math.sqrt(half * half + bxy[i] * bxy[i]);
    angle[i] = Math.atan2(2 * bxy[i], bxx[i] - byy[i]) / 2;
  }
  return { width, height, mean, diff, angle };
}

// 構造テンソルの (x0, y0) 起点 w × h の集計。coherence は局所の伸び 0..1、r は向きの揃い 0..1、
// orientationDeg は卓越する筋の向き [°](東から反時計回り、0..180)。
export function summarizeStructure(structure, x0, y0, w, h) {
  let sumMean = 0;
  let sumDiff = 0;
  let sumCos = 0;
  let sumSin = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = y * structure.width + x;
      sumMean += structure.mean[i];
      sumDiff += structure.diff[i];
      sumCos += structure.diff[i] * Math.cos(2 * structure.angle[i]);
      sumSin += structure.diff[i] * Math.sin(2 * structure.angle[i]);
    }
  }
  // 筋は勾配の主軸と直交するので、集計した主軸を 90° 回す。
  const orientation = (Math.atan2(sumSin, sumCos) / 2) * (180 / Math.PI) + 90;
  return {
    coherence: sumDiff / Math.max(1e-30, sumMean),
    r: Math.hypot(sumCos, sumSin) / Math.max(1e-30, sumDiff),
    orientationDeg: ((orientation % 180) + 180) % 180,
  };
}

// 色相(0..360)・彩度・明度 0..1 を 8bit の RGB へ。
function hsvToRgb(hue, saturation, value) {
  const c = value * saturation;
  const h = (((hue % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x]
    : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  const m = value - c;
  return [r + m, g + m, b + m].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255));
}

// 構造テンソルを 1 枚の RGB PNG に。色相が筋の向き(180° で 1 周)、彩度が局所の伸び、
// 明度が勾配の強さ(98 パーセンタイルで正規化した平方根)。
export function structureToRgbPng(structure) {
  const sorted = Float32Array.from(structure.mean).sort();
  const top = Math.max(1e-30, sorted[Math.floor(sorted.length * 0.98)]);
  const rgb = new Uint8Array(structure.width * structure.height * 3);
  for (let i = 0; i < structure.mean.length; i++) {
    const orientation = (structure.angle[i] * (180 / Math.PI)) + 90;
    const [r, g, b] = hsvToRgb(
      orientation * 2,
      Math.min(1, structure.diff[i] / Math.max(1e-30, structure.mean[i])),
      Math.min(1, Math.sqrt(structure.mean[i] / top)));
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
  }
  return encodeRgbPng(structure.width, structure.height, rgb);
}
