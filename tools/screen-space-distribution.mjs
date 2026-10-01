// 近傍拡散補正の生の走査(均し・拡大の前の raw)の、seed についての画素ごとの分布の形と、その撮影ごとの表。パスごとの成分の和
// s = Σ_c q_c の冪和から画素ごとの歪度・尖度を求め、測る画素を |μ| の帯・μ_s の符号・窓で分けた分布の統計と、1 パスの誤差の
// 空間の相関 R(s) を出す。
import { fixed, table } from './screen-space-lab.mjs';

// 補正が 0 とみなす |μ| の上限。μ_s の符号の群から除く。
const ZERO_CORRECTION = 1e-6;
// 補正が 0 の所の σ を読む閾値(|μ| と σ の両方へ当てる)。
const QUIET_THRESHOLDS = [ZERO_CORRECTION, 1e-4];
// 傾きを測る |μ| の下限。
const SLOPE_FLOOR = 1e-4;
// |μ| の帯の境。
const BAND_EDGES = [0, 1e-6, 1e-4, 1e-3, 1e-2, 1e-1, Infinity];
// ΣV の占有を読む、V の大きい側からの画素の割合。
const TOP_FRACTIONS = [0.01, 0.1];
// 分布の群と、表での名前。
const GROUP_NAMES = { all: '全体', positive: 'μ_s > 0', negative: 'μ_s < 0' };

// ---- 画素ごとの形 ----

// 成分の和 s のパスごとの値の、原点 origin からのずれの 1〜4 乗の和 powerSums(どれも画素ごとに 1 つの Float64Array。
// passes パス分)の、q の尺度へ掛ける係数 scale での画素ごとの形 { mean, deviation, skewness, kurtosis }。mean は μ_s、
// deviation は不偏の標準偏差 σ_s、skewness は γ₁ = m₃/m₂^{3/2}、kurtosis は β₂ = m₄/m₂²(m_k は n で割る中心モーメント)。
// m₂ = 0 の画素の γ₁・β₂ は NaN。
export function shapeOf({ origin, powerSums }, scale, passes) {
  const count = origin.length;
  const [mean, deviation, skewness, kurtosis] = [0, 1, 2, 3].map(() => new Float64Array(count));
  for (let p = 0; p < count; p++) {
    const [a1, a2, a3, a4] = powerSums.map((sums) => sums[p] / passes);
    const m2 = Math.max(0, a2 - a1 * a1);
    const m3 = a3 - 3 * a1 * a2 + 2 * a1 ** 3;
    const m4 = a4 - 4 * a1 * a3 + 6 * a1 * a1 * a2 - 3 * a1 ** 4;
    mean[p] = scale * (origin[p] + a1);
    deviation[p] = scale * Math.sqrt(m2 * passes / (passes - 1));
    skewness[p] = m2 > 0 ? m3 / m2 ** 1.5 : NaN;
    kurtosis[p] = m2 > 0 ? m4 / (m2 * m2) : NaN;
  }
  return { mean, deviation, skewness, kurtosis };
}

// n 個の値の β₂ と |γ₁| の上限。1 つだけが外れた並びがとる。
export const kurtosisBoundOf = (n) => n - 2 + 1 / (n - 1);
const skewnessBoundOf = (n) => (n - 2) / Math.sqrt(n - 1);

// 画素ごとに rgb を並べた分散 variance の、画素 p の 3 成分の和。
export const varianceSumOf = (variance, p) => variance[3 * p] + variance[3 * p + 1] + variance[3 * p + 2];

// 候補の統計(画素ごとに rgb の平均 mean と不偏分散 variance、成分の和の形 shape)の画素 p の値。absMean は |μ| = Σ_c |μ_c|、
// sigma は σ = √(Σ_c V_c)。
function pixelOf({ mean, variance, shape }, p) {
  const varianceSum = varianceSumOf(variance, p);
  return {
    absMean: Math.abs(mean[3 * p]) + Math.abs(mean[3 * p + 1]) + Math.abs(mean[3 * p + 2]),
    varianceSum,
    sigma: Math.sqrt(varianceSum),
    sumMean: shape.mean[p],
    sumDeviation: shape.deviation[p],
    skewness: shape.skewness[p],
    kurtosis: shape.kurtosis[p],
  };
}

