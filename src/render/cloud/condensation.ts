// 天気から凝結する雲。地表付近の湿度が不透明な雲に、上層の湿度が薄く透ける雲になる。2つは
// 別の湿度の場から出るので、独立に分布する。値はすべて見えのための調整値。
import { max } from 'three/tsl';
import type { WeatherSample } from './weather-model';
import type { FloatNode } from '../tsl-types';

// 単位方向における雲。どちらも鉛直の光学的厚み(0 で雲なし)。
export type CloudSample = {
  readonly opaque: FloatNode;
  readonly translucent: FloatNode;
};

// 湿度がしきい値を超えた分に比例して光学的厚みが増える。厚みは下地の隠れ方 1−exp(−厚み) で
// 効くので、階調が乗るのは 4 まで(そこで 98% 隠れる)— 利得はその幅を湿度の上端に合わせて置く。
const OPAQUE_ONSET = 0.55;
const OPAQUE_GAIN = 20;
const TRANSLUCENT_ONSET = 0.4;
const TRANSLUCENT_GAIN = 1.5;

// weather から凝結する雲のグラフ。
export function condense(weather: WeatherSample): CloudSample {
  return {
    opaque: max(weather.humidity.sub(OPAQUE_ONSET), 0).mul(OPAQUE_GAIN),
    translucent: max(weather.upperHumidity.sub(TRANSLUCENT_ONSET), 0).mul(TRANSLUCENT_GAIN),
  };
}
