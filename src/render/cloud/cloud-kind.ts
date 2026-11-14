// 雲の種類ごとの「量」と、そこから導く雲頂高度・鉛直柱光学深さ・不透明度の基準式。
// 量は 0..1 で、大きいほど雲頂が高く同時に不透明になる。量 0 はその種類の雲が無いことを
// 表す。曲線は種類の見えの違い(巻雲は高く薄い、積雲は低くてもほぼ不透明)を写す調整値で、
// ここにある式が CPU の基準。

// 積雲の雲頂高度の式が張る範囲 [m]。雲底 500 m(量 0)から圏界面を超える上端(量 1)までを
// 二乗で渡すので、低い雲が多く高い塔は少ない。
export const CUMULUS_BASE_ALTITUDE = 500;
export const CUMULUS_ALTITUDE_SPAN = 16500;
export const CUMULUS_TOP_ALTITUDE = CUMULUS_BASE_ALTITUDE + CUMULUS_ALTITUDE_SPAN;
// 積雲の鉛直柱光学深さの尺度(τ = 量 / この値)。量 0.24 で不透明度 ≈ 0.86 になる深さで、
// 低い積雲でも下地をほぼ隠し、縁と低い雲ではわずかに透ける幅に取る。
export const CUMULUS_OPTICAL_DEPTH_SCALE = 0.12;
export const CUMULUS_MAX_OPTICAL_DEPTH = 1 / CUMULUS_OPTICAL_DEPTH_SCALE;
// 量 1 のときの不透明度。不透明度から量へ戻すときの入力の上限でもある。
export const CUMULUS_MAX_OPACITY = 1 - Math.exp(-CUMULUS_MAX_OPTICAL_DEPTH);

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

// 積雲の量から鉛直柱光学深さ。
export function cumulusColumnOpticalDepth(amount: number): number {
  return amount / CUMULUS_OPTICAL_DEPTH_SCALE;
}

// 積雲の量から不透明度(1 − e^−τ)。
export function cumulusOpacity(amount: number): number {
  return 1 - Math.exp(-cumulusColumnOpticalDepth(amount));
}

// 積雲の雲頂高度 [m] から量。高度は式の張る範囲へ clamp する。
export function cumulusAmountFromTopAltitude(altitude: number): number {
  const t = (altitude - CUMULUS_BASE_ALTITUDE) / CUMULUS_ALTITUDE_SPAN;
  return Math.sqrt(Math.min(Math.max(t, 0), 1));
}

// 積雲の不透明度から量。不透明度は量 1 の値で頭打ちにする。
export function cumulusAmountFromOpacity(opacity: number): number {
  const bounded = Math.min(Math.max(opacity, 0), CUMULUS_MAX_OPACITY);
  return -CUMULUS_OPTICAL_DEPTH_SCALE * Math.log1p(-bounded);
}

// 巻雲の量から雲頂高度 [m]。
export function cirrusTopAltitude(amount: number): number {
  return CIRRUS_BOTTOM_ALTITUDE + CIRRUS_ALTITUDE_SPAN * amount;
}

// 巻雲の量から鉛直柱光学深さ。
export function cirrusColumnOpticalDepth(amount: number): number {
  return CIRRUS_MAX_OPTICAL_DEPTH * amount * amount;
}

// 巻雲の量から不透明度(1 − e^−τ)。
export function cirrusOpacity(amount: number): number {
  return 1 - Math.exp(-cirrusColumnOpticalDepth(amount));
}

// 巻雲の鉛直柱光学深さから量。光学深さは上限で頭打ちにする。
export function cirrusAmountFromOpticalDepth(opticalDepth: number): number {
  const t = opticalDepth / CIRRUS_MAX_OPTICAL_DEPTH;
  return Math.sqrt(Math.min(Math.max(t, 0), 1));
}
