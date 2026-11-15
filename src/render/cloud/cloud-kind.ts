// 雲の種類ごとの「量」と、そこから導く雲頂高度・覆いの密度・雲の中の光学的厚みの基準式。
// 量は 0..1 で、大きいほど雲頂が高く同時に不透明になる。量 0 はその種類の雲が無いことを
// 表す。曲線は種類の見えの違い(巻雲は高く薄い、積雲は低くてもほぼ不透明)を写す調整値で、
// ここにある式が CPU の基準。
//
// 積雲は「覆う割合」と「雲の中の光学的厚み」という 2 つの量へ写る — 取り違えないこと。
// 覆う割合は千切れた雲が texel を占める割合(点描の密度)で、柱の中の厚み τ_in は
// 雲の白さと雲を抜ける光の量を決める別の量。

// 積雲の雲頂高度の式が張る範囲 [m]。雲底 500 m(量 0)から圏界面を超える上端(量 1)までを
// 二乗で渡すので、低い雲が多く高い塔は少ない。
export const CUMULUS_BASE_ALTITUDE = 500;
export const CUMULUS_ALTITUDE_SPAN = 16500;
export const CUMULUS_TOP_ALTITUDE = CUMULUS_BASE_ALTITUDE + CUMULUS_ALTITUDE_SPAN;
// 積雲の覆いの深さの尺度(覆いの深さ = 量 / この値)。覆う割合 1 − e^−x の肩を作る密度で、
// 量 0.24 で覆う割合 ≈ 0.86 — 低い積雲でも下地をほぼ隠し、縁と低い雲ではわずかに透ける幅に取る。
export const CUMULUS_COVERING_DEPTH_SCALE = 0.12;
export const CUMULUS_MAX_COVERING_DEPTH = 1 / CUMULUS_COVERING_DEPTH_SCALE;
// 量 1 のときの覆う割合(不透明度)。不透明度から量へ戻すときの入力の上限でもある。
export const CUMULUS_MAX_OPACITY = 1 - Math.exp(-CUMULUS_MAX_COVERING_DEPTH);
// 積雲の柱の中の光学的厚み τ_in = k·H^(5/3) の係数 [m^(−5/3)]。断熱的な雲では液水量が
// 雲底からの高さに比例して増えるので、柱の光学的厚みは雲の幾何学的厚み H の 5/3 乗に伸びる。
// H = 300 m で τ ≈ 8、1 km で τ ≈ 60 となる値から採った推定値。
export const CUMULUS_IN_CLOUD_DEPTH_COEFFICIENT = 6.0e-4;

// 巻雲の雲頂高度の式が張る範囲 [m]。量に比例して下端 9 km から上端 13 km までを渡す —
// 積雲より高く、高度幅は狭い。
export const CIRRUS_BOTTOM_ALTITUDE = 9000;
export const CIRRUS_ALTITUDE_SPAN = 4000;
export const CIRRUS_TOP_ALTITUDE = CIRRUS_BOTTOM_ALTITUDE + CIRRUS_ALTITUDE_SPAN;
// 巻雲の鉛直柱光学深さの上限(量 1)。τ = この値 × 量² で、薄い靄から下地をほとんど隠す幕まで
// 連続する。
export const CIRRUS_MAX_OPTICAL_DEPTH = 3;

// 積雲の量から雲頂高度 [m]。
export function cumulusTopAltitude(amount: number): number {
  return CUMULUS_BASE_ALTITUDE + CUMULUS_ALTITUDE_SPAN * amount * amount;
}

// 積雲の量から覆いの深さ。覆う割合 1 − e^−x の肩を作る密度であって、雲の中の光学的厚みとは別の量。
export function cumulusCoveringDepth(amount: number): number {
  return amount / CUMULUS_COVERING_DEPTH_SCALE;
}

// 積雲の量から覆う割合(不透明度 = 点描の密度)。
export function cumulusOpacity(amount: number): number {
  return 1 - Math.exp(-cumulusCoveringDepth(amount));
}

// 積雲の雲頂高度 [m] から、雲の柱の中の光学的厚み τ_in。幾何学的厚みは雲頂と雲底
// (CUMULUS_BASE_ALTITUDE)の差。雲の白さと雲を抜ける光はここから出す。
export function cumulusInCloudOpticalDepth(cloudTopAltitude: number): number {
  const thickness = Math.max(cloudTopAltitude - CUMULUS_BASE_ALTITUDE, 0);
  return CUMULUS_IN_CLOUD_DEPTH_COEFFICIENT * thickness ** (5 / 3);
}

// 積雲の雲頂高度 [m] から量。高度は式の張る範囲へ clamp する。
export function cumulusAmountFromTopAltitude(altitude: number): number {
  const t = (altitude - CUMULUS_BASE_ALTITUDE) / CUMULUS_ALTITUDE_SPAN;
  return Math.sqrt(Math.min(Math.max(t, 0), 1));
}

// 積雲の覆う割合(不透明度)から量。覆う割合は量 1 の値で頭打ちにする。
export function cumulusAmountFromOpacity(opacity: number): number {
  const bounded = Math.min(Math.max(opacity, 0), CUMULUS_MAX_OPACITY);
  return -CUMULUS_COVERING_DEPTH_SCALE * Math.log1p(-bounded);
}

// 巻雲の量から雲頂高度 [m]。
export function cirrusTopAltitude(amount: number): number {
  return CIRRUS_BOTTOM_ALTITUDE + CIRRUS_ALTITUDE_SPAN * amount;
}

// 巻雲の量から鉛直柱光学深さ。巻雲は覆う割合ではなく、層そのものの厚みを持つ。
export function cirrusColumnOpticalDepth(amount: number): number {
  return CIRRUS_MAX_OPTICAL_DEPTH * amount * amount;
}

// 巻雲の鉛直柱光学深さから量。光学深さは上限で頭打ちにする。
export function cirrusAmountFromOpticalDepth(opticalDepth: number): number {
  const t = opticalDepth / CIRRUS_MAX_OPTICAL_DEPTH;
  return Math.sqrt(Math.min(Math.max(t, 0), 1));
}
