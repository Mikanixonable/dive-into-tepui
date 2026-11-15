// 雲の白さと光学的厚みの関係を測る計測の共通モデル。合成の雲板の種類・場面の寸法・
// 雲の量から光学的厚み・雲頂高度・覆う割合への式・参照曲線(保存散乱の 2 流近似)を
// 1 か所に持ち、render-lab のケース(cloud-albedo-cases.ts)と評価
// (tools/cloud-albedo-check.mjs)が同じ数を読む。

// 直下点へカメラを置く高度 [m]。画像の中心で 1 px が 4 km になる距離
// (画角 50°・高さ 540 px の render-lab の寸法から)。
export const KM_PER_PX = 4;
export const ALTITUDE_M = (KM_PER_PX * 1e3 * 540) / (2 * Math.tan((50 / 2) * Math.PI / 180));

// 太陽の天頂角 [deg]。ケースは直下点の上方向が描画座標の +Z へ来る置き方なので、
// 観察のつまみ「恒星 仰角」へは 90 − 天頂角を渡す(仰角は水平面から測る)。
export const ZENITHS_DEG = [30, 60] as const;

// 掃引する雲の量(雲場の R・G の値)。積雲は量 → 雲頂 0.5〜17 km(厚み → τ_in)、
// 巻雲は τ = 3·量² の 0.12〜3 に当たる。
export const CUMULUS_AMOUNTS = [0.02, 0.05, 0.1, 0.15, 0.24, 0.35, 0.5, 0.7, 1.0] as const;
export const CIRRUS_AMOUNTS = [0.2, 0.4, 0.6, 0.8, 1.0] as const;

// 雲の量 → 積雲の雲頂高度 [m]・柱の中の光学的厚み τ_in・texel を覆う割合。
// src/render/cloud/cloud-kind.ts の式の写し(雲底 500 m・幅 16500 m・
// CUMULUS_IN_CLOUD_DEPTH_COEFFICIENT = 6.0e-4・CUMULUS_COVERING_DEPTH_SCALE = 0.12)。
export const cumulusTopAltitudeOf = (amount: number): number => 500 + 16500 * amount * amount;
export const cumulusThicknessOf = (amount: number): number => cumulusTopAltitudeOf(amount) - 500;
export const cumulusTauOf = (amount: number): number => (
  6.0e-4 * cumulusThicknessOf(amount) ** (5 / 3)
);
// 任意の雲頂高度の柱の τ_in(細部で持ち上げられた雲頂の評価用)。
export const cumulusTauOfTop = (topAltitude: number): number => (
  6.0e-4 * Math.max(topAltitude - 500, 0) ** (5 / 3)
);
// 細部が雲頂へ足す起伏の半幅 [m](cloud-shape-evaluator.ts の DETAIL_TOP_RELIEF·CLOUD_TOP_SPAN)。
export const DETAIL_TOP_RELIEF_M = 0.15 * 16500;
export const cumulusCoverOf = (amount: number): number => 1 - Math.exp(-amount / 0.12);
export const cirrusTauOf = (amount: number): number => 3 * amount * amount;

// 合成の場面の雲板の種類。ケースは表示時刻をこの表の添字として受けて、一様場の量と
// 下地を切り替える。白い面の行は、海の行の雲と同じ量で下地だけを白へ変えたもの —
// 雲の板が落とす影で暗くなった地表の明るさを測る。末尾の 2 つは「雲なし」と、
// 反射率換算の基準になる白い拡散面。
export interface AlbedoVariant {
  readonly cumulus: number;
  readonly cirrus: number;
  // 雲の下の面。'ocean' は暗い海、'white' は拡散反射率 1 の基準面。
  readonly ground: 'ocean' | 'white';
}
export const VARIANTS: readonly AlbedoVariant[] = [
  ...CUMULUS_AMOUNTS.map((cumulus) => ({ cumulus, cirrus: 0, ground: 'ocean' as const })),
  ...CIRRUS_AMOUNTS.map((cirrus) => ({ cumulus: 0, cirrus, ground: 'ocean' as const })),
  ...CUMULUS_AMOUNTS.map((cumulus) => ({ cumulus, cirrus: 0, ground: 'white' as const })),
  ...CIRRUS_AMOUNTS.map((cirrus) => ({ cumulus: 0, cirrus, ground: 'white' as const })),
  { cumulus: 0, cirrus: 0, ground: 'ocean' },
  { cumulus: 0, cirrus: 0, ground: 'white' },
];
// 表のうち、海の上の雲・白い面の上の雲・雲なし・白い面の添字の頭。
export const CUMULUS_OCEAN_VARIANTS = 0;
export const CIRRUS_OCEAN_VARIANTS = CUMULUS_AMOUNTS.length;
export const CUMULUS_WHITE_VARIANTS = CIRRUS_OCEAN_VARIANTS + CIRRUS_AMOUNTS.length;
export const CIRRUS_WHITE_VARIANTS = CUMULUS_WHITE_VARIANTS + CUMULUS_AMOUNTS.length;
export const CLEAR_VARIANT = CIRRUS_WHITE_VARIANTS + CIRRUS_AMOUNTS.length;
export const WHITE_VARIANT = CLEAR_VARIANT + 1;

// 保存散乱(吸収なし・単散乱アルベド 1)の層が、拡散入射に対して半球へ返す光の割合。
// 2 流近似(Eddington、Meador & Weaver 1980)で R = γτ/(1 + γτ)、γ = 0.75·(1 − g)。
// τ は鉛直の光学的厚み、g は非対称因子(積雲は 0.85、氷の巻雲は 0.75)。src/render/cloud/
// cloud-optics.ts の式の写し — 拡散の反射率として天頂角への依存は入れない。
export function cloudReflectance(tau: number, g: number): number {
  const scaled = 0.75 * (1 - g) * Math.max(tau, 0);
  return scaled / (1 + scaled);
}

// 参照曲線を書き出す光学的厚みの目盛り。τ_in の届く外側の τ = 23・60・100 を含む。
export const REFERENCE_TAUS = [0.2, 0.5, 1, 2, 3, 5, 8.33, 10, 15, 23, 30, 45, 60, 80, 100] as const;
