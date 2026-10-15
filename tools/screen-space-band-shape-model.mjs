// 帯への振り分けの重みの形を、帯の鎖の 1 次元の写しに通して比べる机上の模型(手順11.5B)。源を 1 つ置き、源から画面距離 ρ の
// 受け手の寄与 m(ρ) を形ごとの重みで帯へ分けて鎖に通し、均した和と均す前の差を、源からの距離の区間ごとに書く。
// 鎖は band-pyramid.ts の写し — 縮小は 2 画素の平均、合流は floor(p/2) を中心とする [1, 2, 1]/4 の親で、混合比 α = 1
// (8-15 の帯ごとの広がりの導出と同じ)。面は源の片側(壁の前の床)にだけある。雑音・最後の拡大・帯座標の因子 c・d は入れない。
// 使い方: node tools/screen-space-band-shape-model.mjs [<形>@<κ> ...] [--band0-tent]
//   形は linear(いまの両隣への線形)、scaled<γ>(線形のまま座標を γ·log2(κρ) にした対照)、bspline(2 次の B スプライン)、
//   triangle(線形の ρ で対称な三角)、gamma<n>(山形 (u·e^{1−u})^n、u = ρ/d_k)。省くと計画書の手順11.5B の表の組。
//   --band0-tent は帯 0 にだけ段 0 で [1, 2, 1]/4 を掛ける。
import { parseArgs } from 'node:util';

const BAND_COUNT = 6;
const LAST_BAND = BAND_COUNT - 1;
const PIXELS = 512;
// 源の位置を、最も粗い段のブロックに対してずらす数。結果はずらし方で平均する。
const PHASES = 64;
// 誤差を集計する源からの距離の区間 [走査の画素]と、実効の均しの幅を書く距離。
const DISTANCE_BINS = [[0, 1], [2, 3], [4, 6], [7, 11], [12, 20], [21, 40], [41, 80]];
const SPREAD_DISTANCES = [1, 16, 64];
const DEFAULT_ENTRIES = [
  'linear@0.38', 'scaled0.85@0.44', 'bspline@0.38', 'triangle@0.19',
  'gamma2@0.19', 'gamma3@0.19', 'gamma4@0.23', 'gamma6@0.28',
];

const falloff = (rho) => Math.max(0, 1 - (rho / 100) ** 2);
// 源から距離 rho の受け手が受ける寄与。細い柱(高さ 3 画素)は源から急に落ち、高い壁(真上から見て、どの高さも同じ距離に
// 写る)はほぼ平ら。
const PROFILES = {
  pole: (rho) => (2 / Math.PI) * Math.atan(3 / rho) * falloff(rho),
  wall: (rho) => (2 / Math.PI) * Math.atan(40 / rho) * falloff(rho),
};

const hat = (x) => Math.max(0, 1 - Math.abs(x));
const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
const perBand = (weight) => Array.from({ length: BAND_COUNT }, (_, band) => weight(band));
const normalized = (values) => {
  const sum = values.reduce((a, b) => a + b, 0);
  return values.map((value) => value / sum);
};

function quadraticBSpline(x) {
  const magnitude = Math.abs(x);
  if (magnitude < 0.5) return 0.75 - magnitude * magnitude;
  if (magnitude < 1.5) return 0.5 * (1.5 - magnitude) ** 2;
  return 0;
}

