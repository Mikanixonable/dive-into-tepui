// 雲の形態特徴をタイルごとに測る。実写の教師(4 km/px・512²)と生成の絵を同じ 64 px のタイルへ切り、
// 被覆・粒の大きさ・筋の向き・網目・板を同じ式で数える。定義の正本は共通の設計書
// (dive-into-tepui2-data/cloud-prompts/regime-design.md の「形態特徴」)。
// 雲の信号は輝度ではなく、線形 RGB の最小値(cloudSignalField)。
import { decodePng } from './png.mjs';
import { fft2, fitLine } from './cloud-detail-metrics.mjs';
import { srgbToLinear } from './cloud-detail-field.mjs';
import { invertNeutralDisplay } from './cloud-detail-features.mjs';

export const TILE_PX = 64;
export const COVER_THRESHOLD = 0.25;
export const DENSE_THRESHOLD = 0.45;
export const FEATURE_NAMES = ['cover', 'coverDense', 'tone', 'toneCloud', 'scaleKm', 'slope', 'texture', 'aniso', 'orientDeg', 'edge', 'euler', 'clump'];

// clump のブロック一辺 [px]。4 km/px で 32 km に当たる(設計書の clump の定義)。
const BLOCK_PX = 8;
// texture の上限の波長 [km]。これより細かい成分の標準偏差を測る。
const TEXTURE_MAX_WAVELENGTH_KM = 32;
// タイルの平均の 2 次元窓。Hann の周期形で、端の不連続による漏れを抑える。
const hann = (n) => Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));

// 場の中の、タイルごとの形態特徴。戻り値 [{ row, col, xKm, yKm, features }]。
// 行は上(北)から、列は左(西)から数える。格子は画像の中央へ寄せ、端数は捨てる。
// xKm・yKm は画像の中心からのタイルの中心の距離で、東と北を正にする(画像は北が上)。
export function tileFeatures(field, kmPerPx, tilePx = TILE_PX) {
  // FFT が 2 の冪の一辺を要るので、それを先に確かめる。
  if (tilePx < 16 || (tilePx & (tilePx - 1)) !== 0) throw new Error(`tilePx は 16 以上の 2 の冪: ${tilePx}`);
  const { width, height, data } = field;
  const nx = Math.floor(width / tilePx);
  const ny = Math.floor(height / tilePx);
  const x0 = Math.floor((width - nx * tilePx) / 2);
  const y0 = Math.floor((height - ny * tilePx) / 2);
  const tiles = [];
  const buffer = new Float64Array(tilePx * tilePx);
  for (let row = 0; row < ny; row++) {
    for (let col = 0; col < nx; col++) {
      const ox = x0 + col * tilePx;
      const oy = y0 + row * tilePx;
      for (let y = 0; y < tilePx; y++) {
        for (let x = 0; x < tilePx; x++) buffer[y * tilePx + x] = data[(oy + y) * width + ox + x];
      }
      const cx = ox + tilePx / 2;
      const cy = oy + tilePx / 2;
      tiles.push({
        row,
        col,
        xKm: (cx - width / 2) * kmPerPx,
        yKm: (height / 2 - cy) * kmPerPx,
        features: tileStats(buffer, tilePx, kmPerPx),
      });
    }
  }
  return tiles;
}

// 雲の信号の場を作ってから tileFeatures する。options は cloudSignalField へ渡す(illumination)。
export function tileFeaturesFromPng(png, kmPerPx, tilePx = TILE_PX, options = {}) {
  return tileFeatures(cloudSignalField(png, options), kmPerPx, tilePx);
}

// PNG から、雲の信号の場(線形 RGB の最小値)を作る。雲は白く 3 チャンネルとも高いが、砂・植生・海は
// どれかのチャンネルが低いので、明るい地表を雲に数えない。グレーの PNG は 1 チャンネルをそのまま使う。
// illumination を渡すのは生成の撮影だけ。撮影は放射輝度を表示用へ写した画なので、チャンネルごとに
// 逆のトーンマップを掛けてから照明で割り、実写と同じ反射率相当へ戻す。照明は数値か、画素ごとの
// 配列(タイルごとに太陽の高さが違うため)。実写は渡さない(補正済みの反射率として読む)。
export function cloudSignalField(png, { illumination = null } = {}) {
  const { width, height, channels, data } = decodePng(png);
  const count = width * height;
  const out = new Float32Array(count);
  const planes = channels === 1 ? 1 : 3;
  for (let i = 0; i < count; i++) {
    const lighting = typeof illumination === 'number' ? illumination : illumination?.[i] ?? 1;
    let signal = Infinity;
    for (let c = 0; c < planes; c++) {
      let linear = srgbToLinear(data[i * channels + c]);
      if (illumination !== null) linear = invertNeutralDisplay(linear) / lighting;
      if (linear < signal) signal = linear;
    }
    out[i] = signal;
  }
  return { width, height, data: out };
}

