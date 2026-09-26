// 近傍拡散補正の画質の指標と、目視の刺激の合成。誤差は Oklab で測り、画面に見えている粒の大きさ g で説明できる
// 幅と、説明できずにはみ出した分を、区間スコア S = mean_x Σ_s [2k·u_s + (2/α)·max(0, |d_s| − k·u_s − t)]
// (u_s = c_s·g、k = 3、α = 2(1 − Φ(3)))で 1 つに並べる。粒は、候補が独立な標本を持つ一辺 m の画素ごとの白色雑音を
// 全解像度へ双一次で拡大したものとみなし、c_s はその雑音の帯 d_s の標準偏差(拡大の位相ごと)。L・a・b の成分
// ごとに測って和を取る。
// 画像は画素の配列で受け、ファイルもブラウザも触らない。平面は行優先の Float32Array、Oklab の画像は平面 3 枚の組。

// 帯の箱の一辺 [画素]。帯 d_s = ē_s − ē_2s を s ごとに持ち、残りは ē_RESIDUAL_SCALE。
export const BAND_SCALES = [1, 2, 4, 8, 16, 32];
const RESIDUAL_SCALE = 64;
// 粒の大きさを読む窓の一辺と、窓を置く区画の一辺 [画素]。
const GRAIN_WINDOW = 32;
const GRAIN_STRIDE = 8;
// 区間の半幅(粒の標準偏差の倍数)と、その区間の外に出る確率 α = 2(1 − Φ(K))。
const K = 3;
const ALPHA = 0.0026997960632601866;
// 標準正規分布の |z| の中央値。|d| の中央値を標準偏差へ直す。
const MAD_TO_SIGMA = 0.6744897501960817;
// 帯の標準偏差を数値で求める雑音の枚数と種。
const CALIBRATION_FIELDS = 4;
const CALIBRATION_SEED = 0x5eed;

// ---- 雑音と、帯の幅の単位 ----

// 種 seed の一様乱数(mulberry32)。
export function uniformRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

// 種 seed の、標準偏差 sigma の白色ガウス雑音の平面(count 画素)。
export function gaussianNoise(seed, count, sigma = 1) {
  const random = uniformRandom(seed);
  const plane = new Float32Array(count);
  for (let p = 0; p < count; p++) {
    plane[p] = sigma * Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  }
  return plane;
}

// 平面 values(width × height)を、一辺 factor 倍へ双一次で拡大する。画素の中心どうしを合わせ、端は寄せる。
export function bilinearUpscale(values, width, height, factor) {
  const [outWidth, outHeight] = [width * factor, height * factor];
  const out = new Float32Array(outWidth * outHeight);
  const at = (x, y) => values[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))];
  for (let y = 0; y < outHeight; y++) {
    const v = (y + 0.5) / factor - 0.5;
    const y0 = Math.floor(v);
    for (let x = 0; x < outWidth; x++) {
      const u = (x + 0.5) / factor - 0.5;
      const x0 = Math.floor(u);
      const [fx, fy] = [u - x0, v - y0];
      out[y * outWidth + x] = (1 - fx) * (1 - fy) * at(x0, y0) + fx * (1 - fy) * at(x0 + 1, y0)
        + (1 - fx) * fy * at(x0, y0 + 1) + fx * fy * at(x0 + 1, y0 + 1);
    }
  }
  return out;
}

// 画素 (x, y) の、一辺 grainScale の拡大の位相。
const phaseOf = (x, y, grainScale) => (y % grainScale) * grainScale + (x % grainScale);

