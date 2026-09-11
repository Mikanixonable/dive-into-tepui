// 正多角形絞りの回折PSFを、辺の法線方向へ伸びる主ローブへ縮約した静的モデル。
// 各ローブは指数分布なので、多段畳み込みでも距離に対する減衰が連続する。

// 仮想絞りの羽根数。偶数なら羽根数ぶん、奇数なら羽根数の2倍の腕が出る。
const APERTURE_BLADE_COUNT = 8;
// 正多角形の最初の頂点の向き [rad]。光芒は隣り合う頂点の中間にある辺法線へ伸びる。
const APERTURE_VERTEX_ANGLE = 0;
// 1段あたりのタップ数と段数。2段で 12² - 1 = 143 読み元テクセルまで届く。
const APERTURE_PSF_TAP_COUNT = 12;
const APERTURE_PSF_PASS_COUNT = 2;
// 支持端の相対強度。12bitの1階調より小さくして、有限支持の切断が表示へ残らないようにする。
const APERTURE_PSF_EDGE_INTENSITY = 1 / 4096;
const APERTURE_PSF_SUPPORT = APERTURE_PSF_TAP_COUNT ** APERTURE_PSF_PASS_COUNT - 1;
const APERTURE_PSF_FALLOFF = -APERTURE_PSF_SUPPORT / Math.log(APERTURE_PSF_EDGE_INTENSITY);

export type AperturePsfTap = {
  // 読み元のテクセルで測った、光芒方向への距離。
  readonly offset: number;
  // この段の正規化済み配分。
  readonly weight: number;
};

// 正多角形絞りの辺法線。1要素が中心から外向きの腕1本に対応する。
export const APERTURE_PSF_DIRECTIONS: readonly (readonly [number, number])[] = (() => {
  const armCount = APERTURE_BLADE_COUNT % 2 === 0
    ? APERTURE_BLADE_COUNT : APERTURE_BLADE_COUNT * 2;
  const firstEdgeNormal = APERTURE_VERTEX_ANGLE + Math.PI / APERTURE_BLADE_COUNT;
  return Array.from({ length: armCount }, (_, arm) => {
    const angle = firstEdgeNormal + (2 * Math.PI * arm) / armCount;
    return [Math.cos(angle), Math.sin(angle)] as const;
  });
})();

// 中心に対する、距離 distance [読み元のテクセル] での主ローブ強度。
export function aperturePsfRelativeIntensity(distance: number): number {
  return Math.exp(-Math.max(0, distance) / APERTURE_PSF_FALLOFF);
}

// 多段畳み込みの各段。各段は係数和1で、段をまたいだ積が全距離で同じ指数分布になる。
export const APERTURE_PSF_PASSES: readonly (readonly AperturePsfTap[])[] = Array.from(
  { length: APERTURE_PSF_PASS_COUNT }, (_, pass) => {
    const stride = APERTURE_PSF_TAP_COUNT ** pass;
    const taps = Array.from({ length: APERTURE_PSF_TAP_COUNT }, (_, step) => ({
      offset: stride * step,
      weight: aperturePsfRelativeIntensity(stride * step),
    }));
    const total = taps.reduce((sum, tap) => sum + tap.weight, 0);
    return taps.map((tap) => ({ ...tap, weight: tap.weight / total }));
  },
);
