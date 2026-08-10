// マップビューの縮尺バーに使う、DOM/カメラ非依存の数値計算。

export interface MapScaleData {
  readonly distanceM: number;
  readonly widthPx: number;
}

export const MAP_SCALE_TARGET_PX = 120;

// 縮尺バーの長さが連続的に伸縮し、表示値だけが 1/2/5 の見やすい値になるようにする。
const SQRT_2 = Math.sqrt(2);
const SQRT_10 = Math.sqrt(10);
const SQRT_50 = Math.sqrt(50);

export function mapScaleFor(metersPerPixel: number, targetPx = MAP_SCALE_TARGET_PX): MapScaleData | null {
  if (!Number.isFinite(metersPerPixel) || metersPerPixel <= 0 || !Number.isFinite(targetPx) || targetPx <= 0) return null;

  const rawDistance = metersPerPixel * targetPx;
  const exponent = 10 ** Math.floor(Math.log10(rawDistance));
  const normalized = rawDistance / exponent;
  const factor = normalized < SQRT_2 ? 1 : normalized < SQRT_10 ? 2 : normalized < SQRT_50 ? 5 : 10;
  const distanceM = factor * exponent;
  return { distanceM, widthPx: distanceM / metersPerPixel };
}

// 太陽系スケールでも桁が潰れないよう、SI の距離単位を段階的に切り替える。
export function formatMapScaleDistance(distanceM: number): string {
  const abs = Math.abs(distanceM);
  if (!Number.isFinite(abs) || abs === 0) return '---';
  const units: readonly [number, string][] = [
    [1e12, 'Tm'], [1e9, 'Gm'], [1e6, 'Mm'], [1e3, 'km'], [1, 'm'],
  ];
  const [unitM, unit] = units.find(([threshold]) => abs >= threshold) ?? units[units.length - 1]!;
  const value = distanceM / unitM;
  const decimals = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2;
  return `${value.toFixed(decimals).replace(/\.0+$|(?<=\.\d)0+$/, '')} ${unit}`;
}
