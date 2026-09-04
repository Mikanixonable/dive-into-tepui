// 天気から凝結する雲。地表付近の湿度と対流が不透明な雲に、上層の湿度が薄く透ける雲になる。
// 2つは別の湿度の場から出るので、独立に分布する。値はすべて見えのための調整値。
import { exp, float, max, smoothstep, uniform } from 'three/tsl';
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
// 層状の雲の高さ [m]。雲底から、上昇流の深さが 1 に漸近する高さまで。上限は前線の乱層雲
// (4〜8 km)に取る — 塔はここではなく対流の峰が立てる。
const CLOUD_BASE_HEIGHT = 1000;
const LAYER_TOP_SPAN = 6000;
// 層状の深さを 0..1 へ収めるロジスティックの、上昇流 [per m/s] と対流の重み、そして底。
// 上昇流が頭打ち(0.06 m/s)の谷の芯で 5.6 km、並の低気圧(0.02 m/s)で 2.9 km、上昇流の無い所で
// 1.9 km(低い積雲の多数派)。**対流の重みは、同じ cap の中で雲頂が 1〜7 km に散る幅に取る**
// — 上昇流だけでは低気圧の上が一様な台地になる。ロジスティックは上端でも下端でも傾きが 0 に
// ならないので、被覆率が飽和した所でも対流の起伏が雲頂に残る。
export const CLOUD_TOP_LIFT_KNOB: FloatUniform = uniform(50);
export const CLOUD_TOP_RELIEF_KNOB: FloatUniform = uniform(27);
export const CLOUD_TOP_BIAS_KNOB: FloatUniform = uniform(1.85);
// 塔が立つ対流の峰(対流 × 活発度)の縁。ここを超えた峰だけが圏界面まで持ち上がるので、塔の
// 割合はこの 2 つと、下の湿りの門が決める。
export const TOWER_ONSET_KNOB: FloatUniform = uniform(0.027);
export const TOWER_WIDTH_KNOB: FloatUniform = uniform(0.045);
// 薄い雲は、上層の湿度がしきい値を超えた分に比例して光学的厚みが増える。上端で 0.72 に届く
// — 巻雲は厚みが 1 に届かず、下地が透けたまま見える。
export const TRANSLUCENT_ONSET_KNOB: FloatUniform = uniform(0.44);
export const TRANSLUCENT_GAIN_KNOB: FloatUniform = uniform(1.7);

// weather から凝結する雲のグラフ。被覆率は湿度(低周波)へ対流(高周波)を足した 1 本の伝達関数から、
// 雲頂高度は 層状の雲・塔・金床 の 3 つの高さのうち最も高いものから出る — 覆う広さは湿度が、
// 層の高さは上昇流が、塔は対流の峰が、平らな天蓋は渦の芯が決める。**対流の活発度が効くのは
// 被覆率と塔で、層状の雲頂は活発度に依らず対流をそのまま受ける** — 一面に覆われた空も一様な
// 白い面にはならない(`DEVELOP/SPEC/RENDERING.md`「雲の描画」)。
export function condense(weather: WeatherSample): CloudSample {
  const peak = weather.convection.mul(weather.convectiveActivity);
  const granularity = peak.mul(CONVECTION_GAIN_KNOB);
  // 層状の雲: 上昇流が持ち上げる高さに、対流の起伏が乗る。
  const depth = max(weather.lift, 0).mul(CLOUD_TOP_LIFT_KNOB)
    .add(weather.convection.mul(CLOUD_TOP_RELIEF_KNOB)).sub(CLOUD_TOP_BIAS_KNOB);
  const layered = float(1).add(exp(depth.negate())).reciprocal().mul(LAYER_TOP_SPAN).add(CLOUD_BASE_HEIGHT);
  // 塔と金床: どちらも圏界面まで届く。塔は対流の峰が立て、天蓋は眼を持つ渦の芯だけが敷く。
  // **塔は、その場が覆われるほど湿っている所にだけ立つ。** 乾いた土地では対流の峰が雲を作っても
  // 深い対流にはならないので、湿度そのものを同じ伝達関数の窓で見て門にする。
  const towerEdge = TOWER_ONSET_KNOB.add(TOWER_WIDTH_KNOB);
  const moist = smoothstep(COVERAGE_ONSET_KNOB, COVERAGE_ONSET_KNOB.add(COVERAGE_WIDTH_KNOB), weather.humidity);
  const tower = smoothstep(TOWER_ONSET_KNOB, towerEdge, peak).mul(moist).mul(weather.tropopause);
  const anvil = weather.anvil.mul(weather.tropopause);
  // 被覆率は、湿度が効き始めを超えた分を幅で割った t の 1 − exp(−t²)。下端は傾き 0 で 0 から離れ、
  // 上端は 1 へ漸近するだけで飽和しない — 覆われた空にも湿度の差が階調として残る。
  const excess = max(weather.humidity.add(granularity).sub(COVERAGE_ONSET_KNOB), 0).div(COVERAGE_WIDTH_KNOB);
  return {
    coverage: exp(excess.mul(excess).negate()).oneMinus(),
    cloudTop: max(max(layered, tower), anvil),
    translucent: max(weather.upperHumidity.sub(TRANSLUCENT_ONSET_KNOB), 0).mul(TRANSLUCENT_GAIN_KNOB),
  };
}
