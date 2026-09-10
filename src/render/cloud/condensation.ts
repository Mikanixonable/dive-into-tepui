// 天気から凝結する雲。地表付近の湿度と対流が不透明な雲に、上層の湿度が薄く透ける雲になる。
// 2つは別の湿度の場から出るので、独立に分布する。値はすべて見えのための調整値。
import {
  abs, clamp, exp, float, inverseSqrt, length, max, mix, smoothstep, tanh,
} from 'three/tsl';
import { R_EARTH } from '../../game/celestial/solar-system/constants';
import {
  CLOUD_CELL_MEAN_SCALE_MAX,
  CLOUD_CELL_MEAN_SCALE_MIN,
  CLOUD_CELL_VARIANCE_PROFILES,
} from './cloud-cell-variance';
import { gradientNoise } from './gradient-noise';
import { eastAt, northAt } from './sphere-frame';
import type { CloudSample } from './cloud-field-sample';
import type { WeatherSample } from './weather-model';
import type { FloatNode, Vec3Node } from '../tsl-types';
export type { CloudSample } from './cloud-field-sample';

// 被覆率が効き始める湿度と、そこから先の 1 単位ぶんの幅(被覆率が 0 から 0.56 へ上がる湿度の
// 範囲)。湿度に対流の強弱を足したものを渡すので、**効き始めの近くにある所だけが対流の周波数で
// 千切れ**、湿った所は幅の何倍も上へ行って伝達関数の傾きが寝るので、そこから先の起伏は雲頂高度が
// 持つ。幅は、粒の塊が白く隙間が黒く割れる狭さに取る(`DEVELOP/SPEC/RENDERING.md`「白い塊と
// 黒い隙間が交互に並ぶ」)— 広く取ると、塊も隙間も同じ灰色の網目に均される。湿度の地域差
// (気候)の階調は、伝達関数の傾きではなく、湿度の源が中間の尺度(400〜100 km)に持つ濃淡が運ぶ。
// 効き始めと幅は、±60° の被覆率の平均が実写(分離した厚い雲)の 0.115 に並ぶ 0.12、いちばん暗い段
// (< 0.03)が 57%(実写 35%)になる高さに取る。
const COVERAGE_ONSET = 0.50;
const COVERAGE_WIDTH = 0.22;
// 覆いの散らばり。texel の中では雲粒の湧く密度そのものが揺らぐので、晴れている割合は密度が一様な
// ポアソンの exp(−t²) ではなく、密度をガンマ分布で混ぜた (1 + t²/散らばり)^(−散らばり) を取る。
// **裾が代数なので、覆われた空の階調が上端で潰れない** — 指数の裾へ単純化すると、湿度が幅の 2 倍を
// 超えたところから先が 8bit で数階調に収まり、前線と渦の芯が一様な白い台地になる。値は、湿度の
// 上端で被覆率が 0.93 に収まる散らばりに取る。
const COVERAGE_DISPERSION = 2;
// 湿度へ足す対流の重み。伝達関数の幅に対してどれだけ深く千切るかを決める。
const CONVECTION_GAIN = 1.2;
// 雲セルのサイズ分散を選ぶ緯度の遷移。熱帯海洋ASTERの分布を低緯度側の基準にし、雲街が
// 現れる中緯度以北へ向かうほど大きなセルを許す。境界は数値ポリシーと同じく連続に渡す。
const CELL_VARIANCE_LATITUDE_START = 15 * Math.PI / 180;
const CELL_VARIANCE_LATITUDE_END = 60 * Math.PI / 180;
// 雲街の大きな包絡。全球雲場の赤道付近の約39 km texelでも alias しないよう128 km級の列を作り、
// 粒そのものの4〜12 km級のサイズは CloudShapeEvaluator へ委ねる。境界層高度の数倍という観測を
// 全球の低解像度場へ写すためのゲーム用の包絡値である。
const CLOUD_ROW_WAVELENGTH = 128_000;
// Melfi & Palm (2012) と Weckwerth et al. (1997) の雲街の伸長・波長比を踏まえ、中央の4を採用した
// 実装推定値。低解像度全球場へ焼くため、観測事例の境界層高度比をそのまま固定波長にはしない。
const CLOUD_ROW_ASPECT_RATIO = 4;
const CLOUD_ROW_LATITUDE_START = 30 * Math.PI / 180;
const CLOUD_ROW_LATITUDE_END = 60 * Math.PI / 180;
// 列を陸域へどれだけ持ち込むか、湿度へどれだけ足すか、風を列として認識し始める速さは、観測傾向を
// ゲームの被覆率へ写す実装推定値であり、雲街の普遍的な閾値ではない。
const CLOUD_ROW_LAND_GAIN = 0.75;
const CLOUD_ROW_HUMIDITY_GAIN = 0.12;
const CLOUD_ROW_WIND_START = 2;
const CLOUD_ROW_WIND_FULL = 8;
// 気団の折り目の帯(前線・雨帯)の中で、その重みを弱める割合(1 で帯の芯の粒が消える)。**帯は
// 隙間なく連なる面で、対流はそこでは穴ではなく雲頂の起伏と塔として出る**(`DEVELOP/SPEC/
// RENDERING.md`「帯に沿って幅数百キロの雲が隙間なく連なり…粒立った塔が列をなす」)。帯の中は
// 上昇流が頭打ちなので活発度も 1 に張り付き、粒の振れ幅(伝達関数の幅の ±1.6 倍)がそのまま乗る
// — 弱めないと、帯が被覆率の効き始めをまたぐ縁で、面ではなく点描のほつれになる。塔は別の項が
// 立てるので、ここを上げても帯の上の塔は残る。
const BAND_GRAIN_FADE = 0.8;
// 層状の雲の高さ [m]。雲底から、上昇流の深さが 1 に漸近する高さまで。上限は前線の乱層雲
// (4〜8 km)に取る — 塔はここではなく対流の峰が立てる。
const CLOUD_BASE_HEIGHT = 1000;
const LAYER_TOP_SPAN = 6000;
// 層状の深さを 0..1 へ収めるロジスティックの、上昇流 [per m/s] と対流の重み、そして底。
// 上昇流が頭打ち(0.06 m/s)の谷の芯で 5.5 km、並の低気圧(0.02 m/s)で 2.7 km、上昇流の無い所で
// 1.7 km(低い積雲の多数派)。**対流の重みは、同じ cap の中で雲頂が 1〜7 km に散る幅に取る**
// — 上昇流だけでは低気圧の上が一様な台地になる。ロジスティックは上端でも下端でも傾きが 0 に
// ならないので、被覆率が飽和した所でも対流の起伏が雲頂に残る。
const CLOUD_TOP_LIFT = 50;
const CLOUD_TOP_RELIEF = 27;
const CLOUD_TOP_BIAS = 2.05;
// 暖気の流入が層状の雲を持ち上げる重み [per rad]。前線の暖気側(0.35 rad)で乱層雲の高さ
// (4〜8 km)へ届く。
const WARM_TOP = 3;
// 気団の折り目の帯(前線・雨帯)が層状の雲を持ち上げる量。暖気の流入が前線の暖気側で足すのと同じ
// 大きさで、帯の中で乱層雲から積乱雲の高さ(5〜7 km)へ届く。
const BAND_TOP = 3;
// 塔が立つ粒の峰(粒 × 活発度)の縁。**幅は峰の標準偏差(≈ 0.1)と同じ程度に広く取る** —
// 縁を峰の頂点へ寄せると、塔は 1 texel の針になって数えるほどしか立たない。
const TOWER_ONSET = 0.015;
const TOWER_WIDTH = 0.09;
// 塔を閉じる沈降の門 [m/s]。高気圧の吹きおろす所では、粒の峰が立っても深い対流にはならない。
const TOWER_LIFT_GATE = 0.005;
// 海洋性層積雲へ移る気候の門。平年の雲量が高い海で、沈降と低い対流が重なるほど閉じた細胞の
// 板へ寄せる。海岸と気候の境界は climate map の補間と smoothstep で連続に渡る。
const STRATOCUMULUS_SUBSIDENCE_SCALE = 50;
const STRATOCUMULUS_HUMIDITY_ONSET = 0.42;
const STRATOCUMULUS_HUMIDITY_WIDTH = 0.20;
const STRATOCUMULUS_CLOUDINESS_ONSET = 0.48;
const STRATOCUMULUS_CLOUDINESS_WIDTH = 0.24;
const STRATOCUMULUS_ACTIVITY_ONSET = 0.35;
const STRATOCUMULUS_ACTIVITY_WIDTH = 0.45;
// 対流の形が網目から粒へ渡る湿度。雲の少ない所では細胞の壁(網目)、多い所では細胞の芯(粒)が
// 見える。**形を決める量は粒より低周波でなければならない** — 粒ごとに形が変わると並びが読めない
// ので、粒を足す前の湿度で決める。渡り始めは覆いの効き始めの少し下、渡り終わりはその 1 単位ぶん上。
const SHAPE_NETWORK_HUMIDITY = 0.45;
const SHAPE_GRAIN_HUMIDITY = 0.70;
// 薄い雲の光学的厚み τ は 2 項の和。靄の項は、上層の湿度が靄の効き始めを超えた分に比例して、並に
// 湿った所へ広くごく薄い幕を張る。筋の項は、筋の効き始めを超えた分の二乗で、湿度の峰にだけ濃い筋を
// 立てる — 薄い雲の大半はごく薄い靄で、濃く見えるのは筋状に束ねられた所だけ(`DEVELOP/SPEC/
// RENDERING.md`「高い雲は別の帯に乗る」)。二乗の項だけでは靄が消え、筋が黒地に浮く白い繊維になって
// 厚い雲に読める。膝は、二乗の τ が筋の利得を傾きにした直線と交わる超過量。上限は τ をそこへ
// 漸近させる tanh の頭打ちで、下地が常に e^−τ だけ透けることを保証する — 巻雲は不透明にならない。
// **2 つの利得と上限は同じ率で動かす** — そうすると τ がそのまま定数倍になり、靄と筋の濃さの比も
// 階調の順番も変わらないまま、薄い雲だけが一様に薄くなる。率は、±60° の輝度の平均が実写(分離した
// 薄い雲、0.135)の 3 分の 2 に収まる高さに取る — 薄い雲は下地を隠す幕ではなく、地表の色をわずかに
// 白ませるものとして見える(`DEVELOP/SPEC/RENDERING.md`「薄い雲の大半はごく薄い靄」)。いまの率では
// 上層の湿度 0.5 で τ 0.06、0.6 で 0.20、0.7 で 0.41、上端でも下地が半分以上透ける。
const TRANSLUCENT_HAZE_ONSET = 0.38;
const TRANSLUCENT_HAZE_GAIN = 0.49;
const TRANSLUCENT_STREAK_ONSET = 0.48;
const TRANSLUCENT_STREAK_GAIN = 1.75;
const TRANSLUCENT_KNEE = 0.25;
const TRANSLUCENT_LIMIT = 0.63;