// ---- 分布の統計 ----

// 値の並び values の、小さい側から割合 fraction の位置の値。空なら undefined。
export function percentileOf(values, fraction) {
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}

// 値の並び values のうち有限のものの平均。無ければ NaN。
function finiteMeanOf(values) {
  const finite = values.filter(Number.isFinite);
  return finite.reduce((sum, v) => sum + v, 0) / finite.length;
}

// 点 (xs[i], ys[i]) の最小二乗の直線の傾き。
function slopeOf(xs, ys) {
  const [meanX, meanY] = [xs, ys].map((values) => values.reduce((sum, v) => sum + v, 0) / values.length);
  let [covariance, spread] = [0, 0];
  for (const [i, x] of xs.entries()) {
    covariance += (x - meanX) * (ys[i] - meanY);
    spread += (x - meanX) ** 2;
  }
  return covariance / spread;
}

// 画素の並び pixels(pixelOf)の分布の統計 { count, slope, bands, kurtosis, skewness, shares }。slope は log₁₀σ 対 log₁₀|μ| の
// 傾き(|μ| ≥ SLOPE_FLOOR かつ σ > 0 の画素)、bands は |μ| の帯(BAND_EDGES)ごとの { count, sigma, ratio }(σ と σ/|μ| の
// 中央値。|μ| が 0 を含む帯の ratio は null)、kurtosis は β₂ の [中央値, 99 百分位]、skewness は γ₁ の [1 百分位, 中央値,
// 99 百分位](どちらも定まる画素で)、shares は ΣV のうち V の大きい側から TOP_FRACTIONS の画素が占める割合。
function groupOf(pixels) {
  const sloped = pixels.filter((x) => x.absMean >= SLOPE_FLOOR && x.sigma > 0);
  const kurtoses = pixels.map((x) => x.kurtosis).filter(Number.isFinite);
  const skewnesses = pixels.map((x) => x.skewness).filter(Number.isFinite);
  const variances = Float64Array.from(pixels, (x) => x.varianceSum).sort().reverse();
  const total = variances.reduce((sum, v) => sum + v, 0);
  return {
    count: pixels.length,
    slope: slopeOf(sloped.map((x) => Math.log10(x.absMean)), sloped.map((x) => Math.log10(x.sigma))),
    bands: BAND_EDGES.slice(0, -1).map((low, i) => {
      const members = pixels.filter((x) => x.absMean >= low && x.absMean < BAND_EDGES[i + 1]);
      return {
        count: members.length,
        sigma: percentileOf(members.map((x) => x.sigma), 0.5),
        ratio: low === 0 ? null : percentileOf(members.map((x) => x.sigma / x.absMean), 0.5),
      };
    }),
    kurtosis: [0.5, 0.99].map((fraction) => percentileOf(kurtoses, fraction)),
    skewness: [0.01, 0.5, 0.99].map((fraction) => percentileOf(skewnesses, fraction)),
    shares: TOP_FRACTIONS.map((fraction) => (
      variances.subarray(0, Math.ceil(fraction * variances.length)).reduce((sum, v) => sum + v, 0) / total)),
  };
}

// 画素の並び pixels のうち |μ| < threshold の画素の数 count と、そのうち σ < threshold の割合 quietFraction と σ の最大
// maxSigma。
function quietOf(pixels, threshold) {
  const zeros = pixels.filter((x) => x.absMean < threshold);
  return {
    threshold,
    count: zeros.length,
    quietFraction: zeros.filter((x) => x.sigma < threshold).length / zeros.length,
    maxSigma: zeros.reduce((max, x) => Math.max(max, x.sigma), 0),
  };
}

