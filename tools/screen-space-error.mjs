// 近傍拡散補正の画質の計測が使う、測る量 q(補正を、アルベド 1 の面の表示の尺度へ写したもの)と、その診断と、表示の
// 色の変換。画像は画素の配列で受け取る。平面は行優先の Float32Array、q と Oklab の画像は平面 3 枚の組。

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
