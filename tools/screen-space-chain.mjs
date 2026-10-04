// 近傍拡散補正の、最後の拡大の前の補正 C_0(帯の縮小と拡大と合流の鎖の出力。帯に分けない段では raw)の、帯に分けない候補 A
// に対する恒等からのずれと揺れの量。画素ごとの量と撮影ごとの行、目で見る画像の色、表と説明の行を組む。統計は画素ごとに rgb を
// 並べた { mean, variance, halves }(全パスの平均・不偏分散・偶数番目と奇数番目のパスの平均の組)で受ける。
import { percentileOf, varianceSumOf } from './screen-space-distribution.mjs';
import { fixed, maskedMeanOf, ratioColorOf, table } from './screen-space-lab.mjs';

// 段の格子の変調を集める周期 [走査の画素](段 1〜3 のブロックの幅)。
const PERIODS = [2, 4, 8];
// 揺れ s の見込み p に対する比が、揺れが下がらない画素とみなす下限。
const STD_RATIO_LIMIT = 2;
// 画像の尺度 — std.png の白に当たる s(全撮影・全候補で共通)と、std-ratio.png の ±1 に当たる log2(s/p)。
const SIGMA_WHITE = 0.2;
const STD_RATIO_OCTAVES = 1;

// 候補の C_0 の統計 c0 の、A の C_0 の統計 baseline に対する画素ごとの量 { deviation, floor, std, expected }。bands は候補の
// 帯ごとの統計(帯 0 から)、mask は測る画素の印、width × height は走査の解像度。deviation は恒等からのずれ
// d = μ(C_0) − μ_A(C_0)、floor は偶数番目と奇数番目のパスでそれぞれ求めた d の差の半分(どちらも画素ごとに rgb)、std は揺れ
// s = √(Σ_c V_c(C_0))、expected はその見込み p(expectedStdOf)。
export function chainPlanesOf(c0, baseline, bands, mask, width, height) {
  const [even, odd] = [0, 1].map((h) => c0.halves[h].map((v, i) => v - baseline.halves[h][i]));
  return {
    deviation: c0.mean.map((v, i) => v - baseline.mean[i]),
    floor: even.map((v, i) => (v - odd[i]) / 2),
    std: Float64Array.from({ length: width * height }, (_, p) => Math.sqrt(varianceSumOf(c0.variance, p))),
    expected: expectedStdOf(bands, mask, width, height),
  };
}

// 帯ごとの統計 bands の V_ℓ(Σ_c V_c)からの、C_0 の 1 画素の揺れの見込み p = √(V_0 + Σ_{ℓ≥1} box_ℓ(V_ℓ) / 4^ℓ)。box_ℓ は
// 走査の 2^ℓ 画素四方の整列したブロックの、印 mask の立った画素での平均。帯の間と画素の間を独立とみなす。
function expectedStdOf(bands, mask, width, height) {
  const sumOf = (band) => Float64Array.from({ length: width * height }, (_, p) => varianceSumOf(band.variance, p));
  const variance = sumOf(bands[0]);
  for (let level = 1; level < bands.length; level++) {
    const block = 2 ** level;
    const boxed = blockMeansOf(sumOf(bands[level]), mask, width, height, block);
    for (let p = 0; p < variance.length; p++) variance[p] += boxed[p] / (block * block);
  }
  return variance.map(Math.sqrt);
}

// 画素ごとの値 values を、block 画素四方の整列したブロックの中の印 mask の立った画素で平均し、ブロックの画素ごとに並べた
// もの。印の立った画素の無いブロックは 0。
function blockMeansOf(values, mask, width, height, block) {
  const columns = Math.ceil(width / block);
  const sums = new Float64Array(columns * Math.ceil(height / block));
  const counts = new Float64Array(sums.length);
  const blockOf = (p) => Math.floor(Math.floor(p / width) / block) * columns + Math.floor((p % width) / block);
  for (let p = 0; p < values.length; p++) {
    if (!mask[p]) continue;
    sums[blockOf(p)] += values[p];
    counts[blockOf(p)]++;
  }
  return values.map((_, p) => (counts[blockOf(p)] > 0 ? sums[blockOf(p)] / counts[blockOf(p)] : 0));
}

// 画素ごとの値 values の、印 mask の立った画素での平均を、走査の画素の座標を period で割った余りの組ごとに集めた
// 最大 / 最小(段の周期の格子の変調。1 に近いほど格子が無い)。
function modulationOf(values, mask, width, period) {
  const sums = new Float64Array(period * period);
  const counts = new Float64Array(period * period);
  for (let p = 0; p < values.length; p++) {
    if (!mask[p]) continue;
    const cell = (Math.floor(p / width) % period) * period + (p % width) % period;
    sums[cell] += values[p];
    counts[cell]++;
  }
  const means = Array.from(sums, (sum, cell) => sum / counts[cell]).filter(Number.isFinite);
  return Math.max(...means) / Math.min(...means);
}

