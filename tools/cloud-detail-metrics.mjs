// 雲の画像(線形輝度の 2 次元場と km/px)から、尺度ごとの「量・傾き・緩急・形・向き」を測る
// 物差し。描画画像と衛星実写へ同じ関数を当てて比べる前提で、入力は中央から切り出した
// 512² 以下の最大の 2 の冪の正方形へ揃え、値はすべて km の単位系で返す。
import { componentStats } from './cloud-components.mjs';
import { structureTensor, summarizeStructure } from './cloud-structure.mjs';
import { cropField } from './gray-image.mjs';

// 切り出す正方形の一辺の上限 [px]。
const MAX_CROP_PX = 512;

// 幅・高さに収まる最大の 2 の冪(上限 MAX_CROP_PX)。
function cropSizeOf(width, height) {
  const limit = Math.min(MAX_CROP_PX, width, height);
  return 1 << Math.floor(Math.log2(limit));
}

// 自前の基数 2 の 1 次元 FFT。re/im は同じ長さ(2 の冪)の実部・虚部で、結果は in-place。
// 順変換は e^(-2πi・) の無規格化、逆変換は 1/n 割り付き。
function fft1d(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = ((inverse ? 1 : -1) * 2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curR = 1;
      let curI = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k];
        const ai = im[i + k];
        const br = re[i + k + len / 2] * curR - im[i + k + len / 2] * curI;
        const bi = re[i + k + len / 2] * curI + im[i + k + len / 2] * curR;
        re[i + k] = ar + br;
        im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br;
        im[i + k + len / 2] = ai - bi;
        const nextR = curR * wr - curI * wi;
        curI = curR * wi + curI * wr;
        curR = nextR;
      }
    }
  }
  if (!inverse) return;
  for (let i = 0; i < n; i++) {
    re[i] /= n;
    im[i] /= n;
  }
}

// n × n の 2 次元 FFT(行→列の順変換/逆変換)。
export function fft2(re, im, n, inverse) {
  const rowRe = new Float64Array(n);
  const rowIm = new Float64Array(n);
  for (let y = 0; y < n; y++) {
    rowRe.set(re.subarray(y * n, (y + 1) * n));
    rowIm.set(im.subarray(y * n, (y + 1) * n));
    fft1d(rowRe, rowIm, inverse);
    re.set(rowRe, y * n);
    im.set(rowIm, y * n);
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      rowRe[y] = re[y * n + x];
      rowIm[y] = im[y * n + x];
    }
    fft1d(rowRe, rowIm, inverse);
    for (let y = 0; y < n; y++) {
      re[y * n + x] = rowRe[y];
      im[y * n + x] = rowIm[y];
    }
  }
}

// [[x, y], ...] の対への最小二乗直線。{slope, intercept}。
function fitLine(pairs) {
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const [x, y] of pairs) {
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  const n = pairs.length;
  const denominator = n * sxx - sx * sx;
  if (Math.abs(denominator) < 1e-30) return { slope: 0, intercept: sy / n };
  return {
    slope: (n * sxy - sx * sy) / denominator,
    intercept: (sy - ((n * sxy - sx * sy) / denominator) * sx) / n,
  };
}

// 平均を引いて周期 Hann 窓を掛けた場を返す。
function windowed(data, n) {
  let mean = 0;
  for (const v of data) mean += v;
  mean /= data.length;
  const out = new Float64Array(data.length);
  for (let y = 0; y < n; y++) {
    const wy = 0.5 * (1 - Math.cos((2 * Math.PI * (y + 0.5)) / n));
    for (let x = 0; x < n; x++) {
      const wx = 0.5 * (1 - Math.cos((2 * Math.PI * (x + 0.5)) / n));
      out[y * n + x] = (data[y * n + x] - mean) * wx * wy;
    }
  }
  return out;
}