// 寸法 width × height の画像で、一辺 grainScale の画素ごとに独立な単位分散の白色雑音を双一次で拡大したときの、
// 帯と残り(BAND_SCALES の順と残り)の、拡大の位相ごとの標準偏差。一度求めた寸法と大きさの組は覚えておく。
const bandStdTables = new Map();
function bandStdsOf(grainScale, width, height) {
  const key = `${grainScale}:${width}x${height}`;
  const known = bandStdTables.get(key);
  if (known !== undefined) return known;
  const [coarseWidth, coarseHeight] = [Math.ceil(width / grainScale), Math.ceil(height / grainScale)];
  const upscaledWidth = coarseWidth * grainScale;
  const mask = new Uint8Array(width * height).fill(1);
  const phases = grainScale * grainScale;
  const squares = Array.from({ length: BAND_SCALES.length + 1 }, () => new Float64Array(phases));
  const counts = new Float64Array(phases);
  for (let field = 0; field < CALIBRATION_FIELDS; field++) {
    const coarse = gaussianNoise(CALIBRATION_SEED + field, coarseWidth * coarseHeight);
    const upscaled = bilinearUpscale(coarse, coarseWidth, coarseHeight, grainScale);
    // 拡大した画像が寸法を超えるぶんは、右と下を切る。
    const noise = new Float32Array(width * height);
    for (let y = 0; y < height; y++) noise.set(upscaled.subarray(y * upscaledWidth, y * upscaledWidth + width), y * width);
    const planes = Object.values(bandsOf(noise, mask, width, height)).flat();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const phase = phaseOf(x, y, grainScale);
        counts[phase]++;
        for (const [j, plane] of planes.entries()) squares[j][phase] += plane[y * width + x] ** 2;
      }
    }
  }
  const stds = squares.map((perPhase) => perPhase.map((square, phase) => Math.sqrt(square / counts[phase])));
  bandStdTables.set(key, stds);
  return stds;
}
// ---- 色 ----

// sRGB で符号化した値 v(0..1)の線形の値と、その逆。
export const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
export const linearToSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

// 8bit sRGB の画素列 codes(画素ごとに channels byte、先頭 3 つが RGB)を、画素ごとに 3 つの線形 sRGB へ。
export function linearOfSrgbCodes(codes, channels, pixelCount) {
  const table = Float32Array.from({ length: 256 }, (_, v) => srgbToLinear(v / 255));
  const rgb = new Float32Array(pixelCount * 3);
  for (let p = 0; p < pixelCount; p++) {
    for (let k = 0; k < 3; k++) rgb[p * 3 + k] = table[codes[p * channels + k]];
  }
  return rgb;
}

// 画素ごとに 3 つの線形 sRGB を、8bit sRGB の画素列(画素ごとに 3 byte)へ。範囲の外は端へ寄せる。
export function srgbCodesOfLinear(rgb) {
  const codes = new Uint8Array(rgb.length);
  for (let i = 0; i < rgb.length; i++) {
    codes[i] = Math.round(255 * linearToSrgb(Math.min(1, Math.max(0, rgb[i]))));
  }
  return codes;
}

// 画素ごとに 3 つの線形 sRGB を Oklab の平面の組 [L, a, b] へ(Ottosson 2020)。
export function oklabOf(rgb) {
  const count = rgb.length / 3;
  const lab = [new Float32Array(count), new Float32Array(count), new Float32Array(count)];
  for (let p = 0; p < count; p++) {
    const [r, g, b] = [rgb[p * 3], rgb[p * 3 + 1], rgb[p * 3 + 2]];
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    lab[0][p] = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
    lab[1][p] = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    lab[2][p] = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  }
  return lab;
}

// Oklab の平面の組を、画素ごとに 3 つの線形 sRGB へ。oklabOf の逆。
export function linearOfOklab(lab) {
  const count = lab[0].length;
  const rgb = new Float32Array(count * 3);
  for (let p = 0; p < count; p++) {
    const [L, a, b] = [lab[0][p], lab[1][p], lab[2][p]];
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
    rgb[p * 3] = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    rgb[p * 3 + 1] = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    rgb[p * 3 + 2] = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  }
  return rgb;
}

// ---- 帯 ----