// weather から凝結する雲のグラフ。被覆率は湿度(低周波)へ対流(高周波)を足した伝達関数から、
// 雲頂高度は層状の雲から立つ塔と、渦の芯が敷く金床の高いほうを雲底からの高さへ写して出す —
// 覆う広さは湿度が、層の高さは上昇流と暖気の流入と気団の折り目の帯が、塔は粒の峰が、平らな
// 天蓋は渦の芯が決める。**雲底からの高さは被覆率が低いほど縮み、広く覆う雲ほど元の高さを保つ**。
// **対流の活発度は被覆率と塔へ効き、沈降する海洋性層積雲では層状の起伏も低くなる** — 一面に
// 覆われた空も一様な白い面にはならない(`DEVELOP/SPEC/RENDERING.md`「雲の描画」)。
export function condense(weather: WeatherSample, direction: Vec3Node): CloudSample {
  // 網目と粒を湿度で混ぜる。混ぜると振れ幅が落ちるので、二乗和の平方根で戻す — 戻さないと
  // 渡りの中間(半々)に、粒の消えた平坦な帯ができる。
  const shape = smoothstep(SHAPE_NETWORK_HUMIDITY, SHAPE_GRAIN_HUMIDITY, weather.surfaceHumidity);
  const network = float(1).sub(shape);
  const convection = mix(weather.convection.y, weather.convection.x, shape)
    .mul(inverseSqrt(network.mul(network).add(shape.mul(shape))));
  const peak = convection.mul(weather.convectiveActivity);
  const granularity = peak.mul(CONVECTION_GAIN).mul(weather.band.mul(BAND_GRAIN_FADE).oneMinus());
  const rowBias = cloudRowBias(weather, direction);
  // 沈降する湿った海洋の低活発度の空では海洋性層積雲へ連続的に移り、前線帯ではその性質を薄める。
  const subsidence = max(weather.lift.negate(), 0);
  const stratocumulus = smoothstep(
    STRATOCUMULUS_HUMIDITY_ONSET,
    STRATOCUMULUS_HUMIDITY_ONSET + STRATOCUMULUS_HUMIDITY_WIDTH,
    weather.surfaceHumidity,
  )
    .mul(tanh(subsidence.mul(STRATOCUMULUS_SUBSIDENCE_SCALE)))
    .mul(smoothstep(
      STRATOCUMULUS_CLOUDINESS_ONSET,
      STRATOCUMULUS_CLOUDINESS_ONSET + STRATOCUMULUS_CLOUDINESS_WIDTH,
      weather.meanCloudiness,
    ))
    .mul(float(1).sub(weather.landFraction))
    .mul(smoothstep(
      STRATOCUMULUS_ACTIVITY_ONSET,
      STRATOCUMULUS_ACTIVITY_ONSET + STRATOCUMULUS_ACTIVITY_WIDTH,
      weather.convectiveActivity,
    ).oneMinus())
    .mul(weather.band.oneMinus());
  // 層状の雲: 上昇流と暖気の流入と折り目の帯が持ち上げる高さに、対流の起伏が乗る。
  const convectionRelief = mix(float(1), weather.convectiveActivity, stratocumulus);
  const depth = max(weather.lift, 0).mul(CLOUD_TOP_LIFT).add(weather.warmth.mul(WARM_TOP))
    .add(weather.band.mul(BAND_TOP)).add(convection.mul(CLOUD_TOP_RELIEF).mul(convectionRelief))
    .sub(CLOUD_TOP_BIAS);
  const layered = float(1).add(exp(depth.negate())).reciprocal().mul(LAYER_TOP_SPAN).add(CLOUD_BASE_HEIGHT);
  // 塔: 粒の正の側(細胞の芯)が柱として立ち、いちばん高いものが圏界面へ届く。高さは層状の雲から
  // 圏界面までを二乗で渡すので、低い塔が多く高い塔は少ない。**塔は、その場が覆われるほど湿っていて、
  // かつ沈降していない所にだけ立つ** — 乾いた土地と高気圧の下では、粒の峰が雲を作っても深い対流に
  // ならない。金床は眼を持つ渦の芯だけが敷く平らな天蓋で、圏界面まで届く。
  const grain = max(weather.convection.x, 0).mul(weather.convectiveActivity);
  const moist = smoothstep(COVERAGE_ONSET, COVERAGE_ONSET + COVERAGE_WIDTH, weather.surfaceHumidity);
  const rising = smoothstep(-TOWER_LIFT_GATE, TOWER_LIFT_GATE, weather.lift);
  const reach = smoothstep(TOWER_ONSET, TOWER_ONSET + TOWER_WIDTH, grain);
  const tower = layered.add(weather.tropopause.sub(layered).mul(reach.mul(reach)).mul(moist).mul(rising));
  const anvil = weather.anvil.mul(weather.tropopause);
  // 被覆率は、湿度が効き始めを超えた分を幅で割った t が張る、晴れている割合の補。下端は傾き 0 で
  // 0 から離れ、上端は 1 へ代数の裾で漸近する — 覆われた空にも湿度の差が階調として残る。
  const moistened = weather.surfaceHumidity.add(granularity).add(rowBias)
    .add(stratocumulus.mul(COVERAGE_WIDTH));
  const excess = max(moistened.sub(COVERAGE_ONSET), 0).div(COVERAGE_WIDTH);
  const clear = excess.mul(excess).div(COVERAGE_DISPERSION).add(1).pow(COVERAGE_DISPERSION).reciprocal();
  const coverage = clear.oneMinus();
  // 小さな雲を高い柱にしないため、雲底からの高さだけを被覆率で縮める。被覆率 0 では雲底へ
  // 落ちるが、その柱は CloudShapeEvaluator の連続したcoverage境界を通らないので晴天に雲や影が
  // 現れることはない。
  const cloudTop = max(tower, anvil);
  const scaledCloudTop = max(cloudTop.sub(CLOUD_BASE_HEIGHT), 0).mul(coverage).add(CLOUD_BASE_HEIGHT);
  // 薄い雲: 靄の項と筋の項の和を、上限へ漸近させる。
  const haze = max(weather.upperHumidity.sub(TRANSLUCENT_HAZE_ONSET), 0).mul(TRANSLUCENT_HAZE_GAIN);
  const streakExcess = max(weather.upperHumidity.sub(TRANSLUCENT_STREAK_ONSET), 0);
  const streak = streakExcess.mul(streakExcess).mul(TRANSLUCENT_STREAK_GAIN).div(TRANSLUCENT_KNEE);
  return {
    coverage,
    cloudTop: scaledCloudTop,
    translucent: tanh(haze.add(streak).div(TRANSLUCENT_LIMIT)).mul(TRANSLUCENT_LIMIT),
    cellSizeVariation: cellSizeVariationAt(weather),
  };
}

