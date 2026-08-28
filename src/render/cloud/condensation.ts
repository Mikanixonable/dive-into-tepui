// 天気から凝結する雲。地表付近の湿度が雲底から雲頂までの対流雲・層雲に、上層の湿度が中層雲と
// 薄いベールになり、雲頂が高く届いた対流雲はかなとこの薄い雲を広げる。値はすべて見えのための調整値。
import { clamp, float, max, min, smoothstep } from 'three/tsl';
import type { WeatherSample } from './weather-model';
import type { FloatNode } from '../tsl-types';

// 不透明雲の高度スラブ。スラブ k は高度 [SLAB_BASE + k·SLAB_THICKNESS, +SLAB_THICKNESS) [m] を占め、
// SLAB_COUNT 枚で対流圏を覆う。
export const SLAB_COUNT = 8;
export const SLAB_BASE = 500;
export const SLAB_THICKNESS = 1500;

// 単位方向における雲。slabs はスラブごとの不透明雲の光学的厚み(SLAB_COUNT 個、0 で雲なし)、
// translucent は薄く透ける雲の光学的厚み。両者は独立に分布する。
export type CloudSample = {
  readonly slabs: readonly FloatNode[];
  readonly translucent: FloatNode;
};

// 地表付近の湿度が COVERAGE_ONSET から COVERAGE_FULL の間で雲量 0..1 になり、雲底は乾いているほど
// 高く(持ち上げ凝結高度 [m/湿度不足])、層の厚みは層雲の厚み [m] に、暖かさ [m/°C] と上昇流
// [m per m/s] で伸びる対流の分を足す。スラブ 1 枚を満たす雲の光学的厚みが TAU_PER_SLAB。
const COVERAGE_ONSET = 0.6;
const COVERAGE_FULL = 0.85;
const CONDENSATION_LEVEL_PER_DRYNESS = 2500;
const CLOUD_BASE_MIN = 300;
const STRATUS_DEPTH = 800;
const CONVECTION_ONSET = 15;
const CONVECTION_DEPTH_PER_DEGREE = 600;
const LIFT_DEPTH = 20000;
const TAU_PER_SLAB = 8;
// 中層雲: 上層湿度が MID_COVERAGE_ONSET..MID_COVERAGE_FULL で雲量になり、高度 MID_BASE..MID_TOP [m] を占める。
const MID_COVERAGE_ONSET = 0.55;
const MID_COVERAGE_FULL = 0.8;
const MID_BASE = 4000;
const MID_TOP = 7000;
const MID_TAU = 4;
// 薄い雲: 上層湿度のベール(光学的厚み THIN_TAU まで)と、対流の雲頂が ANVIL_ONSET..ANVIL_FULL [m] へ
// 届いたときのかなとこ(ANVIL_TAU まで)。
const THIN_ONSET = 0.45;
const THIN_FULL = 0.75;
const THIN_TAU = 0.8;
const ANVIL_ONSET = 9000;
const ANVIL_FULL = 12000;
const ANVIL_TAU = 0.6;

// weather から凝結する雲のグラフ。
export function condense(weather: WeatherSample): CloudSample {
  const coverage = smoothstep(COVERAGE_ONSET, COVERAGE_FULL, weather.humidity);
  const base = max(float(1).sub(weather.humidity).mul(CONDENSATION_LEVEL_PER_DRYNESS), CLOUD_BASE_MIN);
  const depth = float(STRATUS_DEPTH)
    .add(max(weather.temperature.sub(CONVECTION_ONSET), 0).mul(CONVECTION_DEPTH_PER_DEGREE).mul(coverage))
    .add(max(weather.lift, 0).mul(LIFT_DEPTH));
  const top = base.add(depth);
  const midCoverage = smoothstep(MID_COVERAGE_ONSET, MID_COVERAGE_FULL, weather.upperHumidity);

  // スラブごとに、雲の層と重なる割合を光学的厚みにする。
  const overlap = (k: number, layerBase: FloatNode, layerTop: FloatNode): FloatNode => {
    const slabBase = SLAB_BASE + k * SLAB_THICKNESS;
    const covered = min(layerTop, slabBase + SLAB_THICKNESS).sub(max(layerBase, slabBase));
    return clamp(covered.div(SLAB_THICKNESS), 0, 1);
  };
  const slabs = Array.from({ length: SLAB_COUNT }, (_, k) =>
    overlap(k, base, top).mul(coverage).mul(TAU_PER_SLAB)
      .add(overlap(k, float(MID_BASE), float(MID_TOP)).mul(midCoverage).mul(MID_TAU)));

  const translucent = smoothstep(THIN_ONSET, THIN_FULL, weather.upperHumidity).mul(THIN_TAU)
    .add(smoothstep(ANVIL_ONSET, ANVIL_FULL, top).mul(ANVIL_TAU));
  return { slabs, translucent };
}
