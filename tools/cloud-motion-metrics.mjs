// 雲の動きを尺度と速さと入れ替わりで測る純粋関数。場は { width, height, data }(Float32Array、
// 行は北から南へ並ぶ)、時刻は hours [h] で、frames は { hours, field } の配列。欠けた時刻は
// 配列に含めない。kmPerPx は画素の一辺 [km]。
import { fft2 } from './cloud-detail-metrics.mjs';

const DEFAULT_SCALES_KM = [150, 300, 600, 1200];
const DEFAULT_DECORRELATION_LAGS_H = [1, 2, 4, 8, 12, 24];
const KM_PER_DEG = 111.32;
// 向きを読むには遅すぎる速さ [m/s]。これ未満のブロックは向きの統計から外す。
export const DIRECTION_MIN_SPEED_MS = 3;

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
}

function mean(values) {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function stdDev(values) {
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

function wrapDeg(deg) {
  return ((deg + 540) % 360) - 180;
}

// 方向の円周標準偏差 [°]。方向がばらけて平均の長さ R が 0 になれば無限大。
function circularStdDeg(dirsDeg) {
  if (dirsDeg.length === 0) return null;
  const c = mean(dirsDeg.map((d) => Math.cos((d * Math.PI) / 180)));
  const s = mean(dirsDeg.map((d) => Math.sin((d * Math.PI) / 180)));
  const r = Math.hypot(c, s);
  return (Math.sqrt(-2 * Math.log(Math.min(r, 1))) * 180) / Math.PI;
}

function pearson(a, b) {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  return cov / Math.sqrt(va * vb);
}

// 相関が 1/e を初めて切る時刻を、lag 間の線形補間で返す。切らなければ null。
function decorrelationTime(lags, corrs) {
  const threshold = 1 / Math.E;
  for (let i = 1; i < lags.length; i++) {
    const a = corrs[i - 1];
    const b = corrs[i];
    if (a === null || b === null) return null;
    if (b < threshold) return lags[i - 1] + ((a - threshold) / (a - b)) * (lags[i] - lags[i - 1]);
  }
  return null;
}

// 3 回の箱フィルタでガウスを近似する箱の幅(奇数)。
function boxWidthsForGauss(sigma, passes = 3) {
  const ideal = Math.sqrt((12 * sigma * sigma) / passes + 1);
  let lower = Math.floor(ideal);
  if (lower % 2 === 0) lower--;
  const upper = lower + 2;
  const m = Math.round(
    (12 * sigma * sigma - passes * lower * lower - 4 * passes * lower - 3 * passes) / (-4 * lower - 4),
  );
  return Array.from({ length: passes }, (_, i) => (i < m ? lower : upper));
}

// 一方向の箱フィルタ。端は端の値で延ばし、和を入れ替えて走らせる。
function boxPass(src, width, height, radius, horizontal) {
  const dst = new Float64Array(width * height);
  const lineLength = horizontal ? width : height;
  const lineCount = horizontal ? height : width;
  const norm = 1 / (2 * radius + 1);
  const clamp = (i) => Math.min(lineLength - 1, Math.max(0, i));
  const at = (line, i) => (horizontal ? line * width + i : i * width + line);
  for (let line = 0; line < lineCount; line++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += src[at(line, clamp(k))];
    for (let i = 0; i < lineLength; i++) {
      dst[at(line, i)] = sum * norm;
      sum += src[at(line, clamp(i + radius + 1))] - src[at(line, clamp(i - radius))];
    }
  }
  return dst;
}

function gaussianBlur(data, width, height, sigmaPx) {
  let out = Float64Array.from(data);
  for (const size of boxWidthsForGauss(sigmaPx)) {
    const radius = (size - 1) / 2;
    out = boxPass(out, width, height, radius, true);
    out = boxPass(out, width, height, radius, false);
  }
  return out;
}

// 尺度 L の帯域通過(σ = L/4 と L/2 のガウスの差)。
function bandPass({ width, height, data }, kmPerPx, scaleKm) {
  const narrow = gaussianBlur(data, width, height, scaleKm / 4 / kmPerPx);
  const wide = gaussianBlur(data, width, height, scaleKm / 2 / kmPerPx);
  for (let i = 0; i < narrow.length; i++) narrow[i] -= wide[i];
  return narrow;
}

function indexByHours(frames) {
  return new Map(frames.map((f) => [f.hours, f]));
}

// 各尺度の帯域通過アノマリ(時間平均を引いた場)の、時刻 lag ごとの空間相関と 1/e 時間。
export function scaleDecorrelation(
  frames,
  kmPerPx,
  scalesKm = DEFAULT_SCALES_KM,
  lagsH = DEFAULT_DECORRELATION_LAGS_H,
) {
  const { width, height } = frames[0].field;
  const pixels = width * height;
  const correlations = scalesKm.map((scaleKm) => {
    const bands = frames.map((f) => ({ hours: f.hours, data: bandPass(f.field, kmPerPx, scaleKm) }));
    const timeMean = new Float64Array(pixels);
    for (const band of bands) for (let i = 0; i < pixels; i++) timeMean[i] += band.data[i] / bands.length;
    for (const band of bands) for (let i = 0; i < pixels; i++) band.data[i] -= timeMean[i];
    const byHours = indexByHours(bands);
    return lagsH.map((lag) => {
      const values = [];
      for (const band of bands) {
        const later = byHours.get(band.hours + lag);
        if (later) values.push(pearson(band.data, later.data));
      }
      return values.length === 0 ? null : mean(values);
    });
  });
  const tauHours = correlations.map((row) => decorrelationTime([0, ...lagsH], [1, ...row]));
  return { scalesKm, lagsH, correlations, tauHours };
}

// 時刻 t と t + lagH の組を、t が lagH の倍数のものだけ(組が重ならない)返す。
function nonOverlappingPairs(frames, lagH) {
  const byHours = indexByHours(frames);
  const pairs = [];
  for (const frame of frames) {
    if (frame.hours % lagH !== 0) continue;
    const later = byHours.get(frame.hours + lagH);
    if (later) pairs.push([frame, later]);
  }
  return pairs;
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

// 正規化相互相関の分子の全ずらし(FFT)。template は zero-mean 化して渡す。search の窓 (ox, oy)
// と template の内積を、ox, oy ∈ [0, S − b] について行優先で返す。
function nccSurface(template, b, search, S) {
  const n = nextPow2(S);
  const tRe = new Float64Array(n * n);
  const tIm = new Float64Array(n * n);
  const sRe = new Float64Array(n * n);
  const sIm = new Float64Array(n * n);
  for (let y = 0; y < b; y++) for (let x = 0; x < b; x++) tRe[y * n + x] = template[y * b + x];
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) sRe[y * n + x] = search[y * S + x];
  fft2(tRe, tIm, n, false);
  fft2(sRe, sIm, n, false);
  for (let k = 0; k < n * n; k++) {
    const re = sRe[k] * tRe[k] + sIm[k] * tIm[k];
    const im = sIm[k] * tRe[k] - sRe[k] * tIm[k];
    sRe[k] = re;
    sIm[k] = im;
  }
  fft2(sRe, sIm, n, true);
  const span = S - b + 1;
  const out = new Float64Array(span * span);
  for (let oy = 0; oy < span; oy++) for (let ox = 0; ox < span; ox++) out[oy * span + ox] = sRe[oy * n + ox];
  return out;
}

// 整数の最大位置の周りの放物線から亜画素のずれ [画素]。端では補間しない。
function parabolicOffset(left, center, right) {
  const denom = left - 2 * center + right;
  if (denom >= 0) return 0;
  return Math.max(-0.5, Math.min(0.5, (0.5 * (left - right)) / denom));
}

// 1 組の時刻の場のブロックごとの動き。ブロックは重ならない blockKm 四方、探索半径は
// maxSpeedMs × lagH。centerLatDeg を与えると東西の画素の距離を中心緯度で補正する。
export function blockMotion(
  frames,
  kmPerPx,
  { blockKm = 500, lagH = 3, maxSpeedMs = 80, minPeak = 0.4, centerLatDeg = null } = {},
) {
  const { width, height } = frames[0].field;
  const b = Math.round(blockKm / kmPerPx);
  const R = Math.ceil((maxSpeedMs * lagH * 3600) / 1000 / kmPerPx);
  const S = b + 2 * R;
  const blocks = [];
  for (const [a, later] of nonOverlappingPairs(frames, lagH)) {
    for (let by = 0; by + b <= height; by += b) {
      for (let bx = 0; bx + b <= width; bx += b) {
        const template = new Float64Array(b * b);
        let tMean = 0;
        for (let y = 0; y < b; y++) {
          for (let x = 0; x < b; x++) {
            const v = a.field.data[(by + y) * width + bx + x];
            template[y * b + x] = v;
            tMean += v;
          }
        }
        tMean /= b * b;
        let tNorm = 0;
        for (let i = 0; i < template.length; i++) {
          template[i] -= tMean;
          tNorm += template[i] * template[i];
        }
        tNorm = Math.sqrt(tNorm);
        if (tNorm < 1e-9) continue;
        const search = new Float64Array(S * S);
        for (let y = 0; y < S; y++) {
          const sy = by - R + y;
          if (sy < 0 || sy >= height) continue;
          for (let x = 0; x < S; x++) {
            const sx = bx - R + x;
            if (sx >= 0 && sx < width) search[y * S + x] = later.field.data[sy * width + sx];
          }
        }
        const surface = nccSurface(template, b, search, S);
        const integral = new Float64Array((S + 1) * (S + 1));
        const integral2 = new Float64Array((S + 1) * (S + 1));
        for (let y = 0; y < S; y++) {
          for (let x = 0; x < S; x++) {
            const v = search[y * S + x];
            const i = (y + 1) * (S + 1) + x + 1;
            integral[i] = v + integral[i - 1] + integral[i - (S + 1)] - integral[i - (S + 1) - 1];
            integral2[i] = v * v + integral2[i - 1] + integral2[i - (S + 1)] - integral2[i - (S + 1) - 1];
          }
        }
        const boxSum = (table, ox, oy) => {
          const x1 = ox + b;
          const y1 = oy + b;
          return table[y1 * (S + 1) + x1] - table[oy * (S + 1) + x1] - table[y1 * (S + 1) + ox] + table[oy * (S + 1) + ox];
        };
        let best = -Infinity;
        let bestX = 0;
        let bestY = 0;
        const span = S - b;
        const ncc = (ox, oy) => {
          const s = boxSum(integral, ox, oy);
          const variance = boxSum(integral2, ox, oy) - (s * s) / (b * b);
          if (variance <= 1e-12) return 0;
          return surface[oy * (span + 1) + ox] / (tNorm * Math.sqrt(variance));
        };
        for (let oy = 0; oy <= span; oy++) {
          for (let ox = 0; ox <= span; ox++) {
            const value = ncc(ox, oy);
            if (value > best) {
              best = value;
              bestX = ox;
              bestY = oy;
            }
          }
        }
        if (best < minPeak) continue;
        const left = bestX > 0 ? ncc(bestX - 1, bestY) : best;
        const right = bestX < span ? ncc(bestX + 1, bestY) : best;
        const up = bestY > 0 ? ncc(bestX, bestY - 1) : best;
        const down = bestY < span ? ncc(bestX, bestY + 1) : best;
        const dx = bestX - R + parabolicOffset(left, best, right);
        const dy = bestY - R + parabolicOffset(up, best, down);
        const rowLat = centerLatDeg === null
          ? 0
          : centerLatDeg + ((height / 2 - (by + b / 2)) * kmPerPx) / KM_PER_DEG;
        const eastKmPerPx = centerLatDeg === null
          ? kmPerPx
          : (kmPerPx * Math.cos((rowLat * Math.PI) / 180)) / Math.cos((centerLatDeg * Math.PI) / 180);
        const seconds = lagH * 3600;
        const u = (dx * eastKmPerPx * 1000) / seconds;
        const v = (-dy * kmPerPx * 1000) / seconds;
        blocks.push({
          startHours: a.hours, lat: rowLat, peak: best,
          u, v, speed: Math.hypot(u, v), dirDeg: (Math.atan2(v, u) * 180) / Math.PI,
        });
      }
    }
  }
  return { blocks, ...summarizeBlocks(blocks) };
}

// ブロックの動きの集計。向きは atan2(v, u) [°] (東が 0、北が 90)。
export function summarizeBlocks(blocks) {
  const speeds = blocks.map((bl) => bl.speed).sort((x, y) => x - y);
  const moving = blocks.filter((bl) => bl.speed >= DIRECTION_MIN_SPEED_MS);
  const meanU = blocks.length === 0 ? null : mean(blocks.map((bl) => bl.u));
  const meanV = blocks.length === 0 ? null : mean(blocks.map((bl) => bl.v));
  const meanDir = meanU === null ? null : (Math.atan2(meanV, meanU) * 180) / Math.PI;
  return {
    blockCount: blocks.length,
    movingBlockCount: moving.length,
    speedMedian: quantile(speeds, 0.5),
    speedP10: quantile(speeds, 0.1),
    speedP90: quantile(speeds, 0.9),
    directionCircularStdDeg: circularStdDeg(moving.map((bl) => bl.dirDeg)),
    meanVector: { u: meanU, v: meanV },
    directionSpreadFromMeanDeg: meanDir === null || moving.length === 0
      ? null
      : stdDev(moving.map((bl) => wrapDeg(bl.dirDeg - meanDir))),
  };
}

// 雲の塊の入れ替わり。上位 (1 − thresholdQuantile) を雲のマスクにし、boxKm 四方の重ならない窓
// ごとに、時刻 t の雲が lag 後に雲でなくなった割合を平均する。ずらしなしの版は同じ位置で比べ、
// ずらしありの版は窓の位置を箱の中で動かして最も重なる位置で比べる(移流で出入りする分を除く)。
// 正の画素が 1 − thresholdQuantile 未満の場では、分位の閾値が 0 に潰れてマスクが場のほぼ全域に
// なるのを防ぐため、正の画素すべてを雲とする。
export function renewalFraction(frames, kmPerPx, { thresholdQuantile = 0.8, boxKm = 600, lagsH = [6, 12, 24] } = {}) {
  const { width, height } = frames[0].field;
  const winPx = Math.round(boxKm / kmPerPx);
  const nX = Math.floor(width / winPx);
  const nY = Math.floor(height / winPx);
  const offX = Math.floor((width - nX * winPx) / 2);
  const offY = Math.floor((height - nY * winPx) / 2);
  const windows = [];
  for (let iy = 0; iy < nY; iy++) for (let ix = 0; ix < nX; ix++) windows.push({ x0: offX + ix * winPx, y0: offY + iy * winPx });
  const n = nextPow2(Math.max(width, height));

  const masks = new Map(frames.map((f) => [f.hours, cloudMask(f.field, thresholdQuantile)]));
  const maskSpectra = new Map();
  const spectrumOf = (hours) => {
    if (!maskSpectra.has(hours)) {
      const re = new Float64Array(n * n);
      const im = new Float64Array(n * n);
      const mask = masks.get(hours);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) re[y * n + x] = mask[y * width + x];
      fft2(re, im, n, false);
      maskSpectra.set(hours, { re, im });
    }
    return maskSpectra.get(hours);
  };
  const windowSpectra = new Map();
  const windowSpectraOf = (hours) => {
    if (!windowSpectra.has(hours)) {
      const mask = masks.get(hours);
      windowSpectra.set(hours, windows.map(({ x0, y0 }) => {
        const re = new Float64Array(n * n);
        const im = new Float64Array(n * n);
        for (let y = 0; y < winPx; y++) for (let x = 0; x < winPx; x++) re[y * n + x] = mask[(y0 + y) * width + x0 + x];
        fft2(re, im, n, false);
        return { re, im };
      }));
    }
    return windowSpectra.get(hours);
  };

  return lagsH.map((lagH) => {
    const noShift = [];
    const bestShift = [];
    for (const frame of frames) {
      const later = frames.find((f) => f.hours === frame.hours + lagH);
      if (!later) continue;
      const maskA = masks.get(frame.hours);
      const maskB = masks.get(later.hours);
      const specA = windowSpectraOf(frame.hours);
      const specB = spectrumOf(later.hours);
      windows.forEach(({ x0, y0 }, wi) => {
        let area = 0;
        let overlap = 0;
        for (let y = 0; y < winPx; y++) {
          for (let x = 0; x < winPx; x++) {
            const i = (y0 + y) * width + x0 + x;
            area += maskA[i];
            overlap += maskA[i] * maskB[i];
          }
        }
        if (area === 0) return;
        noShift.push(1 - overlap / area);
        // 相互相関は FFT 由来で area をごくわずかに越え得るため、割合が 0 を切らないようにする。
        bestShift.push(Math.max(0, 1 - bestOverlap(specA[wi], specB, width, height, winPx, n) / area));
      });
    }
    return {
      lagH,
      renewalNoShift: noShift.length === 0 ? null : mean(noShift),
      renewalBestShift: bestShift.length === 0 ? null : mean(bestShift),
      windowCount: noShift.length,
    };
  });
}

// 窓の雲マスクを、箱の中で窓を動かしたときの最大の重なり。窓の全位置を FFT の相互相関で求める。
// spectrumA は窓だけが非零のスペクトル、spectrumB は箱全体のスペクトル。
function bestOverlap(spectrumA, spectrumB, width, height, winPx, n) {
  const re = new Float64Array(n * n);
  const im = new Float64Array(n * n);
  for (let k = 0; k < n * n; k++) {
    re[k] = spectrumB.re[k] * spectrumA.re[k] + spectrumB.im[k] * spectrumA.im[k];
    im[k] = spectrumB.im[k] * spectrumA.re[k] - spectrumB.re[k] * spectrumA.im[k];
  }
  fft2(re, im, n, true);
  let best = 0;
  for (let py = 0; py <= height - winPx; py++) {
    for (let px = 0; px <= width - winPx; px++) best = Math.max(best, re[py * n + px]);
  }
  return best;
}

// 上位 (1 − q) の正の画素を雲とする 0/1 のマスク。q 分位が 0 のときは正の画素すべて。
function cloudMask(field, q) {
  const sorted = Float64Array.from(field.data).sort();
  const threshold = sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return Uint8Array.from(field.data, (v) => (v >= threshold && v > 0 ? 1 : 0));
}