// 低層風に沿った雲列の包絡を作る。局所接平面の風向に直交する座標だけを約4倍伸ばしてノイズへ渡す
// ので、東西・南北だけでなく斜めの風にも列が追従する。陸域・中高緯度ほど効きを強め、経度の継ぎ目を
// またいでも方向ベクトルから直接評価するため列が切れない。128 kmは全球場での列の包絡で、セル自体の
// サイズ分散とは別の尺度である。
function cloudRowBias(weather: WeatherSample, direction: Vec3Node): FloatNode {
  const latitudeWeight = smoothstep(
    CLOUD_ROW_LATITUDE_START,
    CLOUD_ROW_LATITUDE_END,
    abs(weather.latitude),
  );
  const landWeight = clamp(weather.landFraction, 0, 1).mul(CLOUD_ROW_LAND_GAIN);
  // 緯度と陸域のどちらか一方だけでも列を許すが、両方の境界でmaxの折れ目を作らない。風が弱い所では
  // isotropicな雲場へ戻し、無風なのに風向きだけで列が立つことを防ぐ。
  const regionWeight = latitudeWeight.add(landWeight).sub(latitudeWeight.mul(landWeight));
  const eastWind = weather.surfaceWind.x;
  const northWind = weather.surfaceWind.y;
  const windSpeed = length(weather.surfaceWind);
  const rowWeight = regionWeight.mul(smoothstep(CLOUD_ROW_WIND_START, CLOUD_ROW_WIND_FULL, windSpeed));
  const windLength = max(windSpeed, 1e-3);
  const acrossWind = eastAt(direction).mul(northWind.negate().div(windLength))
    .add(northAt(direction).mul(eastWind.div(windLength)));
  const frequency = R_EARTH / CLOUD_ROW_WAVELENGTH;
  const aligned = gradientNoise(
    direction.mul(frequency).add(acrossWind.mul(frequency * (CLOUD_ROW_ASPECT_RATIO - 1))),
  );
  const envelope = smoothstep(-0.15, 0.35, aligned).sub(0.5);
  return envelope.mul(rowWeight).mul(CLOUD_ROW_HUMIDITY_GAIN);
}

