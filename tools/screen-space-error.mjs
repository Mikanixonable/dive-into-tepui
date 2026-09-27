// 近傍拡散補正の画質の指標と、その診断・表示の色の変換。誤差 e は補正 ΔE をアルベド 1 の面の表示の尺度へ写した
// q = 露出係数·ΔE/π の、候補と収束先の差。スケール s ごとに e を構造 L_s と雑音へ分け、雑音の強さから正直な白色雑音なら
// L_s が揺れる大きさ σ̃_s を求め、スコア S = mean_x Σ_成分 [N + β·Σ_s (μ·s)^−γ·max(0, L_s² − σ̃_s²)/(σ̃_s + ε)] で
// 雑音の罰 N と偽の構造の罰を 1 つに並べる(μ は表示倍率)。
// 画像は画素の配列で受け取る。平面は行優先の Float32Array、q と Oklab の画像は平面 3 枚の組。

// 誤差を分けるスケール s(ガウスの標準偏差 [画素])。構造 L_s は帯 G_s∗e − G_2s∗e で、最後の s だけは G_s∗e。
export const ERROR_SCALES = [1, 2, 4, 8, 16, 32, 64];
const LAST = ERROR_SCALES.length - 1;
// 偽の構造の罰の重み β と、スケールの重み (μ·s)^−γ の指数 γ、偽の構造の罰の分母の下限 ε(q)。
const FALSE_STRUCTURE_WEIGHT = 100;
const SCALE_EXPONENT = 2;
const EPSILON = 3e-4;

// ---- 測る量 ----

// 補正 correction(画素ごとに rgb の ΔE)を露出係数 exposure でアルベド 1 の面の表示の尺度へ写した
// q = exposure·ΔE/π の平面の組 [R, G, B]。トーンマップの前に補正が表示へ足す値。
export function exposedCorrectionOf(correction, exposure) {
  const count = correction.length / 3;
  const scale = exposure / Math.PI;
  return [0, 1, 2].map((c) => Float32Array.from({ length: count }, (_, p) => scale * correction[p * 3 + c]));
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

// ---- ガウス ----

// 標準偏差 s [画素] の、半径 3s で打ち切って和を 1 にした 1 次元の核。
function gaussianKernelOf(s) {
  const radius = Math.ceil(3 * s);
  const taps = Float64Array.from({ length: 2 * radius + 1 }, (_, i) => Math.exp(-((i - radius) ** 2) / (2 * s * s)));
  const sum = taps.reduce((total, v) => total + v, 0);
  return { radius, taps: taps.map((v) => v / sum) };
}
const KERNELS = ERROR_SCALES.map(gaussianKernelOf);
// スケールの番号 j の帯の粗い側 G_2s の番号。最後のスケールは自分。
const coarserOf = (j) => Math.min(j + 1, LAST);

// 1 次元の核 a と b の積の核。台は狭いほう。2 次元の核どうしの積も、1 次元の積の外積になる。
function productKernelOf(a, b) {
  const radius = Math.min(a.radius, b.radius);
  return {
    radius,
    taps: Float64Array.from({ length: 2 * radius + 1 }, (_, i) => a.taps[i - radius + a.radius] * b.taps[i - radius + b.radius]),
  };
}

// 平面 values(width × height)を、1 次元の核 kernel の外積で畳み込む。画像の外の画素は 0。
function convolve(values, width, height, { radius, taps }) {
  // 行も列も、タップを外側に回してメモリを順に読む。
  const rows = new Float64Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let i = -radius; i <= radius; i++) {
      const tap = taps[i + radius];
      for (let x = Math.max(0, -i); x < Math.min(width, width - i); x++) rows[row + x] += tap * values[row + x + i];
    }
  }
  const out = new Float64Array(width * height);
  for (let y = 0; y < height; y++) {
    const lo = Math.max(-radius, -y);
    const hi = Math.min(radius, height - 1 - y);
    const row = y * width;
    for (let i = lo; i <= hi; i++) {
      const tap = taps[i + radius];
      const source = (y + i) * width;
      for (let x = 0; x < width; x++) out[row + x] += tap * rows[source + x];
    }
  }
  return out;
}

// 印 mask の、スケールごとの正規化の分母 G_s∗M(denominators)と、白色雑音での L_s の分散の係数 κ_s(kappas)。
// κ_s は画素ごとの正規化した核 ĝ から Σ(ĝ_s − ĝ_2s)²(最後のスケールは Σĝ_s²)で、mask の立った画素だけに入れる。
function normalizationOf(mask, width, height) {
  const m = Float64Array.from(mask);
  const denominators = KERNELS.map((kernel) => convolve(m, width, height, kernel));
  const squares = KERNELS.map((kernel) => convolve(m, width, height, productKernelOf(kernel, kernel)));
  const kappas = KERNELS.map((kernel, j) => {
    const kappa = new Float64Array(mask.length);
    const c = coarserOf(j);
    const cross = j === LAST ? null : convolve(m, width, height, productKernelOf(kernel, KERNELS[c]));
    for (let p = 0; p < mask.length; p++) {
      if (!mask[p]) continue;
      const [ws, wc] = [denominators[j][p], denominators[c][p]];
      kappa[p] = j === LAST ? squares[j][p] / (ws * ws)
        : squares[j][p] / (ws * ws) - (2 * cross[p]) / (ws * wc) + squares[c][p] / (wc * wc);
    }
    return kappa;
  });
  return { denominators, kappas };
}