// 画素ごとに rgb を並べた values の、画素ごとの長さ √(Σ_c v_c²)。
const pixelNormsOf = (values) => Float64Array.from(
  { length: values.length / 3 }, (_, p) => Math.hypot(values[3 * p], values[3 * p + 1], values[3 * p + 2]));

// 画素ごとの量 chain(chainPlanesOf)の、印 mask の立った画素での行 { deviationRatio, floorRatio, deviationModulation,
// stdRatioMedian, stdRatio95, stdRatioOverLimit, stdModulation, windowRatio }。比の分母 referenceRms は A の μ の RMS、
// 変調は PERIODS の順、windowRatio は候補の窓の比(無ければ null)。
export function chainRowOf({ deviation, floor, std, expected }, mask, width, referenceRms, windowRatio) {
  const rms = (values) => Math.sqrt(maskedMeanOf(values.map((v) => v * v), mask));
  const ratios = Array.from(mask.keys()).filter((p) => mask[p] && expected[p] > 0).map((p) => std[p] / expected[p]);
  const deviationNorms = pixelNormsOf(deviation);
  return {
    deviationRatio: rms(deviation) / referenceRms,
    floorRatio: rms(floor) / referenceRms,
    deviationModulation: PERIODS.map((period) => modulationOf(deviationNorms, mask, width, period)),
    stdRatioMedian: percentileOf(ratios, 0.5),
    stdRatio95: percentileOf(ratios, 0.95),
    stdRatioOverLimit: ratios.filter((r) => r > STD_RATIO_LIMIT).length / ratios.length,
    stdModulation: PERIODS.map((period) => modulationOf(std, mask, width, period)),
    windowRatio,
  };
}

// C_0 の揺れの画像の、名前から走査の画素 p ごとの色(rgb、0..1)への表。chain は C_0 の画素ごとの量。std は s / SIGMA_WHITE の
// 灰色、std-ratio は log2(s / p) を ±STD_RATIO_OCTAVES で青〜灰〜赤。
export function chainColorsOf(chain) {
  return {
    std: (p) => Array(3).fill(chain.std[p] / SIGMA_WHITE),
    'std-ratio': (p) => ratioColorOf(chain.std[p], chain.expected[p], 0, STD_RATIO_OCTAVES),
  };
}

// 撮影の C_0 の行 chains(候補の label ごと。labels の先頭が A)の表の行。窓の比を持つ撮影では、A との差の列も出す。
export function chainTableOf(labels, chains) {
  const baseRatio = chains[labels[0]].windowRatio;
  const modulation = (values) => values.map((v) => fixed(v, 2)).join(' / ');
  return [
    '', `#### C_0(最後の拡大の前の補正)${baseRatio === null ? '' : `。A の窓の比 P_in / P_out = ${fixed(baseRatio, 3)}`}`, '',
    ...table([
      '候補', 'RMS(d) / RMS(μ_A)', '床', `|d| の変調 ${PERIODS.join('/')}`, 's/p 中央値', 's/p 95%', `s/p > ${STD_RATIO_LIMIT}`,
      `s の変調 ${PERIODS.join('/')}`, ...(baseRatio === null ? [] : ['窓の比', '窓の比 − A']),
    ], labels.map((label) => {
      const row = chains[label];
      return [
        label, fixed(row.deviationRatio, 4), fixed(row.floorRatio, 4), modulation(row.deviationModulation),
        fixed(row.stdRatioMedian, 3), fixed(row.stdRatio95, 3), fixed(row.stdRatioOverLimit, 4), modulation(row.stdModulation),
        ...(baseRatio === null ? [] : [fixed(row.windowRatio, 3), fixed(row.windowRatio - baseRatio, 3)]),
      ];
    })),
  ];
}

// 表の読み方の行。
export const CHAIN_NOTES = [
  'C_0 は最後の拡大の前の補正(帯に分けない候補は raw)。d = μ(C_0) − μ_A(C_0) は恒等からのずれで、RMS の比の分母は μ_A の RMS、',
  '床は偶数番目と奇数番目のパスでそれぞれ求めた d の差の半分の RMS(同じ分母)。変調は |d| や s の測る画素での平均を、走査の',
  `画素の座標を周期 ${PERIODS.join('・')} で割った余りの組ごとに集めた最大 / 最小(1 に近いほど段の格子が無い)。s = √(Σ_c V_c(C_0))、`,
  '見込み p = √(V_0 + Σ_{ℓ≥1} box_ℓ(V_ℓ) / 4^ℓ)(V_ℓ はその候補の帯 ℓ の V、box_ℓ は走査の 2^ℓ 画素四方の整列したブロックの平均。',
  '帯の間を独立とみなす)。窓の比は bay の系の撮影の拡散照度の全パスの平均の P_in / P_out。',
];

// 保存した画像の説明の行。
export const CHAIN_IMAGE_NOTES = [
  `- \`<撮影>.<候補>.std.png\` — s / ${SIGMA_WHITE} の灰色。\`std-ratio.png\` — log2(s / p) を ±${STD_RATIO_OCTAVES} で青〜灰〜赤。`,
  '  印の外は濃い青。',
];