// 動径スペクトル E[k](k = 1..n/2): |F|²/n² を波数の整数環ごとに足したもの。
// 等方な場では 1 次元波数スペクトルと同じ冪になる — 2 次元スペクトルが P(k) ∝ k^−(β+1) なら
// 方位積分 2πk・P(k) ∝ k^−β で、切片の 1 次元スペクトル ∫P dk⊥ も同じく k^−β になる。
// つまりここで得る傾き β は「1 次元波数スペクトルが k^−β」の β で、k^−5/3 の場では 5/3 が出る。
function radialPower(data, n) {
  const field = windowed(data, n);
  const re = Float64Array.from(field);
  const im = new Float64Array(n * n);
  fft2(re, im, n, false);
  const power = new Float64Array(n / 2 + 1);
  for (let ky = 0; ky < n; ky++) {
    const fy = Math.min(ky, n - ky);
    for (let kx = 0; kx < n; kx++) {
      const fx = Math.min(kx, n - kx);
      const k = Math.round(Math.hypot(fx, fy));
      if (k < 1 || k > n / 2) continue;
      const i = ky * n + kx;
      power[k] += (re[i] * re[i] + im[i] * im[i]) / (n * n);
    }
  }
  return power;
}

// オクターブ(波数 k0..2k0−1)ごとのパワーと、その帯の内側だけで取った局所の傾き。
// scaleKm は帯の幾何中心の波長 [km]。slope は帯内の動径スペクトルの両対数回帰を反転した
// もの(上の radialPower の定義で β そのもの)。帯の中の点が 2 つ未満のときは null。
function octaveTable(power, n, kmPerPx) {
  const octaves = [];
  for (let k0 = 1; k0 <= n / 4; k0 *= 2) {
    const k1 = Math.min(2 * k0 - 1, n / 2);
    let bandPower = 0;
    const pairs = [];
    for (let k = k0; k <= k1; k++) {
      bandPower += power[k];
      if (power[k] > 0) pairs.push([Math.log(k), Math.log(power[k])]);
    }
    octaves.push({
      k0,
      k1,
      scaleKm: (n * kmPerPx) / (k0 * Math.SQRT2),
      power: bandPower,
      slope: pairs.length >= 2 ? -fitLine(pairs).slope : null,
    });
  }
  return octaves;
}

// 箱ぼかし 1 回(半径 radius)。横は巻かず端を伸ばす。半径 0 ではそのまま写す。
function boxBlur(src, n, radius) {
  if (radius <= 0) return Float64Array.from(src);
  const tmp = new Float64Array(n * n);
  const dst = new Float64Array(n * n);
  const scale = 1 / (radius * 2 + 1);
  for (let y = 0; y < n; y++) {
    const row = y * n;
    const at = (x) => src[row + Math.min(n - 1, Math.max(0, x))];
    let sum = 0;
    for (let x = -radius; x <= radius; x++) sum += at(x);
    for (let x = 0; x < n; x++) {
      tmp[row + x] = sum * scale;
      sum += at(x + radius + 1) - at(x - radius);
    }
  }
  for (let x = 0; x < n; x++) {
    const at = (y) => tmp[Math.min(n - 1, Math.max(0, y)) * n + x];
    let sum = 0;
    for (let y = -radius; y <= radius; y++) sum += at(y);
    for (let y = 0; y < n; y++) {
      dst[y * n + x] = sum * scale;
      sum += at(y + radius + 1) - at(y - radius);
    }
  }
  return dst;
}

// 箱ぼかし 3 回で σ [px] のガウスを近似する。3 回の分散の和が r(r+1) なので、
// σ² = r(r+1) を満たす半径 r を各回に使う。
function gaussianBlur(src, n, sigmaPx) {
  const radius = Math.max(0, Math.round((Math.sqrt(1 + 4 * sigmaPx * sigmaPx) - 1) / 2));
  let field = Float64Array.from(src);
  for (let pass = 0; pass < 3; pass++) field = boxBlur(field, n, radius);
  return field;
}