// 形 shape と尺度 κ の、画面距離 rho の寄与の帯ごとの重み(和は 1)を返す関数。
function weightsOf(shape, kappa) {
  const peak = (band) => 2 ** band / kappa;
  const coordinate = (rho, scale) => clamp(scale * Math.log2(kappa * rho), 0, LAST_BAND);
  const scaled = /^scaled([\d.]+)$/.exec(shape);
  if (shape === 'linear' || scaled) {
    const scale = scaled ? Number(scaled[1]) : 1;
    return (rho) => perBand((band) => hat(coordinate(rho, scale) - band));
  }
  if (shape === 'bspline') {
    return (rho) => {
      const c = coordinate(rho, 1);
      const weights = perBand((band) => quadraticBSpline(c - band));
      // 端の外へ出た重みは端の帯へ畳む。
      weights[0] += quadraticBSpline(c + 1);
      weights[LAST_BAND] += quadraticBSpline(c - BAND_COUNT);
      return weights;
    };
  }
  // 帯 0 は d_0 より近く、最後の帯は d_{L−1} より遠くを 1 で受け持つ。
  if (shape === 'triangle') {
    return (rho) => normalized(perBand((band) => {
      if ((band === 0 && rho <= peak(0)) || (band === LAST_BAND && rho >= peak(LAST_BAND))) return 1;
      return hat(rho / peak(band) - 1);
    }));
  }
  const gamma = /^gamma(\d+)$/.exec(shape);
  if (gamma) {
    const order = Number(gamma[1]);
    return (rho) => normalized(perBand((band) => {
      const u = rho / peak(band);
      if (band === LAST_BAND && u >= 1) return 1;
      return (u * Math.exp(1 - u)) ** order;
    }));
  }
  throw new Error(`unknown shape: ${shape}`);
}

// 段 0 の帯 bands[k][x] と面の有無 surface[x] を縮小した、段 m の帯 levels[m].bands[k][p] と面の有無。
function reducedLevels(bands, surface) {
  const levels = [{ bands, surface }];
  for (let level = 1; level < BAND_COUNT; level++) {
    const finer = levels[level - 1];
    const size = PIXELS >> level;
    const reduced = { bands: perBand(() => new Float64Array(size)), surface: new Uint8Array(size) };
    for (let p = 0; p < size; p++) {
      const [a, b] = [2 * p, 2 * p + 1];
      const count = finer.surface[a] + finer.surface[b];
      if (count === 0) continue;
      reduced.surface[p] = 1;
      for (let band = level; band < BAND_COUNT; band++) {
        reduced.bands[band][p] = (finer.surface[a] * finer.bands[band][a] + finer.surface[b] * finer.bands[band][b]) / count;
      }
    }
    levels.push(reduced);
  }
  return levels;
}

// 段 level の画素 p のまわりで、面のある画素だけを重み taps で平均する。sample(q) は段の画素 q の値。
function averageOver(surface, center, taps, sample) {
  let weightSum = 0;
  let sum = 0;
  for (const [offset, weight] of taps) {
    const q = center + offset;
    if (q < 0 || q >= surface.length || !surface[q]) continue;
    weightSum += weight;
    sum += weight * sample(q);
  }
  return weightSum > 0 ? sum / weightSum : 0;
}

const TENT = [[-1, 0.25], [0, 0.5], [1, 0.25]];

// 段 0 の帯を鎖に通した、段 0 の補正。band0Tent なら帯 0 にも段 0 で TENT を掛ける。
function chain(bands, surface, band0Tent) {
  const levels = reducedLevels(bands, surface);
  let coarse = Float64Array.from(levels[LAST_BAND].bands[LAST_BAND]);
  for (let level = LAST_BAND - 1; level >= 0; level--) {
    const { bands: own, surface: ownSurface } = levels[level];
    const parentSurface = levels[level + 1].surface;
    const merged = new Float64Array(ownSurface.length);
    for (let p = 0; p < ownSurface.length; p++) {
      if (!ownSurface[p]) continue;
      const direct = level === 0 && band0Tent
        ? averageOver(ownSurface, p, TENT, (q) => own[0][q])
        : own[level][p];
      merged[p] = direct + averageOver(parentSurface, p >> 1, TENT, (q) => coarse[q]);
    }
    coarse = merged;
  }
  return coarse;
}

// 帯ごとの実効の均しの分散 σ_k²(帯 k だけに 1 画素のインパルスを入れた応答の分散を、位置で平均)。
function bandVariances(band0Tent) {
  return perBand((band) => {
    let total = 0;
    for (let phase = 0; phase < PHASES; phase++) {
      const origin = PIXELS / 2 + phase;
      const bands = perBand(() => new Float64Array(PIXELS));
      bands[band][origin] = 1;
      const response = chain(bands, new Uint8Array(PIXELS).fill(1), band0Tent);
      let sum = 0, first = 0, second = 0;
      response.forEach((value, x) => { sum += value; first += value * (x - origin); second += value * (x - origin) ** 2; });
      total += second / sum - (first / sum) ** 2;
    }
    return total / PHASES;
  });
}