// 平面 values の、mask の立った画素だけで均した一辺 size の箱の平均を sizes の順に返す。箱は画素 x を
// [x − ⌊s/2⌋, x + ⌈s/2⌉ − 1] に置く — 一辺 s の箱は一辺 2s の箱の中に入る。mask の立った画素が箱に無ければ 0。
function boxMeans(values, mask, width, height, sizes) {
  // 和の表。行と列を 1 つずつ足し、(x, y) に [0, x) × [0, y) の和を置く。
  const stride = width + 1;
  const sum = new Float64Array(stride * (height + 1));
  const weight = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    let rowWeight = 0;
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (mask[p]) {
        rowSum += values[p];
        rowWeight += 1;
      }
      const q = (y + 1) * stride + x + 1;
      sum[q] = sum[q - stride] + rowSum;
      weight[q] = weight[q - stride] + rowWeight;
    }
  }
  return sizes.map((size) => {
    const lo = Math.floor(size / 2);
    const hi = size - lo;
    const mean = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      const y0 = Math.max(0, y - lo) * stride;
      const y1 = Math.min(height, y + hi) * stride;
      for (let x = 0; x < width; x++) {
        const x0 = Math.max(0, x - lo);
        const x1 = Math.min(width, x + hi);
        const w = weight[y1 + x1] - weight[y0 + x1] - weight[y1 + x0] + weight[y0 + x0];
        if (w > 0) mean[y * width + x] = (sum[y1 + x1] - sum[y0 + x1] - sum[y1 + x0] + sum[y0 + x0]) / w;
      }
    }
    return mean;
  });
}

// 平面 values を、帯 d_s = ē_s − ē_2s(BAND_SCALES の順)と残り ē_RESIDUAL_SCALE へ分ける。ē_s は mask の立った画素
// だけで均した箱の平均で、mask の立った画素では帯と残りの和が values に戻る。
export function bandsOf(values, mask, width, height) {
  const means = boxMeans(values, mask, width, height, [...BAND_SCALES, RESIDUAL_SCALE]);
  const bands = BAND_SCALES.map((_, j) => means[j].map((v, p) => v - means[j + 1][p]));
  return { bands, residual: means[BAND_SCALES.length] };
}

// ---- 粒と区間スコア ----

// values の先頭 count 個の中央値(上側)。values の並びを壊す。
function medianInPlace(values, count) {
  const k = Math.floor(count / 2);
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const pivot = values[(lo + hi) >> 1];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (values[i] < pivot) i++;
      while (values[j] > pivot) j--;
      if (i <= j) {
        [values[i], values[j]] = [values[j], values[i]];
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return values[k];
}

// 帯 bands(BAND_SCALES の順)から、各画素の粒の大きさ g。粒の帯 d_m(m = grainScale)を粒の雑音での標準偏差で
// 割った値の絶対値の、画素を囲む窓の mask の立った画素での中央値を、正規分布の標準偏差へ直す。窓は
// GRAIN_STRIDE 四方の区画ごとに、区画の中心を囲む GRAIN_WINDOW 四方に置く。
export function grainOf(bands, mask, width, height, grainScale) {
  const grain = new Float32Array(width * height);
  const scratch = new Float32Array(GRAIN_WINDOW * GRAIN_WINDOW);
  const band = BAND_SCALES.indexOf(grainScale);
  const stds = bandStdsOf(grainScale, width, height)[band];
  for (let by = 0; by * GRAIN_STRIDE < height; by++) {
    for (let bx = 0; bx * GRAIN_STRIDE < width; bx++) {
      const cx = bx * GRAIN_STRIDE + GRAIN_STRIDE / 2;
      const cy = by * GRAIN_STRIDE + GRAIN_STRIDE / 2;
      let count = 0;
      for (let y = Math.max(0, cy - GRAIN_WINDOW / 2); y < Math.min(height, cy + GRAIN_WINDOW / 2); y++) {
        for (let x = Math.max(0, cx - GRAIN_WINDOW / 2); x < Math.min(width, cx + GRAIN_WINDOW / 2); x++) {
          const p = y * width + x;
          if (mask[p]) scratch[count++] = Math.abs(bands[band][p]) / stds[phaseOf(x, y, grainScale)];
        }
      }
      const scale = count === 0 ? 0 : medianInPlace(scratch, count) / MAD_TO_SIGMA;
      const [left, right] = [bx * GRAIN_STRIDE, Math.min(width, (bx + 1) * GRAIN_STRIDE)];
      for (let y = by * GRAIN_STRIDE; y < Math.min(height, (by + 1) * GRAIN_STRIDE); y++) {
        grain.fill(scale, y * width + left, y * width + right);
      }
    }
  }
  return grain;
}

// 1 成分の誤差 e の、区間スコアの幅と超過の和(mask の立った画素の和)、超過の帯ごとの和(BAND_SCALES の順と残り)と
// 画素ごとの値 excessMap への足し込み、帯ごとの R(s)、粒の帯で粒の K 倍を超える画素の数。
function channelTerms(e, mask, width, height, t, grainScale, excessMap) {
  const { bands, residual } = bandsOf(e, mask, width, height);
  const grain = grainOf(bands, mask, width, height, grainScale);
  const all = [...bands, residual];
  const stds = bandStdsOf(grainScale, width, height);
  const grainBand = BAND_SCALES.indexOf(grainScale);
  const penalty = 2 / ALPHA;
  const excessByBand = new Float64Array(all.length);
  // 帯ごとの d_s² と u_s² の和。R(s) は両者の比の平方根。
  const squareByBand = new Float64Array(bands.length);
  const unitSquareByBand = new Float64Array(bands.length);
  let widthSum = 0;
  let tail = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (!mask[p]) continue;
      const g = grain[p];
      const phase = phaseOf(x, y, grainScale);
      for (let j = 0; j < all.length; j++) {
        const u = stds[j][phase] * g;
        widthSum += 2 * K * u;
        const over = Math.abs(all[j][p]) - K * u - t;
        if (over > 0) {
          excessByBand[j] += penalty * over;
          excessMap[p] += penalty * over;
        }
        if (j < bands.length) {
          squareByBand[j] += all[j][p] ** 2;
          unitSquareByBand[j] += u * u;
        }
      }
      if (Math.abs(bands[grainBand][p]) > K * stds[grainBand][phase] * g) tail++;
    }
  }
  const r = Array.from(squareByBand, (square, j) => Math.sqrt(square / unitSquareByBand[j]));
  return { widthSum, excessByBand, r, tail };
}