// 隣り合う 2 つのガウスぼかし(σ, 2σ)の差を帯域通過係数とし、オクターブごとの尖度と
// 局所エネルギーの変動係数を出す。scaleKm は DoG(σ, 2σ) の応答ピークの波長 [km](≈ 6.5σ px)。
// 局所エネルギーは係数の 2 乗を一辺 8σ の箱で均したもので、変動係数はその標準偏差/平均。
function intermittencyStats(data, n, kmPerPx) {
  const sigmas = [];
  for (let s = 1; s <= n / 8; s *= 2) sigmas.push(s);
  const blurs = sigmas.map((sigma) => gaussianBlur(data, n, sigma));
  const bands = [];
  for (let j = 0; j + 1 < sigmas.length; j++) {
    const sigma = sigmas[j];
    const c = new Float64Array(n * n);
    for (let i = 0; i < c.length; i++) c[i] = blurs[j][i] - blurs[j + 1][i];
    let m2 = 0;
    let m4 = 0;
    for (const v of c) {
      m2 += v * v;
      m4 += v * v * v * v;
    }
    const count = c.length;
    const kurtosis = m2 > 0 ? (m4 * count) / (m2 * m2) : 0;
    const energy = new Float64Array(count);
    for (let i = 0; i < count; i++) energy[i] = c[i] * c[i];
    const smoothed = boxBlur(energy, n, Math.min(Math.round(4 * sigma), Math.floor(n / 8)));
    let mean = 0;
    for (const v of smoothed) mean += v;
    mean /= count;
    let variance = 0;
    for (const v of smoothed) variance += (v - mean) * (v - mean);
    variance /= count;
    bands.push({
      sigmaPx: sigma,
      scaleKm: 6.5 * sigma * kmPerPx,
      kurtosis,
      energyCv: mean > 0 ? Math.sqrt(variance) / mean : 0,
    });
  }
  return { bands };
}

// 冪乗則(両対数の直線)を全オクターブのパワーへ当て、各オクターブの実測/予測の比の最大を返す。
// 1 つのオクターブにエネルギーが固まる場(周期性)では、帯の中の比が大きく残る。
// 最大の 1/1000 未満のパワーしか持たないオクターブ(窓の漏れでしか埋まらない帯)は当てはめから
// 除く — 入れると両対数の直線がほぼ空の帯へ引かれて、傾きも比も読めない値になる。
// 残るオクターブが 3 つ未満のときは、全オクターブへ当てはめた形へ戻す(帯が狭い場を
// 検出できなくなることを避けるため)。
const PERIODICITY_FIT_FLOOR = 1e-3;

function periodicityStats(octaves) {
  const maxPower = Math.max(...octaves.map((octave) => octave.power));
  if (maxPower <= 0) return { fitSlope: null, maxExcessRatio: null, peakScaleKm: null };
  let valid = octaves.filter((octave) => octave.power >= maxPower * PERIODICITY_FIT_FLOOR);
  if (valid.length < 3) valid = octaves.filter((octave) => octave.power > 0);
  if (valid.length < 3) return { fitSlope: null, maxExcessRatio: null, peakScaleKm: null };
  const { slope, intercept } = fitLine(valid.map((octave) => [Math.log(octave.k0), Math.log(octave.power)]));
  let maxExcessRatio = 0;
  let peakScaleKm = null;
  for (const octave of valid) {
    const fitted = Math.exp(intercept + slope * Math.log(octave.k0));
    const ratio = octave.power / fitted;
    if (ratio > maxExcessRatio) {
      maxExcessRatio = ratio;
      peakScaleKm = octave.scaleKm;
    }
  }
  return { fitSlope: slope, maxExcessRatio, peakScaleKm };
}

// 形の回帰に使う塊の寸法 L = √面積 [km] の下限。数画素以下の塊は形が読めないので、
// 2 px 分の L(4 px²)か文献の検算区間の下端の 1 km の大きい方を下限にする。
function shapeFitMinKm(kmPerPx) {
  return Math.max(1, 2 * kmPerPx);
}

// 二値化した場の成分を、面の内側だけに限ったものと、componentStats の集計へ分ける。
// 面の縁に触れた塊(切れて写っている雲)は面積が欠け、外周に雲でない面の縁が混ざるので
// 回帰から外す。判定は前景の 1 px の縁で囲んだ場へもう一度 componentStats を掛け、
// 縁と合体しなかった成分を「面積がそのまま残っている」ことで拾う。
function interiorComponents(data, n, kmPerPx, threshold) {
  const rowA = new Float64Array(n).fill(kmPerPx);
  const stats = componentStats({ width: n, height: n, data }, threshold, false, rowA, kmPerPx);
  let topValue = -Infinity;
  for (const v of data) if (v > topValue) topValue = v;
  const m = n + 2;
  const padded = new Float32Array(m * m).fill(topValue + 1);
  for (let y = 0; y < n; y++) padded.set(data.subarray(y * n, y * n + n), (y + 1) * m + 1);
  const rowB = new Float64Array(m).fill(kmPerPx);
  const paddedStats = componentStats({ width: m, height: m, data: padded }, threshold, false, rowB, kmPerPx);
  const rest = new Map();
  for (const component of paddedStats.components) {
    rest.set(component.areaKm2, (rest.get(component.areaKm2) ?? 0) + 1);
  }
  const interior = [];
  for (const component of stats.components) {
    const count = rest.get(component.areaKm2) ?? 0;
    if (count > 0) {
      rest.set(component.areaKm2, count - 1);
      interior.push(component);
    }
  }
  return { stats, interior };
}

