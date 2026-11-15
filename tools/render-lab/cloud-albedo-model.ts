// 雲の白さと光学的厚みの関係を測る計測の共通モデル。合成の雲板の種類・場面の寸法・
// 雲の量から鉛直柱光学深さへの式・参照曲線(保存散乱の 2 流近似)を 1 か所に持ち、
// render-lab のケース(cloud-albedo-cases.ts)と評価(tools/cloud-albedo-check.mjs)が
// 同じ数を読む。

// 直下点へカメラを置く高度 [m]。画像の中心で 1 px が 4 km になる距離
// (画角 50°・高さ 540 px の render-lab の寸法から)。
export const KM_PER_PX = 4;
export const ALTITUDE_M = (KM_PER_PX * 1e3 * 540) / (2 * Math.tan((50 / 2) * Math.PI / 180));

// 太陽の天頂角 [deg]。ケースは直下点の上方向が描画座標の +Z へ来る置き方なので、
// 観察のつまみ「恒星 仰角」へは 90 − 天頂角を渡す(仰角は水平面から測る)。
export const ZENITHS_DEG = [30, 60] as const;

// 掃引する雲の量(雲場の R・G の値)。積雲は τ = 量 / 0.12 の 0.17〜8.3、
// 巻雲は τ = 3·量² の 0.12〜3 に当たる。
export const CUMULUS_AMOUNTS = [0.02, 0.05, 0.1, 0.15, 0.24, 0.35, 0.5, 0.7, 1.0] as const;
export const CIRRUS_AMOUNTS = [0.2, 0.4, 0.6, 0.8, 1.0] as const;

// 雲の量 → 鉛直柱光学深さ。src/render/cloud/cloud-kind.ts の式の写し
// (CUMULUS_OPTICAL_DEPTH_SCALE = 0.12、CIRRUS_MAX_OPTICAL_DEPTH = 3)。
export const cumulusTauOf = (amount: number): number => amount / 0.12;
export const cirrusTauOf = (amount: number): number => 3 * amount * amount;

// 合成の場面の雲板の種類。ケースは表示時刻をこの表の添字として受けて、一様場の量と
// 下地を切り替える。末尾の 2 つは「雲なし」と、反射率換算の基準になる白い拡散面。
export interface AlbedoVariant {
  readonly cumulus: number;
  readonly cirrus: number;
  // 雲の下の面。'ocean' は暗い海、'white' は拡散反射率 1 の基準面。
  readonly ground: 'ocean' | 'white';
}
export const VARIANTS: readonly AlbedoVariant[] = [
  ...CUMULUS_AMOUNTS.map((cumulus) => ({ cumulus, cirrus: 0, ground: 'ocean' as const })),
  ...CIRRUS_AMOUNTS.map((cirrus) => ({ cumulus: 0, cirrus, ground: 'ocean' as const })),
  { cumulus: 0, cirrus: 0, ground: 'ocean' },
  { cumulus: 0, cirrus: 0, ground: 'white' },
];
// 表のうち、雲なしと白い面の添字。
export const CLEAR_VARIANT = CUMULUS_AMOUNTS.length + CIRRUS_AMOUNTS.length;
export const WHITE_VARIANT = CLEAR_VARIANT + 1;

// 保存散乱(単散乱アルベド 1)の 2 流近似による層の反射率。Meador & Weaver 1980 の
// Eddington 近似。tau は鉛直の光学的厚み、mu0 は太陽天頂角の余弦、g は非対称因子
// (積雲は 0.85、氷の巻雲は 0.75 でも出す)。
export function eddingtonReflectance(tau: number, mu0: number, g: number): number {
  const gamma1 = 0.75 * (1 - g);
  const gamma3 = (2 - 3 * g * mu0) / 4;
  return (gamma1 * tau + (gamma3 - gamma1 * mu0) * (1 - Math.exp(-tau / mu0))) / (1 + gamma1 * tau);
}

// 参照曲線を書き出す光学的厚みの目盛り。描画器の届く上限(積雲 τ ≈ 8.3)の外側の
// τ = 23・60・100 を含む。
export const REFERENCE_TAUS = [0.2, 0.5, 1, 2, 3, 5, 8.33, 10, 15, 23, 30, 45, 60, 80, 100] as const;