// 窓の画素の並び pixels の数と、μ_s・σ_s・σ_s/|μ_s|・γ₁・β₂ の平均(定まる画素で)。
const windowOf = (pixels) => ({
  count: pixels.length,
  mean: finiteMeanOf(pixels.map((x) => x.sumMean)),
  deviation: finiteMeanOf(pixels.map((x) => x.sumDeviation)),
  ratio: finiteMeanOf(pixels.map((x) => x.sumDeviation / Math.abs(x.sumMean))),
  skewness: finiteMeanOf(pixels.map((x) => x.skewness)),
  kurtosis: finiteMeanOf(pixels.map((x) => x.kurtosis)),
});

// 候補の統計 statistics(mean・variance・shape。pixelOf)の分布 { groups, quiet, windows }。印 mask の立った画素を測る。
// groups は GROUP_NAMES の群ごとの groupOf(μ_s の符号の群は |μ| ≥ ZERO_CORRECTION の画素)、quiet は QUIET_THRESHOLDS
// ごとの quietOf、windows は窓の名前ごとの走査の画素の番号の並び windowPixels の windowOf(windowPixels が null なら null)。
export function distributionOf(statistics, mask, windowPixels) {
  const measured = Array.from(mask.keys()).filter((p) => mask[p]).map((p) => pixelOf(statistics, p));
  const signed = (sign) => measured.filter((x) => x.absMean >= ZERO_CORRECTION && Math.sign(x.sumMean) === sign);
  return {
    groups: { all: groupOf(measured), positive: groupOf(signed(1)), negative: groupOf(signed(-1)) },
    quiet: QUIET_THRESHOLDS.map((threshold) => quietOf(measured, threshold)),
    windows: windowPixels === null ? null : Object.fromEntries(Object.entries(windowPixels).map(
      ([name, pixels]) => [name, windowOf(pixels.map((p) => pixelOf(statistics, p)))])),
  };
}

// 1 パスの補正の平面の組(R・G・B)の並び samples の、全パスの平均 mean(画素ごとに rgb)との差 X_k − μ の帯ごとの R(s) を、
// パスについて平均した並び(lab.errorScales の順)。印 mask の立った width × height の画素で測る。lab は withLab の口。
export async function errorCorrelationOf(lab, samples, mean, mask, width, height) {
  const reference = [0, 1, 2].map((c) => Float32Array.from({ length: width * height }, (_, p) => mean[3 * p + c]));
  const rs = [];
  for (const sample of samples) rs.push((await lab.errorMetrics(sample, reference, mask, width, height)).r);
  return rs[0].map((_, j) => rs.reduce((sum, r) => sum + r[j], 0) / rs.length);
}

// ---- 表 ----

// 有効数字 3 桁の指数表記の文字列。測れなかった値は —。
export const exponential = (v) => (Number.isFinite(v) ? v.toExponential(2) : '—');

// 閾値 v の表の文字列(1e-6 の形)。
const thresholdText = (v) => v.toExponential(0);
// 割合 v の、小数 digits 桁の百分率の文字列。測れなかった値は —。
const percentText = (v, digits) => (Number.isFinite(v) ? `${fixed(100 * v, digits)}%` : '—');

// |μ| の帯の見出し。
const BAND_LABELS = BAND_EDGES.slice(0, -1).map((low, i) => {
  const high = BAND_EDGES[i + 1];
  if (low === 0) return `< ${thresholdText(high)}`;
  return high === Infinity ? `≥ ${thresholdText(low)}` : `${thresholdText(low)}〜${thresholdText(high)}`;
});

