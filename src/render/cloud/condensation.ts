// 天気から凝結する雲。地表付近の湿度と対流が不透明な雲に、上層の湿度が薄く透ける雲になる。
// 2つは別の湿度の場から出るので、独立に分布する。値はすべて見えのための調整値。
import { exp, float, max, smoothstep } from 'three/tsl';
import type { WeatherSample } from './weather-model';
import type { FloatNode } from '../tsl-types';

// 単位方向における雲。被覆率はその texel が雲に覆われている割合 0..1、雲頂高度は [m]、
// 薄い雲は鉛直の光学的厚み(0 で雲なし)。
export type CloudSample = {
  readonly coverage: FloatNode;
  readonly cloudTop: FloatNode;
  readonly translucent: FloatNode;
};

// 被覆率の足切りの縁と、そこへ足す対流の重み。湿度に対流の強弱を足したものを渡すので、湿度が上の
// 縁を超えている所は対流が下がっても覆われたままで、**湿度が縁のあいだにある所だけが対流の周波数で
// 千切れる。** 縁の幅は、活発度 1 の対流が振れる幅(±0.12)と同じに取る — 湿った所はすぐ飽和し、
// そこから先の起伏は雲頂高度が持つ。
const COVERAGE_ONSET = 0.62;
const COVERAGE_FULL = 0.80;
const CONVECTION_GAIN = 0.8;
// 雲頂の高さ [m]。雲底から、対流の深さが 1 に漸近する高さまで。
const CLOUD_BASE_HEIGHT = 1000;
const CLOUD_TOP_SPAN = 14000;
// 雲頂の深さを 0..1 へ収めるロジスティックの、上昇流 [per m/s] と対流の重み、そして底。
// 上昇流が頭打ち(0.06 m/s)の眼壁で 0.95(14.3 km)、並の低気圧(0.02 m/s)で 0.41(6.7 km)、
// 上昇流の無い所で 0.12(2.7 km)。**ロジスティックは上端でも下端でも傾きが 0 にならないので、
// 被覆率が飽和した所でも、金床の上面でも、対流の起伏が雲頂に残る。**
const CLOUD_TOP_LIFT = 82;
const CLOUD_TOP_RELIEF = 3.3;
const CLOUD_TOP_BIAS = 2;
// 薄い雲は、上層の湿度がしきい値を超えた分に比例して光学的厚みが増える。上端で 0.72 に届く
// — 巻雲は厚みが 1 に届かず、下地が透けたまま見える。
const TRANSLUCENT_ONSET = 0.52;
const TRANSLUCENT_GAIN = 1.5;

// weather から凝結する雲のグラフ。被覆率は湿度(低周波)へ対流(高周波)を足した 1 本の足切りから、
// 雲頂高度は上昇流と対流を別々の重みで混ぜたロジスティックから出る — 覆う広さは湿度が、
// 高さは上昇流が決め、対流はどちらにも粒と起伏を与える。**対流の活発度が効くのは被覆率の側で、
// 雲頂は活発度に依らず対流をそのまま受ける** — 一面に覆われた空も一様な白い面にはならない
// (`DEVELOP/SPEC/RENDERING.md`「雲の描画」)。
export function condense(weather: WeatherSample): CloudSample {
  const depth = max(weather.lift, 0).mul(CLOUD_TOP_LIFT)
    .add(weather.convection.mul(CLOUD_TOP_RELIEF)).sub(CLOUD_TOP_BIAS);
  const granularity = weather.convection.mul(weather.convectiveActivity).mul(CONVECTION_GAIN);
  return {
    coverage: smoothstep(COVERAGE_ONSET, COVERAGE_FULL, weather.humidity.add(granularity)),
    cloudTop: float(1).add(exp(depth.negate())).reciprocal().mul(CLOUD_TOP_SPAN).add(CLOUD_BASE_HEIGHT),
    translucent: max(weather.upperHumidity.sub(TRANSLUCENT_ONSET), 0).mul(TRANSLUCENT_GAIN),
  };
}