// 候補 candidate と基準 reference(Oklab の平面の組)の誤差を、mask の立った画素で測る。t は表示で見えない差
// (Oklab)、grainScale は候補が独立な標本を持つ一辺 [画素](BAND_SCALES のどれか。走査の解像度の逆数)。score は
// 区間スコア S、widthTerm と excessTerm はその幅と超過の項、excessByBand は超過の帯ごとの内訳(BAND_SCALES の順と
// 残り)、excessMap は画素ごとの超過(3 成分の和)、r は L 成分の帯ごとの R(s)、g は誤差のベクトルの RMS、tail は
// 粒の帯で粒の K 倍を超える画素の割合(3 成分を通して)。
export function errorMetrics(candidate, reference, mask, width, height, t, grainScale) {
  const excessMap = new Float32Array(width * height);
  const excessByBand = new Float64Array(BAND_SCALES.length + 1);
  let count = 0;
  let squareSum = 0;
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    count++;
    for (let c = 0; c < 3; c++) squareSum += (candidate[c][p] - reference[c][p]) ** 2;
  }
  let widthSum = 0;
  let tail = 0;
  let r = [];
  for (let c = 0; c < 3; c++) {
    const e = candidate[c].map((v, p) => v - reference[c][p]);
    const terms = channelTerms(e, mask, width, height, t, grainScale, excessMap);
    widthSum += terms.widthSum;
    tail += terms.tail;
    for (const [j, v] of terms.excessByBand.entries()) excessByBand[j] += v;
    if (c === 0) r = terms.r;
  }
  const excessSum = excessByBand.reduce((sum, v) => sum + v, 0);
  return {
    score: (widthSum + excessSum) / count,
    widthTerm: widthSum / count,
    excessTerm: excessSum / count,
    excessByBand: Array.from(excessByBand, (v) => v / count),
    excessMap,
    r,
    g: Math.sqrt(squareSum / count),
    tail: tail / (3 * count),
  };
}

// ---- 診断 ----

// 候補と基準(Oklab の平面の組)の誤差のベクトルの RMS を、mask の立った画素で。
export function rmsOf(candidate, reference, mask) {
  let squareSum = 0;
  let count = 0;
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    count++;
    for (let c = 0; c < 3; c++) squareSum += (candidate[c][p] - reference[c][p]) ** 2;
  }
  return Math.sqrt(squareSum / count);
}

