// 被覆率を、形として描く不透明な雲と、下地を白ませる半透明な雲へ分ける規則。解像できる細部が
// あるほど不透明な形が受け持ち、残りを半透明が受け持つので、同じ空の平均の被覆は見る距離によらない。
// GPU の式(CloudShapeEvaluator)と同じ定数・同じ式を持つ CPU 側の基準。

// 細部を解像しきった所で不透明な形が現れ始める被覆率。
export const OPAQUE_COVERAGE_CENTER = 0.34;
// 解像しきった細部の標準偏差(被覆率の目盛り)。被覆率が中央値 ± 2 倍のあいだで縁が千切れる。
export const DETAIL_SIGMA = 0.12;
// 細部を解像できない所の不透明のしきい値。被覆率と細部の和はここへ届かず、形は現れない。
export const CLOSED_THRESHOLD = 1.2;
// 不透明な形として描き始める・描ききる鉛直柱光学深さ。これより薄い雲は透けて見える。
export const OPAQUE_OPTICAL_DEPTH_ONSET = 2;
export const OPAQUE_OPTICAL_DEPTH_FULL = 4;
// 標準正規の累積分布をロジスティックで近似する傾き(最大誤差 0.01)。
export const NORMAL_CDF_LOGISTIC_SLOPE = 1.702;
// 細部の標準偏差の下限。解像度 0 で 0 除算に落ちないための値。
const MIN_DETAIL_SPREAD = 1e-3;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

// 被覆率へ細部を足した値と比べる、不透明のしきい値。resolvability は細部を解像できる割合 0..1、
// opticalDepth は柱の鉛直光学深さ。どちらかが 0 なら形は現れない。
export function opaqueThreshold(resolvability: number, opticalDepth: number): number {
  const eligible = resolvability
    * smoothstep(OPAQUE_OPTICAL_DEPTH_ONSET, OPAQUE_OPTICAL_DEPTH_FULL, opticalDepth);
  return OPAQUE_COVERAGE_CENTER + (1 - eligible) * (CLOSED_THRESHOLD - OPAQUE_COVERAGE_CENTER);
}

// 被覆率 coverage の柱のうち、不透明な形として描かれる面積の期待値。細部は平均 0・標準偏差
// DETAIL_SIGMA × resolvability の正規分布とみなす。
export function expectedOpaqueFraction(coverage: number, resolvability: number, opticalDepth: number): number {
  const spread = Math.max(DETAIL_SIGMA * resolvability, MIN_DETAIL_SPREAD);
  const z = (coverage - opaqueThreshold(resolvability, opticalDepth)) / spread;
  return 1 / (1 + Math.exp(-NORMAL_CDF_LOGISTIC_SLOPE * z));
}

// 不透明な形の外側を半透明な雲が覆う割合。形の期待値 opaque と合わせた平均が coverage に一致する。
export function translucentResidual(coverage: number, opaque: number): number {
  return Math.min(Math.max((coverage - opaque) / Math.max(1 - opaque, MIN_DETAIL_SPREAD), 0), 1);
}