// passes パスの分布の表の記号と読み方。
export function distributionNotesOf(passes) {
  return [
    '分布の形は、パスごとの s = Σ_c q_c(R(s) のスケール s とは別)の画素ごとの平均 μ_s・不偏の標準偏差 σ_s・',
    '歪度 γ₁ = m₃/m₂^{3/2}・尖度 β₂ = m₄/m₂²(m_k は n で割る中心モーメント。正規分布で γ₁ = 0・β₂ = 3)。',
    '|μ| = Σ_c |μ_c|、σ = √(Σ_c V_c)。群は、全体 = 測る画素、μ_s > 0(照り返しが支配)・μ_s < 0(遮蔽が支配)=',
    `|μ| ≥ ${thresholdText(ZERO_CORRECTION)} の測る画素。傾きは |μ| ≥ ${thresholdText(SLOPE_FLOOR)} かつ σ > 0 の画素の`,
    'log₁₀σ 対 log₁₀|μ| の最小二乗。γ₁・β₂ の統計は σ_s > 0 の画素で読む。', '',
    `**n = ${passes} パスでは β₂ ≤ n − 2 + 1/(n − 1) = ${fixed(kurtosisBoundOf(passes), 2)}、`
      + `|γ₁| ≤ (n − 2)/√(n − 1) = ${fixed(skewnessBoundOf(passes), 2)}**(1 パスだけが外れた画素がとる値)。`,
    '百分位がこれに近いなら、裾は n パスで測れる重さを超えている。', '',
    '窓は bay の既定の構図の画素(5×5 の全解像度の窓に、読む G バッファの画素が落ちる走査の画素)で、カメラを動かした撮影では',
    '別の所を指す。R(s) は 1 パスの補正 X_k と全パスの平均 μ の差の、走査の解像度での帯ごとの R(s)(k = 0・1 の平均。',
    '1 は正直な雑音、下はブルーノイズ、上は雑音で説明できない構造)。',
  ];
}

// 撮影の候補ごとの分布 distributions(label ごとの distributionOf に R(s) の並び r を足したもの)の表。labels は候補の順、
// scales は R(s) のスケール [走査の画素] の並び。
export function distributionTablesOf(distributions, labels, scales) {
  const groupRows = (cellsOf) => labels.flatMap((label) => Object.entries(GROUP_NAMES).map(
    ([group, name]) => [label, name, ...cellsOf(distributions[label].groups[group])]));
  const windowNames = Object.keys(distributions[labels[0]].windows ?? {});
  return [
    '', '#### 分布の形', '',
    ...table(['候補', '群', '画素', '傾き', 'β₂ 中央値', 'β₂ p99', 'γ₁ p1', 'γ₁ 中央値', 'γ₁ p99', 'ΣV 上位 1% / 10%'],
      groupRows(({ count, slope, kurtosis, skewness, shares }) => [
        count, fixed(slope, 2), ...kurtosis.map((v) => fixed(v, 1)), ...skewness.map((v) => fixed(v, 2)),
        shares.map((v) => percentText(v, 0)).join(' / '),
      ])),
    '', '#### |μ| の帯(画素 / σ の中央値 / σ/|μ| の中央値)', '',
    ...table(['候補', '群', ...BAND_LABELS],
      groupRows(({ bands }) => bands.map((b) => `${b.count} / ${exponential(b.sigma)} / ${fixed(b.ratio, 2)}`))),
    '', '#### 補正が 0 の所', '',
    ...table(
      ['候補', ...QUIET_THRESHOLDS.map(thresholdText).flatMap(
        (t) => [`\\|μ\\| < ${t} の画素`, `うち σ < ${t}`, 'その σ の最大'])],
      labels.map((label) => [label, ...distributions[label].quiet.flatMap(({ count, quietFraction, maxSigma }) => [
        count, percentText(quietFraction, 1), exponential(maxSigma)])]),
    ),
    ...(windowNames.length === 0 ? [] : [
      '', '#### 窓', '',
      ...table(['候補', '窓', '走査の画素', 'μ_s', 'σ_s', 'σ_s/\\|μ_s\\|', 'γ₁', 'β₂'],
        labels.flatMap((label) => windowNames.map((name) => {
          const w = distributions[label].windows[name];
          return [label, name, w.count, exponential(w.mean), exponential(w.deviation), fixed(w.ratio, 2),
            fixed(w.skewness, 2), fixed(w.kurtosis, 1)];
        }))),
    ]),
    '', '#### 1 パスの誤差 X_k − μ の R(s)', '',
    ...table(['候補', ...scales.map((s) => `${s} px`)],
      labels.map((label) => [label, ...distributions[label].r.map((v) => fixed(v, 3))])),
  ];
}