// 連続するフレームの、候補の差分と基準の差分の差の平均絶対値。frames は Oklab の L の平面の並び。
export function flickerOf(candidateFrames, referenceFrames, mask) {
  let sum = 0;
  let count = 0;
  for (let k = 1; k < candidateFrames.length; k++) {
    for (let p = 0; p < mask.length; p++) {
      if (!mask[p]) continue;
      const candidateStep = candidateFrames[k][p] - candidateFrames[k - 1][p];
      const referenceStep = referenceFrames[k][p] - referenceFrames[k - 1][p];
      sum += Math.abs(candidateStep - referenceStep);
      count++;
    }
  }
  return sum / count;
}

// 画素ごとに channels 個の値の並び values の、画素 center を中心とする (2·half + 1) 四方の窓の成分ごとの平均。
export function windowMean(values, channels, width, [cx, cy], half) {
  const mean = new Array(channels).fill(0);
  const count = (2 * half + 1) ** 2;
  for (let y = cy - half; y <= cy + half; y++) {
    for (let x = cx - half; x <= cx + half; x++) {
      for (let k = 0; k < channels; k++) mean[k] += values[(y * width + x) * channels + k] / count;
    }
  }
  return mean;
}

// 法線の表示 normal(画素ごとに 3 つの 0..1)と深度の表示の値 depth(画素ごとに 1 つ)から、隣の画素と法線が
// normalCos より開くか、深度の表示が depthStep 以上違う画素の印。
export function edgesOf(normal, depth, width, height, normalCos, depthStep) {
  const edges = new Uint8Array(width * height);
  const n = (p) => [0, 1, 2].map((k) => normal[p * 3 + k] * 2 - 1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      for (const q of [x + 1 < width ? p + 1 : -1, y + 1 < height ? p + width : -1]) {
        if (q < 0) continue;
        const [a, b] = [n(p), n(q)];
        const cos = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / Math.hypot(...a) / Math.hypot(...b);
        if (cos < normalCos || Math.abs(depth[p] - depth[q]) >= depthStep) {
          edges[p] = 1;
          edges[q] = 1;
        }
      }
    }
  }
  return edges;
}

// 印 edges から band 画素以内にある、印 surface の立った画素の印。
export function nearEdgesOf(edges, surface, width, height, band) {
  const near = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (!surface[p]) continue;
      for (let dy = -band; dy <= band && !near[p]; dy++) {
        for (let dx = -band; dx <= band && !near[p]; dx++) {
          const [nx, ny] = [x + dx, y + dy];
          if (nx >= 0 && ny >= 0 && nx < width && ny < height && edges[ny * width + nx]) near[p] = 1;
        }
      }
    }
  }
  return near;
}

// ---- 刺激 ----

// 基準 reference から候補 candidate への誤差を a 倍にした画像(Oklab の平面の組)。
export function scaledErrorOf(reference, candidate, a) {
  return reference.map((plane, c) => plane.map((v, p) => v + a * (candidate[c][p] - v)));
}

// 平面 values を、mask の立った画素だけで、標準偏差 sigma・半径 radius [画素] の定常なガウスで均す。mask の立って
// いない画素は values のまま。
export function gaussianBlurOf(values, mask, width, height, sigma, radius) {
  const kernel = Array.from({ length: 2 * radius + 1 }, (_, i) => Math.exp(-((i - radius) ** 2) / (2 * sigma * sigma)));
  // 縦横に分けて、値と重みの両方を畳み込む。
  const pass = (source, sourceWeight, dx, dy) => {
    const out = new Float32Array(width * height);
    const outWeight = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0;
        let weight = 0;
        for (let i = -radius; i <= radius; i++) {
          const [nx, ny] = [x + i * dx, y + i * dy];
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const q = ny * width + nx;
          sum += kernel[i + radius] * source[q];
          weight += kernel[i + radius] * sourceWeight[q];
        }
        out[y * width + x] = sum;
        outWeight[y * width + x] = weight;
      }
    }
    return [out, outWeight];
  };
  const masked = values.map((v, p) => (mask[p] ? v : 0));
  const [rowSum, rowWeight] = pass(masked, Float32Array.from(mask), 1, 0);
  const [sum, weight] = pass(rowSum, rowWeight, 0, 1);
  return values.map((v, p) => (mask[p] && weight[p] > 0 ? sum[p] / weight[p] : v));
}