// 1 タイル(n×n の値、行優先)の形態特徴。
function tileStats(t, n, kmPerPx) {
  const count = n * n;
  let sum = 0;
  let cloudSum = 0;
  let cloudCount = 0;
  let denseCount = 0;
  for (let i = 0; i < count; i++) {
    const v = t[i];
    sum += v;
    if (v > COVER_THRESHOLD) {
      cloudSum += v;
      cloudCount++;
    }
    if (v > DENSE_THRESHOLD) denseCount++;
  }
  const tone = sum / count;
  const cover = cloudCount / count;
  const spectrum = spectrumStats(t, n, kmPerPx, tone);
  const structure = structureStats(t, n);
  const euler = eulerDensity(t, n, kmPerPx);
  return {
    cover,
    coverDense: denseCount / count,
    tone,
    // 雲が殆ど無い(cover < 0.02)タイルでは、雲の画素の平均は標本が少なすぎて決まらないので null にする。
    toneCloud: cover < 0.02 ? null : cloudSum / cloudCount,
    scaleKm: spectrum.scaleKm,
    slope: spectrum.slope,
    // 波長 ≤ 32 km の成分の標準偏差。Parseval で |F|² の総和は n²·Σx² なので、
    // 総和を n⁴ で割ると分散になる。平均の明るさで割って、明るい場面と暗い場面を揃える。
    texture: Math.sqrt(spectrum.shortEnergy / (n * n * n * n)) / (tone + 0.05),
    aniso: structure.aniso,
    orientDeg: structure.orientDeg,
    edge: edgeDensity(t, n, kmPerPx),
    euler,
    clump: clumpIndex(t, n, cover),
  };
}

// 平均を引き、Hann 窓を掛けて 2 次元 FFT し、整数の波数の環へ |F|² を集める。
// E(k) は環の和、P(k) は環の平均。scaleKm は E の重みの波長の対数平均、slope は P の両対数の傾き。
// 全画素が同じ値のタイルは、中心化した値が 0 になるので scaleKm・slope を null にする。
function spectrumStats(t, n, kmPerPx, mean) {
  const window = hann(n);
  const re = new Float64Array(n * n);
  const im = new Float64Array(n * n);
  let centeredSquares = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const v = t[y * n + x] - mean;
      centeredSquares += v * v;
      re[y * n + x] = v * window[y] * window[x];
    }
  }
  if (centeredSquares < 1e-12) return { scaleKm: null, slope: null, shortEnergy: 0 };
  fft2(re, im, n, false);
  const ringEnergy = new Float64Array(n / 2 + 1);
  const ringCount = new Float64Array(n / 2 + 1);
  for (let fy = 0; fy < n; fy++) {
    const ky = fy <= n / 2 ? fy : fy - n;
    for (let fx = 0; fx < n; fx++) {
      const kx = fx <= n / 2 ? fx : fx - n;
      const k = Math.round(Math.hypot(kx, ky));
      if (k < 1 || k > n / 2) continue;
      ringEnergy[k] += re[fy * n + fx] ** 2 + im[fy * n + fx] ** 2;
      ringCount[k]++;
    }
  }
  let total = 0;
  let logWeighted = 0;
  let shortEnergy = 0;
  const pairs = [];
  for (let k = 1; k <= n / 2; k++) {
    const e = ringEnergy[k];
    if (e <= 0) continue;
    const wavelengthKm = (n * kmPerPx) / k;
    total += e;
    logWeighted += e * Math.log(wavelengthKm);
    if (wavelengthKm <= TEXTURE_MAX_WAVELENGTH_KM) shortEnergy += e;
  }
  for (let k = 2; k <= n / 4; k++) {
    const meanPower = ringEnergy[k] / ringCount[k];
    if (meanPower > 0) pairs.push([Math.log(k), Math.log(meanPower)]);
  }
  if (total <= 0) return { scaleKm: null, slope: null, shortEnergy: 0 };
  return {
    scaleKm: Math.exp(logWeighted / total),
    slope: pairs.length >= 2 ? fitLine(pairs).slope : null,
    shortEnergy,
  };
}