// 地域ごとのセル幅プロファイルをGPU上で連続に評価する。代表幅は雲場へ保存し、分布のノイズは表面・
// 影が同じ対数正規幅から再現するため、4〜12 kmの揺らぎをミップで失わず海岸・緯度境界にも継ぎ目を作らない。
function cellSizeVariationAt(weather: WeatherSample): FloatNode {
  const latitudeWeight = smoothstep(
    CELL_VARIANCE_LATITUDE_START,
    CELL_VARIANCE_LATITUDE_END,
    abs(weather.latitude),
  );
  const lowOcean = CLOUD_CELL_VARIANCE_PROFILES.lowLatitudeOcean;
  const lowLand = CLOUD_CELL_VARIANCE_PROFILES.lowLatitudeLand;
  const highOcean = CLOUD_CELL_VARIANCE_PROFILES.highLatitudeOcean;
  const highLand = CLOUD_CELL_VARIANCE_PROFILES.highLatitudeLand;
  const oceanMeanScale = mix(lowOcean.meanScale, highOcean.meanScale, latitudeWeight);
  const landMeanScale = mix(lowLand.meanScale, highLand.meanScale, latitudeWeight);
  // サイズの空間ノイズは表面・影が読む場所で評価する。全球の低解像度雲場へ焼いてしまうと4〜12 km
  // の揺らぎがミップで消えるため、ここでは地域の代表サイズを0..1へ保存する。
  const meanScale = mix(oceanMeanScale, landMeanScale, clamp(weather.landFraction, 0, 1));
  return meanScale.sub(CLOUD_CELL_MEAN_SCALE_MIN)
    .div(CLOUD_CELL_MEAN_SCALE_MAX - CLOUD_CELL_MEAN_SCALE_MIN);
}
