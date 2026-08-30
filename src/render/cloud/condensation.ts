// 天気から凝結する雲。地表付近の湿度と対流の深さが不透明な雲に、上層の湿度が薄く透ける雲になる。
// 2つは別の湿度の場から出るので、独立に分布する。値はすべて見えのための調整値。
import { max, smoothstep } from 'three/tsl';
import type { WeatherSample } from './weather-model';
import type { FloatNode } from '../tsl-types';

// 単位方向における雲。被覆率はその texel が雲に覆われている割合 0..1、雲頂高度は [m]、
// 薄い雲は鉛直の光学的厚み(0 で雲なし)。
export type CloudSample = {
  readonly coverage: FloatNode;
  readonly cloudTop: FloatNode;
  readonly translucent: FloatNode;
};

// 湿度と対流を足切りする縁。全球の分布の 15 / 90 パーセンタイルに置く — 下の縁より乾いた所と
// 対流の浅い所は晴れ、上の縁へ届くのは上昇流が乗った 1 割だけになる。
const COVERAGE_HUMIDITY_ONSET = 0.44;
const COVERAGE_HUMIDITY_FULL = 0.79;
const COVERAGE_CONVECTION_ONSET = 0.42;
const COVERAGE_CONVECTION_FULL = 0.74;
// 雲底の高さと、対流が押し上げる雲頂の高さ [m]。
const CLOUD_BASE_HEIGHT = 1000;
const CLOUD_TOP_SPAN = 14000;
// 薄い雲は、上層の湿度がしきい値を超えた分に比例して光学的厚みが増える。上端で 0.9 に届く
// — 巻雲は厚みが 1 に届かず、下地が透けたまま見える。
const TRANSLUCENT_ONSET = 0.4;
const TRANSLUCENT_GAIN = 1.5;

// weather から凝結する雲のグラフ。不透明な雲は湿度と対流の両方が足切りを超えた所にだけ立つので、
// 移流が湿度へ引いた筋の中に、対流の粒が切れ目を入れる。
export function condense(weather: WeatherSample): CloudSample {
  const depth = smoothstep(COVERAGE_CONVECTION_ONSET, COVERAGE_CONVECTION_FULL, weather.convection);
  return {
    coverage: smoothstep(COVERAGE_HUMIDITY_ONSET, COVERAGE_HUMIDITY_FULL, weather.humidity).mul(depth),
    cloudTop: depth.mul(CLOUD_TOP_SPAN).add(CLOUD_BASE_HEIGHT),
    translucent: max(weather.upperHumidity.sub(TRANSLUCENT_ONSET), 0).mul(TRANSLUCENT_GAIN),
  };
}