// 場を分位のしきいで二値化し、塊の寸法分布の冪 b と周長–面積の次元 D を返す。
// しきいは場面の分位 p50 + 0.3×(p99 − p50) — 晴れの底上げ(大気の霞など)を打ち消すため、
// 絶対値ではなく場面ごとの分布から取る。
// b は累積本数 N(≥L) ∝ L^−b の b(L = √面積 [km]、両対数の傾きを反転)。上限は設けず、
// 面の大きさそのものを上限とする。
// D は P ∝ (√A)^D = L^D の D(log P vs log L の回帰)。文献の検算区間(1〜100 km)に
// 合わせて L ≤ 100 km の塊だけを使う。
function shapeStats(data, n, kmPerPx) {
  const sorted = Float64Array.from(data).sort();
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  const p50 = at(0.5);
  const p99 = at(0.99);
  const threshold = p50 + 0.3 * (p99 - p50);
  const { stats, interior } = interiorComponents(data, n, kmPerPx, threshold);
  const minKm = shapeFitMinKm(kmPerPx);
  const inRange = (component) => Math.sqrt(component.areaKm2) >= minKm;
  const sizes = interior.map((component) => Math.sqrt(component.areaKm2))
    .filter((size) => size >= minKm)
    .sort((a, b) => a - b);
  const sizeExponent = sizes.length >= 8
    ? -fitLine(sizes.map((size, index) => [Math.log(size), Math.log(sizes.length - index)])).slope
    : null;
  const perimeterPairs = interior
    .filter((component) => inRange(component) && Math.sqrt(component.areaKm2) <= 100 && component.perimeterKm > 0)
    .map((component) => [Math.log(Math.sqrt(component.areaKm2)), Math.log(component.perimeterKm)]);
  const perimeterAreaDimension = perimeterPairs.length >= 8 ? fitLine(perimeterPairs).slope : null;
  return {
    threshold,
    cloudyShare: stats.cloudyShare,
    count: stats.count,
    interiorCount: interior.length,
    fitMinKm: minKm,
    sizeExponent,
    perimeterAreaDimension,
  };
}

// 構造テンソルの揃い度を当てる尺度 [km]。σ = scale/4 [px] が 1 px 未満になる尺度は
// 前ぼかしが効かず勾配が画素の粒を拾うので、外す(4×kmPerPx 未満の尺度は結果に入らない)。
const ANISOTROPY_SCALES_KM = [2, 5, 10, 20];

// 場の細部を 1 回で全部測る。field は { width, height, data: 線形輝度の配列 }、
// kmPerPx は 1 画素の地表距離 [km]。返り値は JSON 化できる素のオブジェクト。
export function measureCloudDetail(field, kmPerPx) {
  const n = cropSizeOf(field.width, field.height);
  const x0 = Math.floor((field.width - n) / 2);
  const y0 = Math.floor((field.height - n) / 2);
  const crop = cropField(field, x0, y0, n, n);

  const power = radialPower(crop.data, n);
  const betaPairs = [];
  // k = 1 は窓の直流まわりの漏れが支配するので、傾きの当てはめから外す。
  for (let k = 2; k <= n / 2; k++) {
    if (power[k] > 0) betaPairs.push([Math.log(k), Math.log(power[k])]);
  }
  const beta = betaPairs.length >= 2 ? -fitLine(betaPairs).slope : null;
  const octaves = octaveTable(power, n, kmPerPx);

  const rowKmPerPx = new Float64Array(n).fill(kmPerPx);
  const anisotropy = ANISOTROPY_SCALES_KM.filter((scale) => scale >= 4 * kmPerPx).map((scale) => ({
    scaleKm: scale,
    ...summarizeStructure(structureTensor(crop, rowKmPerPx, kmPerPx, false, scale), 0, 0, n, n),
  }));

  return {
    kmPerPx,
    cropSize: n,
    spectrum: { beta, octaves },
    intermittency: intermittencyStats(crop.data, n, kmPerPx),
    periodicity: periodicityStats(octaves),
    shapes: shapeStats(crop.data, n, kmPerPx),
    anisotropy,
  };
}
