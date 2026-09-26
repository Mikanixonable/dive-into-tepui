// 大気風の共有モデルの数値版。風速 [m/s] は緯度と高度に応じて連続的に変化する。
// THREE・TSL に依存しないので、シェーダを組めない実行環境(worker)でも同じ風則を評価できる。
// TSL ノード版と、風から模様の位相への変換は atmospheric-wind.ts が持つ。

// ある点における風の東向き・北向き成分 [m/s]。
export interface WindVector {
  readonly east: number;
  readonly north: number;
}

// 地表付近の代表高度 [m]。
export const SURFACE_HEIGHT = 1_000;
// 雲上層の代表高度 [m]。
export const UPPER_CLOUD_HEIGHT = 10_000;

// 緯度 latitudeRad [rad]・高度 heightM [m] における大循環の風 [m/s]。貿易風・偏西風・
// 極域風の緯度帯を滑らかに繋ぎ、地表付近と雲上層の2層を高度で補間する。
export function atmosphericWindAt(latitudeRad: number, heightM: number): WindVector {
  const a = Math.abs(latitudeRad);
  const trade = smoothstep(0.18, 0.32, a);
  const westerly = smoothstep(0.28, 0.55, a) * (1 - smoothstep(0.58, 0.72, a));
  const polar = smoothstep(0.62, 1.25, a);
  const layer = smoothstep(SURFACE_HEIGHT, UPPER_CLOUD_HEIGHT, heightM);
  const hemisphere = latitudeRad < 0 ? -1 : 1;
  const eastSurface = -6 * trade + 7 * westerly - 6 * polar;
  const northSurface = -hemisphere * (1.5 * trade - 1.5 * westerly + polar);
  return {
    east: eastSurface + layer * (12 * polar + 13 * westerly - eastSurface),
    north: northSurface + layer * (-northSurface - hemisphere * 0.8),
  };
}

// 端で立ち上がる滑らかな重み。TSL の smoothstep と同じ式の数値版。
function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