// 平面 values の、mask の立った画素だけで正規化した畳み込み G∗values。kernel は G の 1 次元の核、denominator は同じ
// 核の G∗M。mask の立っていない画素は 0。
function normalizedConvolve(values, mask, width, height, kernel, denominator) {
  const sum = convolve(Float64Array.from(values, (v, p) => (mask[p] ? v : 0)), width, height, kernel);
  return sum.map((v, p) => (mask[p] && denominator[p] > 0 ? v / denominator[p] : 0));
}

// ---- 指標 ----

// 1 成分の誤差 e の、mask の立った画素での和: 雑音の罰 N(noise)、スケールごとに重み weights を掛けた偽の構造の罰
// (falseStructureByScale)、L_s² と σ̃_s²(structureSquares・honestSquares)。偽の構造の罰は画素ごとに falseStructureMap
// へも足す。normalization は normalizationOf の返り値。
function channelTermsOf(e, mask, width, height, normalization, weights, falseStructureMap) {
  const { denominators, kappas } = normalization;
  const blurred = (values, j) => normalizedConvolve(values, mask, width, height, KERNELS[j], denominators[j]);
  const smooth = KERNELS.map((_, j) => blurred(e, j));
  let noise = 0;
  const falseStructureByScale = new Float64Array(ERROR_SCALES.length);
  const structureSquares = new Float64Array(ERROR_SCALES.length);
  const honestSquares = new Float64Array(ERROR_SCALES.length);
  for (let j = 0; j < ERROR_SCALES.length; j++) {
    const c = coarserOf(j);
    // 構造 L_s と、雑音 H_s = e − G_s∗e の強さ V_s = G_2s∗H_s²(最後のスケールは G_s∗H_s²)。
    const structure = j === LAST ? smooth[j] : smooth[j].map((v, p) => v - smooth[c][p]);
    const power = blurred(Float64Array.from(e, (v, p) => (v - smooth[j][p]) ** 2), c);
    for (let p = 0; p < mask.length; p++) {
      if (!mask[p]) continue;
      // N = sqrt(G_2∗H_1²) は最も細かいスケールの V の平方根。
      if (j === 0) noise += Math.sqrt(power[p]);
      const honest = Math.sqrt(power[p] * kappas[j][p]);
      const square = structure[p] * structure[p];
      structureSquares[j] += square;
      honestSquares[j] += honest * honest;
      const over = square - honest * honest;
      if (over <= 0) continue;
      const penalty = weights[j] * over / (honest + EPSILON);
      falseStructureByScale[j] += penalty;
      falseStructureMap[p] += penalty;
    }
  }
  return { noise, falseStructureByScale, structureSquares, honestSquares };
}

// 候補 candidate と収束先 reference(平面の組)の誤差を、mask の立った画素で測る。magnification は表示倍率 μ(画像の
// 1 画素が画面の何画素に映るか)。score はスコア S、noiseTerm と falseStructureTerm はその雑音と偽の構造の項、
// falseStructureByScale は偽の構造の項のスケールごとの内訳(ERROR_SCALES の順)、falseStructureMap は画素ごとの偽の
// 構造の項(3 成分の和)、r はスケールごとの R(s) = sqrt(Σ L_s² / Σ σ̃_s²)(3 成分を通して。1 なら正直な雑音、上なら
// 雑音で説明できない構造)、g は誤差のベクトルの RMS。
export function errorMetrics(candidate, reference, mask, width, height, magnification = 1) {
  const normalization = normalizationOf(mask, width, height);
  const weights = ERROR_SCALES.map((s) => FALSE_STRUCTURE_WEIGHT * (magnification * s) ** -SCALE_EXPONENT);
  const falseStructureMap = new Float32Array(width * height);
  let noise = 0;
  const falseStructureByScale = new Float64Array(ERROR_SCALES.length);
  const structureSquares = new Float64Array(ERROR_SCALES.length);
  const honestSquares = new Float64Array(ERROR_SCALES.length);
  for (let c = 0; c < 3; c++) {
    const e = candidate[c].map((v, p) => v - reference[c][p]);
    const terms = channelTermsOf(e, mask, width, height, normalization, weights, falseStructureMap);
    noise += terms.noise;
    for (let j = 0; j < ERROR_SCALES.length; j++) {
      falseStructureByScale[j] += terms.falseStructureByScale[j];
      structureSquares[j] += terms.structureSquares[j];
      honestSquares[j] += terms.honestSquares[j];
    }
  }
  const count = mask.reduce((sum, v) => sum + v, 0);
  const falseStructure = falseStructureByScale.reduce((sum, v) => sum + v, 0);
  return {
    score: (noise + falseStructure) / count,
    noiseTerm: noise / count,
    falseStructureTerm: falseStructure / count,
    falseStructureByScale: Array.from(falseStructureByScale, (v) => v / count),
    falseStructureMap,
    r: Array.from(structureSquares, (square, j) => Math.sqrt(square / honestSquares[j])),
    g: rmsOf(candidate, reference, mask),
  };
}

// ---- 診断 ----

// 候補と基準(平面の組)の誤差のベクトルの RMS を、mask の立った画素で。
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

// 連続するフレームの、候補の差分と基準の差分の差の絶対値の、3 成分の和の平均。frames は平面の組の並び。
export function flickerOf(candidateFrames, referenceFrames, mask) {
  let sum = 0;
  let count = 0;
  for (let k = 1; k < candidateFrames.length; k++) {
    for (let p = 0; p < mask.length; p++) {
      if (!mask[p]) continue;
      for (let c = 0; c < 3; c++) {
        const candidateStep = candidateFrames[k][c][p] - candidateFrames[k - 1][c][p];
        const referenceStep = referenceFrames[k][c][p] - referenceFrames[k - 1][c][p];
        sum += Math.abs(candidateStep - referenceStep);
      }
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