// 寄与 profile を weights で帯へ分けて鎖に通した、距離の区間ごとの相対誤差・平均距離の相対の動き・誤差の RMS。
function simulate(weights, profile, band0Tent) {
  const error = new Float64Array(DISTANCE_BINS.at(-1)[1] + 1);
  const truth = new Float64Array(error.length);
  let outputMoment = 0, outputSum = 0, truthMoment = 0, truthSum = 0, squaredError = 0;
  for (let phase = 0; phase < PHASES; phase++) {
    const source = PIXELS / 2 + phase + 0.5;
    const bands = perBand(() => new Float64Array(PIXELS));
    const surface = new Uint8Array(PIXELS);
    const contribution = new Float64Array(PIXELS);
    for (let x = Math.ceil(source); x < PIXELS; x++) {
      const rho = x - source;
      surface[x] = 1;
      contribution[x] = profile(rho);
      weights(rho).forEach((weight, band) => { bands[band][x] = weight * contribution[x]; });
    }
    const output = chain(bands, surface, band0Tent);
    for (let x = Math.ceil(source); x < PIXELS; x++) {
      const rho = x - source;
      const bin = Math.floor(rho);
      if (bin < error.length) { error[bin] += output[x] - contribution[x]; truth[bin] += contribution[x]; }
      outputMoment += output[x] * rho; outputSum += output[x];
      truthMoment += contribution[x] * rho; truthSum += contribution[x];
      squaredError += (output[x] - contribution[x]) ** 2;
    }
  }
  const relative = ([lo, hi]) => {
    let e = 0, t = 0;
    for (let i = lo; i <= hi; i++) { e += error[i]; t += truth[i]; }
    return e / t;
  };
  return {
    bins: DISTANCE_BINS.map(relative),
    shift: (outputMoment / outputSum) / (truthMoment / truthSum) - 1,
    rms: Math.sqrt(squaredError / PHASES),
  };
}

const { positionals, values: options } = parseArgs({
  allowPositionals: true, options: { 'band0-tent': { type: 'boolean', default: false } },
});
const band0Tent = options['band0-tent'];
const entries = (positionals.length > 0 ? positionals : DEFAULT_ENTRIES).map((entry) => {
  const [shape, kappa] = entry.split('@');
  return { label: entry, weights: weightsOf(shape, Number(kappa)) };
});
const variances = bandVariances(band0Tent);
const percent = (value) => (value * 100).toFixed(1).padStart(7);
const labelWidth = Math.max(...entries.map(({ label }) => label.length)) + 2;

console.log(`帯ごとの広がり σ_k [走査の画素]: ${variances.map((v) => Math.sqrt(v).toFixed(2)).join(' ')}`);
console.log(`\n実効の均しの幅 √S = √(Σ w_k σ_k²) [走査の画素](距離 ${SPREAD_DISTANCES.join(' / ')})`);
for (const { label, weights } of entries) {
  const spreads = SPREAD_DISTANCES.map((rho) => Math.sqrt(weights(rho).reduce((s, w, band) => s + w * variances[band], 0)));
  console.log(label.padEnd(labelWidth) + spreads.map((s) => s.toFixed(2).padStart(7)).join(''));
}
for (const [name, profile] of Object.entries(PROFILES)) {
  const header = DISTANCE_BINS.map(([lo, hi]) => `${lo}-${hi}`.padStart(7)).join('');
  console.log(`\n${name}: 距離の区間ごとの相対誤差 [%]、平均距離の動き、誤差の RMS\n${' '.repeat(labelWidth)}${header}`);
  for (const { label, weights } of entries) {
    const { bins, shift, rms } = simulate(weights, profile, band0Tent);
    console.log(`${label.padEnd(labelWidth)}${bins.map(percent).join('')}   ${percent(shift)}   ${rms.toFixed(4)}`);
  }
}
