// 天気から凝結する雲。地表付近の湿度と対流が不透明な雲に、上層の湿度が薄く透ける雲になる。
// 2つは別の湿度の場から出るので、独立に分布する。値はすべて見えのための調整値。
import { exp, float, max, uniform } from 'three/tsl';
import type { WeatherSample } from './weather-model';
import type { FloatNode, FloatUniform } from '../tsl-types';

// 単位方向における雲。被覆率はその texel が雲に覆われている割合 0..1、雲頂高度は [m]、
// 薄い雲は鉛直の光学的厚み(0 で雲なし)。
export type CloudSample = {
  readonly coverage: FloatNode;
  readonly cloudTop: FloatNode;
  readonly translucent: FloatNode;
};

// **仮設**: 末尾が _KNOB の定数は、cloud-lab のつまみ(tools/cloud-lab/tuning-knobs.ts)から
// 動かせるよう uniform にしてある。生成の場を実写へ寄せる追い込みが終わるまでは畳まない。

// 被覆率が効き始める湿度と、そこから先の 1 単位ぶんの幅。湿度に対流の強弱を足したものを渡すので、
// **効き始めの近くにある所だけが対流の周波数で千切れ**、湿った所は幅の何倍も上へ行って伝達関数の
// 傾きが寝るので、そこから先の起伏は雲頂高度が持つ。幅は、湿度の地域差が階調として出る広さに取る
// — 狭く取ると、乾いた土地と湿った土地がどちらも一色へ潰れる。
export const COVERAGE_ONSET_KNOB: FloatUniform = uniform(0.49);
export const COVERAGE_WIDTH_KNOB: FloatUniform = uniform(0.28);
// 湿度へ足す対流の重み。伝達関数の幅に対してどれだけ深く千切るかを決める。
export const CONVECTION_GAIN_KNOB: FloatUniform = uniform(1.2);
// 雲頂の高さ [m]。雲底から、対流の深さが 1 に漸近する高さまで。
const CLOUD_BASE_HEIGHT = 1000;
const CLOUD_TOP_SPAN = 14000;
// 雲頂の深さを 0..1 へ収めるロジスティックの、上昇流 [per m/s] と対流の重み、そして底。
// 上昇流が頭打ち(0.06 m/s)の眼壁で 0.95(14.3 km)、並の低気圧(0.02 m/s)で 0.41(6.7 km)、
// 上昇流の無い所で 0.12(2.7 km)。**ロジスティックは上端でも下端でも傾きが 0 にならないので、
// 被覆率が飽和した所でも、金床の上面でも、対流の起伏が雲頂に残る。**
export const CLOUD_TOP_LIFT_KNOB: FloatUniform = uniform(82);
export const CLOUD_TOP_RELIEF_KNOB: FloatUniform = uniform(3.3);
export const CLOUD_TOP_BIAS_KNOB: FloatUniform = uniform(2);
// 薄い雲は、上層の湿度がしきい値を超えた分に比例して光学的厚みが増える。上端で 0.72 に届く
// — 巻雲は厚みが 1 に届かず、下地が透けたまま見える。
export const TRANSLUCENT_ONSET_KNOB: FloatUniform = uniform(0.52);
export const TRANSLUCENT_GAIN_KNOB: FloatUniform = uniform(1.5);

// weather から凝結する雲のグラフ。被覆率は湿度(低周波)へ対流(高周波)を足した 1 本の伝達関数から、
// 雲頂高度は上昇流と対流を別々の重みで混ぜたロジスティックから出る — 覆う広さは湿度が、
// 高さは上昇流が決め、対流はどちらにも粒と起伏を与える。**対流の活発度が効くのは被覆率の側で、
// 雲頂は活発度に依らず対流をそのまま受ける** — 一面に覆われた空も一様な白い面にはならない
// (`DEVELOP/SPEC/RENDERING.md`「雲の描画」)。
export function condense(weather: WeatherSample): CloudSample {
  const depth = max(weather.lift, 0).mul(CLOUD_TOP_LIFT_KNOB)
    .add(weather.convection.mul(CLOUD_TOP_RELIEF_KNOB)).sub(CLOUD_TOP_BIAS_KNOB);
  const granularity = weather.convection.mul(weather.convectiveActivity).mul(CONVECTION_GAIN_KNOB);
  // 被覆率は、湿度が効き始めを超えた分を幅で割った t の 1 − exp(−t²)。下端は傾き 0 で 0 から離れ、
  // 上端は 1 へ漸近するだけで飽和しない — 覆われた空にも湿度の差が階調として残る。
  const excess = max(weather.humidity.add(granularity).sub(COVERAGE_ONSET_KNOB), 0).div(COVERAGE_WIDTH_KNOB);
  return {
    coverage: exp(excess.mul(excess).negate()).oneMinus(),
    cloudTop: float(1).add(exp(depth.negate())).reciprocal().mul(CLOUD_TOP_SPAN).add(CLOUD_BASE_HEIGHT),
    translucent: max(weather.upperHumidity.sub(TRANSLUCENT_ONSET_KNOB), 0).mul(TRANSLUCENT_GAIN_KNOB),
  };
}