// 構造テンソルの異方性と筋の向き。3×3 の二項ぼかし(σ = 1 px 相当)の後に中心差分を取る。
// gx は東向き(列の増える向き)、gyNorth は北向き(行の減る向き)。タイルの内側だけを使う。
function structureStats(t, n) {
  const blurX = new Float64Array(n * n);
  const blurred = new Float64Array(n * n);
  const clamp = (i) => Math.min(n - 1, Math.max(0, i));
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      blurX[y * n + x] = (t[y * n + clamp(x - 1)] + 2 * t[y * n + x] + t[y * n + clamp(x + 1)]) / 4;
    }
  }
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      blurred[y * n + x] = (blurX[clamp(y - 1) * n + x] + 2 * blurX[y * n + x] + blurX[clamp(y + 1) * n + x]) / 4;
    }
  }
  let jxx = 0;
  let jyy = 0;
  let jxy = 0;
  for (let y = 1; y < n - 1; y++) {
    for (let x = 1; x < n - 1; x++) {
      const gx = (blurred[y * n + x + 1] - blurred[y * n + x - 1]) / 2;
      const gyNorth = -(blurred[(y + 1) * n + x] - blurred[(y - 1) * n + x]) / 2;
      jxx += gx * gx;
      jyy += gyNorth * gyNorth;
      jxy += gx * gyNorth;
    }
  }
  const trace = jxx + jyy;
  if (trace <= 0) return { aniso: 0, orientDeg: null };
  const aniso = Math.sqrt((jxx - jyy) ** 2 + 4 * jxy * jxy) / trace;
  // 勾配の主方向 θ に直交する向きが、筋の伸びる向き。180 度の周期で [0,180) へ折る。
  const thetaDeg = (0.5 * Math.atan2(2 * jxy, jxx - jyy) * 180) / Math.PI;
  const orientDeg = (((thetaDeg + 90) % 180) + 180) % 180;
  return { aniso, orientDeg };
}

// 雲の 2 値像(値 > COVER_THRESHOLD)の、値の違う 4 近傍の対の数から縁の密度を出す。
// 1 対の長さを kmPerPx とし、斜めの向きの平均の補正として π/4 を掛ける。タイルの外は見ない。
function edgeDensity(t, n, kmPerPx) {
  let pairs = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const c = t[y * n + x] > COVER_THRESHOLD;
      if (x + 1 < n && c !== t[y * n + x + 1] > COVER_THRESHOLD) pairs++;
      if (y + 1 < n && c !== t[(y + 1) * n + x] > COVER_THRESHOLD) pairs++;
    }
  }
  const areaKm2 = (n * kmPerPx) ** 2;
  return (pairs * kmPerPx * Math.PI) / 4 / areaKm2;
}

// 2×2 の四つ組の数え上げでオイラー標数の密度を出す。四つ組はタイルの内側だけ((n−1)² 個)。
// 外の画素を背景とみなさないので、タイル全体が雲のときは 0 になる(角が一つも現れないため)。
// 単位は 1/10⁴ km²。
function eulerDensity(t, n, kmPerPx) {
  let q1 = 0;
  let q3 = 0;
  let qd = 0;
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const a = t[y * n + x] > COVER_THRESHOLD ? 1 : 0;
      const b = t[y * n + x + 1] > COVER_THRESHOLD ? 1 : 0;
      const c = t[(y + 1) * n + x] > COVER_THRESHOLD ? 1 : 0;
      const d = t[(y + 1) * n + x + 1] > COVER_THRESHOLD ? 1 : 0;
      const sum = a + b + c + d;
      if (sum === 1) q1++;
      else if (sum === 3) q3++;
      else if (sum === 2 && a === d && b === c && a !== b) qd++;
    }
  }
  const areaKm2 = (n * kmPerPx) ** 2;
  return (((q1 - q3 - 2 * qd) / 4) / (areaKm2 / 1e4));
}

// BLOCK_PX のブロックごとの被覆率の分散 ÷ 二項分布の分散。0 = 一様に散る、1 = 完全に分かれる。
function clumpIndex(t, n, cover) {
  const blocks = [];
  for (let by = 0; by < n; by += BLOCK_PX) {
    for (let bx = 0; bx < n; bx += BLOCK_PX) {
      let on = 0;
      for (let y = by; y < by + BLOCK_PX; y++) {
        for (let x = bx; x < bx + BLOCK_PX; x++) {
          if (t[y * n + x] > COVER_THRESHOLD) on++;
        }
      }
      blocks.push(on / (BLOCK_PX * BLOCK_PX));
    }
  }
  const mean = blocks.reduce((s, v) => s + v, 0) / blocks.length;
  const variance = blocks.reduce((s, v) => s + (v - mean) ** 2, 0) / blocks.length;
  return variance / (cover * (1 - cover) + 1e-6);
}
