// 天気のモデル。天体固定の単位方向と時刻から、気圧 → 風 → 上昇流 → 湿度・対流の天気を TSL の
// グラフで組む。時刻の閉じた関数で、同じ時刻には同じ空が出る。値はすべて見えのための調整値。
import { abs, clamp, cos, cross, dot, exp, max, min, normalize, sign, sin, smoothstep, sqrt, tan, tanh, vec2, vec4 } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { AirMass, extratropicalAt } from './air-mass';
import { AtmosphericWindField, SURFACE_HEIGHT, UPPER_CLOUD_HEIGHT } from './atmospheric-wind';
import { BakedField } from '../baked-field';
import { GPU_PASS } from '../gpu-timings';
import { CirculatingNoise } from './circulating-noise';
import { Circulation, SURFACE_BANDS, UPPER_BANDS } from './circulation';
import { ConvectiveActivity } from './convective-activity';
import { Cyclones } from './cyclones';
import { Highs } from './anticyclones';
import { HumidityModulator } from './humidity-modulation';
import { eastAt, latitudeOf, northAt } from './sphere-frame';
import { RossbyWave } from './rossby-wave';
import { SURFACE_HUMIDITY_BASE, WeatherTransport } from './weather-transport';
import {
  AIR_DENSITY, FRICTION_RATE, balancedWind, composeWind, coriolisRate, isobarAt,
} from './wind-law';
import type { WebGPURenderer } from 'three/webgpu';
import type { GpuTimingSink } from '../gpu-timings';
import type { NoiseOctave } from './circulating-noise';
import type { ClimateMap } from './climate-map';
import type { FieldProjection } from '../field-projection';
import type { BalancedWind } from './wind-law';
import type { FloatNode, Vec2Node, Vec3Node } from '../tsl-types';

// 単位方向における天気。
export interface WeatherSample {
  readonly pressure: FloatNode; // 平年からの偏差 [hPa]
  readonly surfaceWind: Vec2Node; // 地表の風の東向き・北向きの成分 [m/s]
  readonly upperWind: Vec2Node; // 上層の風の東向き・北向きの成分 [m/s]
  readonly lift: FloatNode; // 上昇流 [m/s](負なら下降)
  readonly surfaceHumidity: FloatNode; // 地表付近の湿度 0..1
  readonly upperHumidity: FloatNode; // 上層の湿度 0..1
  readonly convection: Vec2Node; // 対流セルの強弱(0 中心の高周波、x が粒・y が網目)
  readonly convectiveActivity: FloatNode; // 対流の強弱がどれだけ強く現れるか 0..1
  readonly compression: FloatNode; // 気団の境目の押し縮まり(1 で何も起きていない)
  readonly band: FloatNode; // 気団の折り目に立つ雲の帯(温帯で前線、眼を持つ渦のまわりで雨帯)の強さ 0..1
  readonly warmth: FloatNode; // 暖気の流入 = 出身地からの緯度の差 [rad](負で寒気)
  readonly anvil: FloatNode; // 金床(平らな天蓋)の濃さ 0..1
  readonly meanCloudiness: FloatNode; // 平年の雲量 0..1
  readonly landFraction: FloatNode; // 陸らしさ 0..1
  readonly tropopause: FloatNode; // その緯度の対流の天井(圏界面の高さ)[m]
}

// 気圧フィールドからサンプリングした、風向風速の算出に必要な物理量。gradient は気圧勾配の接ベクトル [hPa/rad]、isobar は
// 等圧線方向の単位接ベクトル、bend は等圧線方向の 2 階微分 [hPa/rad²]。
interface PressureField {
  readonly pressure: FloatNode;
  readonly gradient: Vec3Node;
  readonly isobar: Vec3Node;
  readonly bend: FloatNode;
}

// ノイズのオクターブ定義表。周波数は 1 rad あたりの山数で、角波長 [km] は 6371 ÷ 周波数。
// この段はエポックの混ぜ替えに参加し、気圧の谷と峰は流れに乗るだけでなくその場でも発達・衰退する。
// 総観規模(1400〜5300 km)の谷と峰は包絡(温帯らしさ)で膨らむ — 中緯度と高緯度の海では
// 数百キロの気圧の起伏が熱帯の数倍強く、熱帯は気圧が平らなまま
// (`DEVELOP/SPEC/RENDERING.md`「気圧の起伏・風・上昇流の強さと頻度は、地球の大気で観測される分布に従う」)。
const PRESSURE_NOISE: readonly NoiseOctave[] = [
  { frequency: 1.2, amplitude: 1 }, // 5300 km
  { frequency: 2.4, amplitude: 0.7, envelope: 1.5 }, // 2650 km — 温帯で 2.5 倍
  { frequency: 4.5, amplitude: 0.45, envelope: 2.4 }, // 1400 km — 温帯で 3.4 倍(熱帯は 0.45)
];
// 上層の風へ重ねる中規模の蛇行。単一オクターブ (800 km) のノイズで、総観規模のロスビー波と
// 渦だけだった筋の向きの場に、100〜1000 km の尺度で滑らかに変わる自由度を足す。向きの
// 振れ幅は ±14° ほどで、向きが画素ごとにばらつくほどではない。
const UPPER_MEANDER_NOISE: readonly NoiseOctave[] = [
  { frequency: 8, amplitude: 1 }, // 800 km
];
const UPPER_MEANDER_MAX_ANGLE = 0.25; // [rad]
// 場の振れ幅 [hPa]。オクターブ数によらない。
const PRESSURE_NOISE_AMPLITUDE = 18;

// 気圧のラプラシアンを取る中心差分の刻み [rad](約 320 km)。気圧の谷・峰の曲がりを、数百キロの
// 総観規模で測る — 勾配の刻み(64 km)で取ると、写しの texel 間の量子化と粒状の起伏が曲がりへ
// 混ざる。
const LAPLACIAN_STEP = 0.05;
// 摩擦層の収束が立てる上昇流(エクマン・ポンピング)。w = ∇²p · D / (2 ρ f̂)。低気圧のまわりの
// 摩擦層の収束は上昇、高気圧のまわりの発散は沈降になる。実効の深さ D [m] は観測の上昇流の分布
// (∇²p ≈ 60 hPa/(1000 km)² の芯で 0.02 m/s 級)に取る。f̂ = √(f² + 摩擦²) で、コリオリの
// 消える赤道へ発散しない下支えを掛ける(wind-law の damped と同じ形)。
const EKMAN_DEPTH = 1000;
// 暖気の移流で上昇・寒気の移流で沈降する分 [m/s per rad]。準地衡の ω 方程式の向きに、並の
// 移流(±0.3 rad)が ±0.01 m/s 級を受け持つ幅に取る。
const ADVECTION_LIFT = 0.07;
// 気圧配置に従わない中規模の上昇・沈降。流れに乗って運ばれる 300〜1500 km の場 — これが無いと
// 上昇流が気圧の一意な関数になり、雲の形が気圧配置から一意に決まってしまう
// (`DEVELOP/SPEC/RENDERING.md`「同じ気象条件でも、雲の形は一つに決まらない」)。総観規模の
// 2 段はエポックの混ぜ替えでその場でも発達・衰退する。
const MESOSCALE_LIFT_NOISE: readonly NoiseOctave[] = [
  { frequency: 4.2, amplitude: 1, envelope: -0.5 }, // 1500 km — 温帯で 0.5 倍
  { frequency: 8.5, amplitude: 0.7, envelope: -0.5 }, // 750 km — 温帯で 0.5 倍
  { frequency: 21, amplitude: 0.4 }, // 300 km
];
const MESOSCALE_LIFT_EPOCH_MAX = 8.5;
const MESOSCALE_LIFT = 0.06;
// 嵐の走る帯より極側では、気圧の曲がりに従う上昇流(摩擦層の収束・移流)が冷たい海の浅い
// 摩擦層で弱まる一方、極低気圧や寒気の吹きおろしなど気圧配置に従わない上昇・沈降は残る —
// 中規模の場の分担を 55〜75° へ向けて元の大きさへ戻す(戻さないと上昇流が渦の曲がりへ
// 実写より強く結び付く)。
const MESOSCALE_POLAR_KEEP = 0.55;
const MESOSCALE_POLAR_END = THREE.MathUtils.degToRad(75);
// 同じ理由で、冷たい海の浅い摩擦層の収束は帯状平均より弱い — エクマン項も極側で絞る。
const EKMAN_POLAR_CUT = 0.35;
// 中規模の場の非対称化: 上昇は狭く強く、沈降は広く弱い(同じ仕様の文)。場の値を n·(1 + κ·n⁺) で
// 変換し、正の側を二乗で伸ばす — 線形の利得では場が 0 のまわりに固まりすぎて強い上昇の裾が出ない。
// 沈降側にも浅い利得を掛ける — 実写の沈降の裾(高気圧の広い吹きおろし)は対称な場では届かない深さへ
// 及ぶ。変換で偏った平均は重心 κ·E[n²⁺] − (γ−1)·E[n⁻] だけ引いて 0 に戻す。
const MESOSCALE_SKEW = 12;
const MESOSCALE_SINK_GAIN = 1.3;
const MESOSCALE_LIFT_OFFSET = MESOSCALE_SKEW * 0.007 - (MESOSCALE_SINK_GAIN - 1) * 0.03;
// 上昇と沈降を釣り合わせる、広く弱い吹きおろしの分 [m/s]。前線の帯と地形が持ち上げた分だけを
// 埋め合わせる — 渦と中規模の場は自身の中で釣り合っている(`DEVELOP/SPEC/RENDERING.md`
// 「上昇する空と沈降する空は釣り合う」)。埋め合わせる相手の帯は温帯でしか立たないので、戻りも
// 温帯らしさで重み付けする(熱帯では前線の帯がほぼ立たないので戻りもほぼ要らない — 熱帯の沈降は
// 中規模の場の負側が既にハードリー循環の下降枝を担っている)。
const MASS_RETURN = 0.026;
const MASS_RETURN_TROPIC = 0.05;
// 戻りを受け持つ帯(偏西風帯の中)。温帯らしさから極側の裾(55〜70°)を引いた重み — 帯の立たない
// 高緯度では、持ち上げる相手が無いのに広く引き続けると沈降が実写より深く張り付く。
const STORM_TRACK_POLE_START = THREE.MathUtils.degToRad(55);
const STORM_TRACK_POLE_END = THREE.MathUtils.degToRad(70);
// 上昇流の頭打ち [m/s]。急な斜面と深い谷の芯では上昇流が並の何倍にもなり、線形のままだと湿度が
// 0/1 で切れて硬い縁の白い塊になる。
const LIFT_LIMIT = 0.06;
// 前線帯の強度計算。気団の圧縮度が立ち上がり閾値から遷移幅に達する間に、帯の強度が 0 から 1 へ推移する。開始閾値は 35〜60° 緯度帯の
// 背景圧縮度の上側の裾(9 割方を少し越える辺り)に設定する — 渦の強い気圧場で押し縮まりの分布
// 全体がおよそ倍に膨らんだため、帯の占める割合(全球平均で 0.15〜0.2)が保たれる高さへ置き直す。
// 遷移幅は圧縮の稜線が飽和する狭さに調整し、最も高密度の中心核に帯幅を確保する。
const FRONT_ONSET = 3.6;
const FRONT_WIDTH = 0.9;
// 前線を強化する湿度水平勾配の開始閾値と遷移幅 [1/rad]。乾湿境界にも雲帯を生成する。
// 遷移幅は湿度テクスチャの量子化誤差に対して十分なマージンを確保する。
const MOISTURE_GRADIENT_ONSET = 0.12;
const MOISTURE_GRADIENT_WIDTH = 0.28;
// 雨帯。眼を持つ渦が周りの気団を巻き込んで折り畳んだ筋で、圧縮は前線より桁が大きい(腕の稜線で 5〜9)。
// 稜線の最も押し縮まった区間だけが飽和して腕の先へ連続に薄れる幅に取り、芯のまわりのシアの丘(2〜4)と
// 熱帯の背景(99.9 パーセンタイルで 3.2)を拾わない。狭めると腕が太い真っ白な帯になる
// (`DEVELOP/SPEC/RENDERING.md`「雨帯は、渦が周りの気団を巻き込んで折り畳んだ筋に沿う」)。
const RAINBAND_ONSET = 5;
const RAINBAND_WIDTH = 4;
// 帯が飽和した所で立つ上昇流 [m/s]。深い谷の芯と同じだけ持ち上げるよう、頭打ち(LIFT_LIMIT)に揃える。
const BAND_LIFT = 0.06;
// 帯が飽和した所で地表付近の湿度へ足す底上げ。被覆率の伝達関数の幅(0.22)の 0.45 倍に取る —
// 帯の芯では上昇流による偏差の増幅(VORTEX_CONTRAST)と合わせて被覆率が上端へ届き途切れない帯に
// なるが、前線帯の面全体が湿度の上限へ張り付いて一枚の台地にはならない
// (`DEVELOP/SPEC/RENDERING.md`「前線の帯そのものが、その空でいちばん厚い雲になる」)。
const BAND_HUMIDITY = 0.1;
// 風が斜面を駆け上がる分の利得。等倍では偏西風や貿易風が山脈へ当たり続けるだけで上昇流が頭打ちに
// 達し、地形の縞が年中貼り付く — 慢性的な湿潤・乾燥は平年の雲量が持つ。
const TERRAIN_LIFT_GAIN = 0.35;
// 陸へ上乗せする高さ [m]。海と陸の比熱の差を、海岸へ吹き込む風が駆け上がる斜面として代用する。
const LAND_HEIGHT_BIAS = 800;
// 上昇流が湿度へ寄与する伝達利得 [per m/s]。地表付近の加湿は、底上げ成分（本項）と偏差増幅成分
// (VORTEX_CONTRAST) に分離して計算する。
// 地表付近の沈降の乾きは上昇より弱く取る — 海洋境界層は沈降の下でも層積雲を保ち、同じ利得では
// 亜熱帯高圧帯の下の海が丸ごと晴れる。
const SURFACE_LIFT_HUMIDITY = 1.3;
const SURFACE_SUBSIDENCE_DRYING = 1.0;
// 上層は上昇流の断熱冷却で氷飽和へ達するので、地表付近より強く湿る — 前線帯・ITCZ の
// 収束域・低気圧の前方に組織だった巻雲を作る項。小さいと天候系の場面差がノイズに埋もれる。
const UPPER_LIFT_HUMIDITY = 1.0;
// 上昇流が、移流した地表付近の湿度の偏差(源の底上げ SURFACE_HUMIDITY_BASE からの揺れ)を増幅する利得。
// 頭打ち(LIFT_LIMIT)に張り付いた所で偏差は (1 + 利得) 倍 — 1 で 2 倍になる。
const VORTEX_CONTRAST = 1.0;
// 沈降が上層を乾かす利得 [per m/s]。上層には境界層のような湿りの溜まりが無いので、地表付近より
// 強く乾く — 高気圧の吹きおろす所では薄い雲も消える。
const UPPER_SUBSIDENCE_DRYING = 2;

// 圏界面の高さ [m] とその緯度依存。熱帯で 16〜17 km、極で 9 km 前後で、亜熱帯のジェットの下で
// 段をなして下がる(NCAR ACOM「Cloud Tops and Tropopause」)。深い対流はここに当たって横へ広がる
// ので、対流の天井そのものになる。
const TROPOPAUSE_EQUATOR = 17000;
const TROPOPAUSE_POLE = 9000;
const TROPOPAUSE_STEP_START = THREE.MathUtils.degToRad(15);
const TROPOPAUSE_STEP_END = THREE.MathUtils.degToRad(60);

// 大循環の気圧帯 [hPa]: 赤道と ±60° 過ぎが低く、±30° と極が高い。帯の形は 6 倍の余弦だけでは
// 作れない — 赤道の谷は浅く(数 hPa)、亜極の谷は深い(−20 hPa 級)ので、余弦のうえへ ±65° を
// 中心にしたガウス状の亜極トラフを重ねる。副熱帯高圧帯も余弦の山より狭く高い(実測の帯状平均で
// ±30〜40° に +5 hPa 級)ので、こちらも ±34° の鐘として足す。帯の振舞いはこの関数の微分までが
// 定義(勾配は風へ、ラプラシアンは上昇流の帯成分の差し引きへ使う)。
const PRESSURE_BAND_AMPLITUDE = 3.5;
const SUBTROPICAL_HEIGHT = 6;
const SUBTROPICAL_LATITUDE = THREE.MathUtils.degToRad(34);
const SUBTROPICAL_WIDTH = 0.28; // [rad]
const SUBPOLAR_DEPTH = 13;
const SUBPOLAR_LATITUDE = THREE.MathUtils.degToRad(65);
const SUBPOLAR_WIDTH = 0.18; // [rad]

// 気圧の勾配を取る中心差分の刻み [rad]。台風の芯の広がり(250 km ≈ 0.039 rad)より細かく、
// 気圧の写しの 1 texel より粗い。写しは視点中心の cap なので texel の角は視点の高さで変わるが、
// いちばん粗い置き方(半径 π/2)でも 2/512 ≈ 3.9e-3 rad で、この刻みを越えない。
const GRADIENT_STEP = 0.01;
// 等圧線方向の 2 階微分を取るサンプリング刻み [rad]。半精度テクスチャにおける 2 階差分の量子化ノイズは刻みの二乗で
// 増幅される。勾配と同じ刻みで取ると、帯とノイズだけの平らな所で曲がりが雑音に埋もれる。
const BEND_STEP = 0.02;
// 対流を流す風の摩擦 [1/s]。湿度を流す風より強く取ると、等圧線を深く横切って 20〜30° 違う向きへ
// 伸びる。同じ風で流すと 2 枚が同じ向きへ伸びて、掛け合わせても筋のままになる。
const CONVECTION_FRICTION = 3 * FRICTION_RATE;
// 風が等圧線を横切る角の上限 [rad]。湿度の風は中緯度で摩擦が作る角(45° で 30°)そのものに取る。
// 対流の風は摩擦が作る 60° を 50° に抑え、湿度の風と向きを 20° 離して 2 枚の移流場を交差させる。
// 熱帯では両方が大きな流入角を切り、台風のまわりで粒が放射状の筋に引かれるのを止める。
const SURFACE_WIND_CROSSING_LIMIT = THREE.MathUtils.degToRad(30);
const CONVECTION_WIND_CROSSING_LIMIT = THREE.MathUtils.degToRad(50);
// 上層の風の摩擦と横切り角。自由大気では摩擦層の減衰が無く、風はほぼ等圧線に沿って速く吹く —
// 地表と同じ摩擦では上層風が下層風の写しになり、鉛直シアが風速差だけの平板な場になる。
const UPPER_FRICTION = 0.35 * FRICTION_RATE;
const UPPER_WIND_CROSSING_LIMIT = THREE.MathUtils.degToRad(10);
// 上層の局所風の振幅。対流圏を登るにつれ総観規模の渦の風速は増え、300 hPa では地表のおよそ 2 倍
// (熱風バランス)。同じ気圧場から同じ速さで引くと |上層風| の床が帯状平均の 20 m/s 強に張り付き、
// 実写にある穏やかな上層の区画が出ない。
const UPPER_LOCAL_GAIN = 1.15;
// 写しの遡りに使う偏差風へ効かせる気圧の偏差の弱め。谷の裾野が遠方まで積み上がって作る
// 平野部の偏差風は、実写のブロック追跡で同じ物差しに合わせると約2倍速い見かけの移流を
// 生む。総観規模の流れだけが模様を運ぶよう、遡りに使う分だけ偏差を絞る。
const ADVECTION_EDDY_SCALE = 0.3;

// 渦の目が移流後の湿度から引く深さ。眼壁の飽和と金床の天蓋(ANVIL_HUMIDITY)の両方を貫く深さに
// 取る。上層を深く引いて、薄い雲の穴を厚い雲の目よりひとまわり広く開ける。
const SURFACE_EYE_DRYNESS = 0.8;
const UPPER_EYE_DRYNESS = 2;
// 金床の天蓋が地表付近の湿度へ足す高さ。天蓋の芯では並の湿度からでも雲量が飽和する分を足すが、
// 円盤の縁まで一様に上限へ張り付かせないよう、天蓋自身の濃さの落ち際と合わせて効かせる。
const ANVIL_HUMIDITY = 0.2;
// 温暖湿気の輸送路が上層の湿度へ足す量。低気圧の前方・極側へ巻雲の盾を作る —
// 中緯度の帯状の巻雲(千〜二千 km)の担い手。
const WCB_UPPER_HUMIDITY = 0.03;
// 暖気流入が地表付近の湿度へ寄与する伝達利得 [per rad]。平均的な暖気流入（0.26 rad）で伝達関数幅の約半分が
// 変位する係数。本項の期待値が正のため、基底湿度 (SURFACE_HUMIDITY_BASE) をオフセットして均衡させる。
const WARM_HUMIDITY = 0.6;
// 移流後に足す平年の雲量の重み(地表付近と上層)。雲量の地理的な差が凝結のしきい値をまたぐ幅に
// 取る — 小さいと砂漠にも海と同じだけ雲が湧き、大きいと雲の多い海が覆われたまま平年の雲量図が
// 貼り付く。地表付近は、貼り付いた図が中緯度の長波長スペクトルの過剰の支配項だったので半分に
// 弱め、減った平均ぶんは基底湿度の底上げで埋める(cloud-lab Phase 3-10)。上層は薄い雲の分布が
// 平年の図へ素直に従うので強めに取る — 上層湿度のノイズを実写の乾湿対比へ上げたあと、場面間の
// 差(亜熱帯の乾域と上昇枝の湿域)を残すには気候の項を同じ程度の振れ幅まで戻す必要がある。
const SURFACE_MEAN_CLOUDINESS_WEIGHT = 0.15;
const UPPER_MEAN_CLOUDINESS_WEIGHT = 0.2;
// 平年の雲量を湿度へ渡す S 字の裾と肩。線形では、砂漠を晴らす重みで雲の多い海が覆われたまま動かなく
// なる。裾は砂漠(0.14)の下、肩は年中曇りの海(0.89)の側に置く — 狭めると乾いた大陸(0.43〜0.51)や
// 貿易風帯の海(0.50〜0.65)まで雲を失う。
const MEAN_CLOUDINESS_DRY = 0.10;
const MEAN_CLOUDINESS_WET = 0.85;

export class WeatherModel {
  // 大循環の平均風。地表付近と上層の背景風をここから引く。
  private readonly atmosphericWind = new AtmosphericWindField();
  private readonly surfaceCirculation: Circulation;
  private readonly upperCirculation: Circulation;
  private readonly rossbyWave = new RossbyWave();
  private readonly cyclones: Cyclones;
  private readonly highs: Highs;
  private readonly pressureNoise: CirculatingNoise;
  private readonly mesoscaleLift: CirculatingNoise;
  private readonly upperMeander: CirculatingNoise;
  private readonly transport: WeatherTransport;
  private readonly pressure: BakedField;
  private readonly convectiveActivity: ConvectiveActivity;
  private readonly airMass: AirMass;
  private readonly humidityModulator: HumidityModulator;

  // 時刻 0 の天気で始める。climate はこの天体の気候の事前分布、projection は写しの持ち方、
  // surfaceRadius は天体の半径 [m]、rotationPeriod は自転周期 [s]。
  public constructor(
    private readonly climate: ClimateMap, projection: FieldProjection,
    private readonly surfaceRadius: number, private readonly rotationPeriod: number,
  ) {
    const texel = projection.texelAngle;
    this.surfaceCirculation = new Circulation(SURFACE_BANDS, surfaceRadius);
    this.upperCirculation = new Circulation(UPPER_BANDS, surfaceRadius);
    this.cyclones = new Cyclones(surfaceRadius, rotationPeriod);
    this.highs = new Highs(surfaceRadius, rotationPeriod);
    this.pressureNoise = new CirculatingNoise(
      this.surfaceCirculation, PRESSURE_NOISE, texel,
      [{ untilFrequency: PRESSURE_NOISE[0]!.frequency, transitionSeconds: 18 * 3600 }]);
    this.mesoscaleLift = new CirculatingNoise(
      this.surfaceCirculation, MESOSCALE_LIFT_NOISE, texel,
      [{ untilFrequency: MESOSCALE_LIFT_EPOCH_MAX, transitionSeconds: 18 * 3600 }]);
    this.upperMeander = new CirculatingNoise(this.upperCirculation, UPPER_MEANDER_NOISE, texel);
    this.pressure = new BakedField(
      'pressure', THREE.RedFormat, projection, (direction) => vec4(this.pressureSourceAt(direction), 0, 0, 1),
      GPU_PASS.cloudBake);
    this.convectiveActivity = new ConvectiveActivity(this.surfaceCirculation, projection);
    this.airMass = new AirMass(projection, (direction) => this.traceFlowAt(direction), surfaceRadius);
    // 湿度の源の変調が気圧・気団・活発度を読むので、それらのあとに組む。
    this.humidityModulator = new HumidityModulator(this.airMass, this.convectiveActivity, this.climate);
    this.transport = new WeatherTransport(
      this.surfaceCirculation, this.upperCirculation, projection, surfaceRadius,
      (direction) => {
        const latitude = latitudeOf(direction);
        const warmth = this.airMass.at(direction, latitude).warmth.mul(extratropicalAt(latitude));
        return this.humidityModulator.at(
          direction, this.dynamicsLiftAt(direction, latitude, eastAt(direction), northAt(direction), warmth));
      });
    this.syncTime(0);
  }

  // いまの時刻の気圧と、移流前の場を写しへ焼く。syncTime のあと、weatherAt のグラフを描く前に呼ぶ。
  public bake(renderer: WebGPURenderer, gpu?: GpuTimingSink): void {
    this.pressure.render(renderer, gpu);
    // 気団は気圧の写しを読んで遡るので、気圧の後に焼く。
    this.airMass.bake(renderer, gpu);
    this.convectiveActivity.bake(renderer, gpu);
    // 湿度の源は気圧・気団・活発度の写しを読むので、それらの後に焼く。
    this.transport.bake(renderer, gpu);
  }

  // 時刻 [s] を各サブシステムの uniform へ反映する。
  public syncTime(seconds: number): void {
    this.surfaceCirculation.syncTime(seconds);
    this.upperCirculation.syncTime(seconds);
    this.rossbyWave.syncTime(seconds);
    this.cyclones.syncTime(seconds);
    this.highs.syncTime(seconds);
    this.pressureNoise.syncTime(seconds);
    this.mesoscaleLift.syncTime(seconds);
    this.upperMeander.syncTime(seconds);
    this.convectiveActivity.syncTime(seconds);
    this.transport.syncTime(seconds);
  }

  // 単位方向 direction における天気のグラフ。
  public weatherAt(direction: Vec3Node): WeatherSample {
    const latitude = latitudeOf(direction);
    const east = eastAt(direction);
    const north = northAt(direction);

    const pressureField = this.pressureFieldAt(direction, east, north);
    const { pressure } = pressureField;
    const { rossby, surfaceWind, upperWind, surfaceAdvection, convectionAdvection, upperAdvection } =
      this.windFieldAt(direction, latitude, east, north, pressureField);

    // 風で流した湿度・対流と、前線を強める湿度の勾配。移流の遡りは、大循環の平均風からの
    // 偏差(局所の釣り合い風とロスビー波の摂動)で取る — 源の模様の平行移動は、写しを焼く
    // 循環が平均風で既に担っている。平均風まで遡りに含めると両者が打ち消し合い、模様は
    // 周期の中で混ざり合うだけで流れも形の変化も鈍る。上層の偏差風だけに中規模の蛇行を
    // 重ねる — 筋の向きがその尺度で滑らかに変わる。
    const advected = this.transport.advectedAt(
      direction,
      composeWind(surfaceAdvection, rossby),
      this.meanderUpperWind(composeWind(upperAdvection, rossby), direction),
      composeWind(convectionAdvection, rossby),
    );
    const moistureGradient = this.moistureGradientAt(direction, east, north);

    // 上昇流: 風が斜面を駆け上がる分と、渦・移流が立てる分と、気団の境目が押し上げる分。
    const windComponents = eastNorthComponents(surfaceWind.velocity, east, north);
    const airMass = this.airMass.at(direction, latitude);
    const extratropical = extratropicalAt(latitude);
    const warmth = airMass.warmth.mul(extratropical);
    const terrainLift = dot(windComponents, this.climate.slope(direction, LAND_HEIGHT_BIAS, this.surfaceRadius))
      .mul(TERRAIN_LIFT_GAIN);
    const dynamicsLift = this.dynamicsLiftAt(direction, latitude, east, north, warmth);
    // 折り目の帯: 温帯では前線(気団の圧縮へ、湿度の境目と気圧の上昇流を少し足す)、熱帯では雨帯の
    // 伝達関数が圧縮の稜線を降雨帯の強度へマッピングする。
    const updraft = smoothstep(0.01, 0.04, max(dynamicsLift, 0));
    const temperatureFront = smoothstep(FRONT_ONSET, FRONT_ONSET + FRONT_WIDTH, airMass.compression);
    const moistureFront = smoothstep(
      MOISTURE_GRADIENT_ONSET,
      MOISTURE_GRADIENT_ONSET + MOISTURE_GRADIENT_WIDTH,
      moistureGradient,
    );
    const front = temperatureFront.add(moistureFront.mul(0.2)).add(updraft.mul(0.15)).min(1).mul(extratropical);
    const rainband = smoothstep(RAINBAND_ONSET, RAINBAND_ONSET + RAINBAND_WIDTH, airMass.compression)
      .mul(extratropical.oneMinus());
    // 低気圧の実体が持つ前線の帯(寒冷・温暖) — 気団の圧縮からの診断とは別の担い手で、
    // 低気圧の芯から伸びる一貫した帯を作る。両者の大きい側を取る。
    const cycloneFront = this.cyclones.frontAt(direction);
    const band = min(max(front.add(rainband), cycloneFront), 1);
    const bandLift = band.mul(BAND_LIFT);
    const stormTrack = extratropical.mul(
      smoothstep(STORM_TRACK_POLE_START, STORM_TRACK_POLE_END, abs(latitude)).oneMinus(),
    );
    const massReturn = stormTrack.mul(1 - MASS_RETURN_TROPIC).add(MASS_RETURN_TROPIC).mul(MASS_RETURN);
    const lift = limitLift(terrainLift.add(dynamicsLift).add(bandLift).sub(massReturn));

    // 湿度: 流した写しへ、場所と渦に貼り付く項(平年の雲量・上昇流・帯・金床・目)を足し引きする。
    const meanCloudiness = this.climate.meanCloudiness(direction);
    // 平年雲量バイアスの重みを緯度で絞る: 熱帯は 1.0 のまま、中緯度では半分にする。
    // 最長波長の担い手のうち中緯度側の分だけを切り、ITCZ は保つ。
    const surfaceBiasWeight = extratropical.oneMinus().mul(0.5).add(0.5);
    const landFraction = this.climate.landFraction(direction);
    const eye = this.cyclones.eyeAt(direction);
    const anvil = this.cyclones.anvilAt(direction);
    const deviation = advected.surfaceHumidity.sub(SURFACE_HUMIDITY_BASE);
    const surfaceHumidity = clamp(
      advected.surfaceHumidity.add(deviation.mul(max(lift, 0).div(LIFT_LIMIT)).mul(VORTEX_CONTRAST))
        .add(cloudinessBias(meanCloudiness).mul(SURFACE_MEAN_CLOUDINESS_WEIGHT).mul(surfaceBiasWeight))
        .add(max(lift, 0).mul(SURFACE_LIFT_HUMIDITY)).add(min(lift, 0).mul(SURFACE_SUBSIDENCE_DRYING))
        .add(warmth.mul(WARM_HUMIDITY)).add(band.mul(BAND_HUMIDITY))
        .add(anvil.mul(ANVIL_HUMIDITY)).sub(eye.mul(SURFACE_EYE_DRYNESS)), 0, 1);
    const upperHumidity = clamp(
      advected.upperHumidity.add(cloudinessBias(meanCloudiness).mul(UPPER_MEAN_CLOUDINESS_WEIGHT))
        .add(max(lift, 0).mul(UPPER_LIFT_HUMIDITY)).add(min(lift, 0).mul(UPPER_SUBSIDENCE_DRYING))
        .add(this.cyclones.wcbAt(direction).mul(WCB_UPPER_HUMIDITY))
        .sub(eye.mul(UPPER_EYE_DRYNESS)), 0, 1);

    return {
      pressure,
      surfaceWind: windComponents,
      upperWind,
      lift,
      surfaceHumidity,
      upperHumidity,
      convection: advected.convection,
      convectiveActivity: this.convectiveActivity.at(
        direction, lift, warmth, this.climate.landFraction(direction), band),
      compression: airMass.compression,
      band,
      warmth,
      anvil,
      meanCloudiness,
      landFraction,
      tropopause: tropopauseAt(latitude),
    };
  }

  // 単位方向 direction で雲を運ぶ、地表付近と上層の風の東・北の成分 [m/s]。weatherAt の風と同じ式で、
  // 湿度・気団のグラフを通らない。焼いた気圧の写しを読むので、bake のあとに描く。
  public windsAt(direction: Vec3Node): { readonly surfaceWind: Vec2Node; readonly upperWind: Vec2Node } {
    const latitude = latitudeOf(direction);
    const east = eastAt(direction);
    const north = northAt(direction);
    const { surfaceWind, upperWind } = this.windFieldAt(
      direction, latitude, east, north, this.pressureFieldAt(direction, east, north));
    return { surfaceWind: eastNorthComponents(surfaceWind.velocity, east, north), upperWind };
  }

  // 風: 局所的な気圧風へ、大循環の背景風(地表付近/上層)とロスビー波を重ねる。上層の風は巻雲の筋が
  // 従う流れで、東・北の成分で返す。
  private windFieldAt(
    direction: Vec3Node, latitude: FloatNode, east: Vec3Node, north: Vec3Node, field: PressureField,
  ) {
    // 地表付近・対流・上層の局所の釣り合い風を同じ気圧の場から引き、背景風と重ねる。
    const { gradient, bend } = field;
    // 副熱帯の尾根(帯状平均)のぶんは渦の風を解く勾配から差し引く — 尾根が駆動する平均流は
    // atmosphericWind の平均風プロファイルが既に担っている。等圧線に沿った曲がりへも尾根の
    // p''(φ) が等圧線の傾きぶん (isobar·north)² だけ漏れるので、そちらも差し引く。
    const eddy = gradient.sub(north.mul(ridgeSlopeAt(latitude)));
    const isobar = isobarAt(direction, eddy);
    const isobarNorth = dot(isobar, north);
    const eddyBend = bend.sub(ridgeCurvatureAt(latitude).mul(isobarNorth.mul(isobarNorth)));
    const rossby = this.rossbyWave.perturbationAt(direction, this.surfaceRadius);
    const surfaceMean = this.atmosphericWind.sampleNode(latitude, SURFACE_HEIGHT);
    const surfaceBackground = east.mul(surfaceMean.x).add(north.mul(surfaceMean.y)).add(rossby);
    const surfaceLocal = balancedWind(
      eddy, isobar, eddyBend, latitude, FRICTION_RATE, SURFACE_WIND_CROSSING_LIMIT,
      this.surfaceRadius, this.rotationPeriod,
    );
    const upperLocalRaw = balancedWind(
      eddy, isobar, eddyBend, latitude, UPPER_FRICTION, UPPER_WIND_CROSSING_LIMIT,
      this.surfaceRadius, this.rotationPeriod,
    );
    const upperLocal = {
      velocity: upperLocalRaw.velocity.mul(UPPER_LOCAL_GAIN),
      turn: upperLocalRaw.turn.mul(UPPER_LOCAL_GAIN),
    };
    const surfaceWind = composeWind(surfaceLocal, surfaceBackground);
    const upperMean = this.atmosphericWind.sampleNode(latitude, UPPER_CLOUD_HEIGHT);
    const upperBackground = east.mul(upperMean.x).add(north.mul(upperMean.y)).add(rossby);
    const upperWind = eastNorthComponents(composeWind(upperLocal, upperBackground).velocity, east, north);
    // 写しの遡りに使う偏差風は、気圧の偏差を弱めて解く。気圧の場のテクスチャ1画素ぶんの
    // 細かい構造(谷の裾野の累積やノイズの凹凸)までそのまま釣り合い風へ変換すると、雲塊を
    // まとめて運ぶ総観規模の流れより速い見かけの移流が出る — 実写と同じ物差しで見かけの
    // 速度が読み戻した風の約2倍になり、遡りを切ると実写の域へ戻った。場所ごとの風
    // (地表面の風・地形の上昇流)には元の釣り合い風を残す。
    const advectionGradient = eddy.mul(ADVECTION_EDDY_SCALE);
    const advectionBend = eddyBend.mul(ADVECTION_EDDY_SCALE);
    const advectionWind = (friction: number, crossing: number): BalancedWind =>
      balancedWind(advectionGradient, isobar, advectionBend, latitude, friction, crossing,
        this.surfaceRadius, this.rotationPeriod);
    const surfaceAdvection = advectionWind(FRICTION_RATE, SURFACE_WIND_CROSSING_LIMIT);
    const convectionAdvection = advectionWind(CONVECTION_FRICTION, CONVECTION_WIND_CROSSING_LIMIT);
    const upperAdvection = advectionWind(FRICTION_RATE, SURFACE_WIND_CROSSING_LIMIT);
    return {
      rossby, surfaceWind, upperWind,
      surfaceAdvection, convectionAdvection, upperAdvection,
    };
  }

  // 上層の偏差風へ中規模の蛇行を重ねる。風速を保ったまま向きだけを回す — 流れ自身の
  // 曲がり (turn) は気圧場のものなので触らない。蛇行のノイズは上層の湿度の源と同じ
  // 循環で運ぶので、向きの変わり目が筋そのものと一緒に流れる。
  private meanderUpperWind(wind: BalancedWind, direction: Vec3Node): BalancedWind {
    const angle = this.upperMeander.at(direction).mul(UPPER_MEANDER_MAX_ANGLE);
    return {
      velocity: wind.velocity.mul(cos(angle)).add(cross(direction, wind.velocity).mul(sin(angle))),
      turn: wind.turn,
    };
  }

  // 単位方向 direction(接平面の東 east・北 north)における気圧と、その勾配・等圧線方向の曲がり。
  private pressureFieldAt(direction: Vec3Node, east: Vec3Node, north: Vec3Node): PressureField {
    const pressure = this.pressure.at(direction).r;
    const eastStep = east.mul(GRADIENT_STEP);
    const northStep = north.mul(GRADIENT_STEP);
    const pressureEast = this.pressure.at(normalize(direction.add(eastStep))).r;
    const pressureWest = this.pressure.at(normalize(direction.sub(eastStep))).r;
    const pressureNorth = this.pressure.at(normalize(direction.add(northStep))).r;
    const pressureSouth = this.pressure.at(normalize(direction.sub(northStep))).r;
    const gradient = east.mul(pressureEast.sub(pressureWest)).add(north.mul(pressureNorth.sub(pressureSouth)))
      .div(2 * GRADIENT_STEP);
    // 曲がりは等圧線に沿って測る — 勾配の向きに測ると、谷の深さそのものを曲率として検出してしまう。
    const isobar = isobarAt(direction, gradient);
    const isobarStep = isobar.mul(BEND_STEP);
    const pressureAhead = this.pressure.at(normalize(direction.add(isobarStep))).r;
    const pressureBehind = this.pressure.at(normalize(direction.sub(isobarStep))).r;
    const bend = pressureAhead.add(pressureBehind).sub(pressure.mul(2)).div(BEND_STEP ** 2);
    return { pressure, gradient, isobar, bend };
  }

  // 単位方向のまわりの気圧のラプラシアン [hPa/rad²]。低気圧の芯で正、高気圧の芯で負。
  private pressureLaplacianAt(direction: Vec3Node, east: Vec3Node, north: Vec3Node): FloatNode {
    const eastStep = east.mul(LAPLACIAN_STEP);
    const northStep = north.mul(LAPLACIAN_STEP);
    const sum = this.pressure.at(normalize(direction.add(eastStep))).r
      .add(this.pressure.at(normalize(direction.sub(eastStep))).r)
      .add(this.pressure.at(normalize(direction.add(northStep))).r)
      .add(this.pressure.at(normalize(direction.sub(northStep))).r);
    return sum.sub(this.pressure.at(direction).r.mul(4)).div(LAPLACIAN_STEP ** 2);
  }

  // 渦・収束・移流が立てる上昇流 [m/s](気団の折り目の帯と地形の分を欠いたもの)。大循環の帯を
  // 含む気圧の偏差からは出さない — 帯状平均の気圧帯は上昇流をほとんど作らず、全域を一様に
  // 上昇させてしまう。warmth は出身地からの緯度の差 [rad](負で寒気の流入)。
  private dynamicsLiftAt(
    direction: Vec3Node, latitude: FloatNode, east: Vec3Node, north: Vec3Node, warmth: FloatNode,
  ): FloatNode {
    // 帯状平均の気圧帯(緯度だけの関数)は上昇流をほとんど作らないので、そのラプラシアンを解析的に
    // 差し引いて渦の成分だけを残す。
    const laplacian = this.pressureLaplacianAt(direction, east, north)
      .sub(bandPressureLaplacianAt(latitude));
    const coriolis = sin(latitude).mul(coriolisRate(this.rotationPeriod));
    const damped = sqrt(coriolis.mul(coriolis).add(FRICTION_RATE ** 2));
    // エクマンの釣り合い自体が成り立つ度合い。f → 0 では地衡風の渦が無く、摩擦層の収束は気圧の
    // 曲がりへ応答しない — 下支えで割るだけだと赤道でも等しく応答してしまうので |f|/f̂ で絞る。
    const geostrophicShare = abs(coriolis).div(damped);
    // 熱帯では地衡の前提自体が薄いので、摩擦層の収束は気圧の曲がりではなく対流の質量流が担う —
    // そのまま掛けると上昇流が低気圧性の曲がりへ実写より強く応答するので、温帯らしさで絞る。
    const poleward = smoothstep(STORM_TRACK_POLE_START, MESOSCALE_POLAR_END, abs(latitude));
    const ekmanShare = geostrophicShare.mul(extratropicalAt(latitude).mul(0.85).add(0.15))
      .mul(poleward.mul(-EKMAN_POLAR_CUT).add(1));
    // ∇²p [hPa/rad²] を Pa/m² へ直す係数(100 / R²)に、エクマン層の深さの半分を掛けたもの。
    const pumpingScale = (50 * EKMAN_DEPTH) / (AIR_DENSITY * this.surfaceRadius ** 2);
    const ekman = laplacian.mul(pumpingScale).div(damped).mul(ekmanShare);
    const mesoscaleShare = poleward.mul(-MESOSCALE_POLAR_KEEP).add(1);
    const mesoscale = this.mesoscaleLift.at(direction, {
      envelope: extratropicalAt(latitude).mul(mesoscaleShare),
    });
    const skewed = mesoscale.mul(max(mesoscale, 0).mul(MESOSCALE_SKEW).add(1))
      .add(min(mesoscale, 0).mul(MESOSCALE_SINK_GAIN - 1))
      .sub(MESOSCALE_LIFT_OFFSET);
    return ekman
      .add(warmth.mul(ADVECTION_LIFT))
      .add(skewed.mul(MESOSCALE_LIFT));
  }

  // 移流前の地表付近の湿度の、水平勾配の大きさ [1/rad]。
  private moistureGradientAt(direction: Vec3Node, east: Vec3Node, north: Vec3Node): FloatNode {
    const eastStep = east.mul(GRADIENT_STEP);
    const northStep = north.mul(GRADIENT_STEP);
    const moistureAt = (offset: Vec3Node): FloatNode => this.transport.surfaceHumidityAt(normalize(offset));
    const eastGradient = moistureAt(direction.add(eastStep)).sub(moistureAt(direction.sub(eastStep)))
      .div(2 * GRADIENT_STEP);
    const northGradient = moistureAt(direction.add(northStep)).sub(moistureAt(direction.sub(northStep)))
      .div(2 * GRADIENT_STEP);
    return eastGradient.mul(eastGradient).add(northGradient.mul(northGradient)).sqrt();
  }

  // 単位方向 direction における気団を遡らせる風(東向き・北向きの成分 [m/s])。
  public traceWindAt(direction: Vec3Node): Vec2Node {
    return eastNorthComponents(this.traceFlowAt(direction).velocity, eastAt(direction), northAt(direction));
  }

  // 気団を風上へ遡らせる風。大循環の気圧帯を差し引いた気圧の勾配から解いた釣り合い風へ、大循環の
  // 平均風とロスビー波を重ねる。気圧帯を残すと、収束する緯度に緯線に沿った圧縮の環が立つ。
  private traceFlowAt(direction: Vec3Node): BalancedWind {
    const east = eastAt(direction);
    const north = northAt(direction);
    const latitude = latitudeOf(direction);
    const { gradient, bend } = this.pressureFieldAt(direction, east, north);
    // 気圧帯は緯度だけの関数なので、その勾配は解析的に差し引ける。
    const eddy = gradient.sub(north.mul(bandPressureSlopeAt(latitude)));
    const wind = balancedWind(
      eddy, isobarAt(direction, eddy), bend, latitude, FRICTION_RATE, SURFACE_WIND_CROSSING_LIMIT,
      this.surfaceRadius, this.rotationPeriod,
    );
    return {
      velocity: wind.velocity
        .add(east.mul(this.meanWindAt(direction).x))
        .add(north.mul(this.meanWindAt(direction).y))
        .add(this.rossbyWave.perturbationAt(direction, this.surfaceRadius)),
      turn: wind.turn,
    };
  }

  // 気圧の偏差 [hPa]: 大循環の帯 + ノイズ + 低気圧の谷 + 高気圧の丘。
  private pressureSourceAt(direction: Vec3Node): FloatNode {
    const latitude = latitudeOf(direction);
    const band = bandPressureAt(latitude);
    const noise = this.pressureNoise.at(direction, { envelope: extratropicalAt(latitude) });
    // 熱帯では同じ振幅の気圧の起伏が実測より強い — 暖かい海の下では総観規模の気圧応答が浅いので、
    // 温帯らしさで振幅そのものを絞る(帯の浅い赤道の谷と合わせて実写の ±3〜4 hPa の幅へ)。
    const tropicalScale = extratropicalAt(latitude).mul(0.5).add(0.5);
    return band.add(noise.mul(PRESSURE_NOISE_AMPLITUDE).mul(tropicalScale))
      .add(this.cyclones.pressureAt(direction))
      .add(this.highs.pressureAt(direction));
  }

  // 移流前の湿度(x が地表付近、y が上層)。平年の雲量は移流の後に weatherAt が足す — 移流を通すと
  // 気候の分布が雲を筋に引く変位ぶん歪む。
  public humiditySourceAt(direction: Vec3Node): Vec2Node {
    return this.transport.humiditySourceAt(direction);
  }

  // 単位方向 direction における高度1 kmの大循環の平均風(東向き・北向きの成分 [m/s])。
  public meanWindAt(direction: Vec3Node): Vec2Node {
    return this.atmosphericWind.sampleNode(latitudeOf(direction), SURFACE_HEIGHT);
  }

  // 移流前の対流の強弱(0 中心の高周波)。x が粒(細胞の芯)、y が網目(細胞の壁)。
  public convectionSourceAt(direction: Vec3Node): Vec2Node {
    return this.transport.convectionSourceAt(direction);
  }

  // 保持している GPU 資源を解放する。
  public dispose(): void {
    this.pressure.dispose();
    this.transport.dispose();
    this.convectiveActivity.dispose();
    this.airMass.dispose();
  }
}

// 接ベクトル v の東向き・北向きの成分。
function eastNorthComponents(v: Vec3Node, east: Vec3Node, north: Vec3Node): Vec2Node {
  return vec2(dot(v, east), dot(v, north));
}

// 平年の雲量 0..1 が湿度へ渡す偏り ±0.5。乾燥帯で −0.5、年中曇りの土地で +0.5 に振り切る。
function cloudinessBias(meanCloudiness: FloatNode): FloatNode {
  return smoothstep(MEAN_CLOUDINESS_DRY, MEAN_CLOUDINESS_WET, meanCloudiness).sub(0.5);
}

// 緯度 [rad] における圏界面の高さ [m]。
function tropopauseAt(latitude: FloatNode): FloatNode {
  const drop = smoothstep(TROPOPAUSE_STEP_START, TROPOPAUSE_STEP_END, abs(latitude));
  return drop.mul(TROPOPAUSE_POLE - TROPOPAUSE_EQUATOR).add(TROPOPAUSE_EQUATOR);
}

// 上昇流を LIFT_LIMIT へ漸近させる。LIFT_LIMIT より十分弱い上昇流はほぼ素通しで、強いものだけが丸まる。
function limitLift(lift: FloatNode): FloatNode {
  return tanh(lift.div(LIFT_LIMIT)).mul(LIFT_LIMIT);
}

// 緯度 center に置いたガウス型の鐘 e^{−x²} と、その中身の x = (|φ| − center)/幅。
function pressureBell(latitude: FloatNode, center: number, width: number): { bell: FloatNode; x: FloatNode } {
  const x = abs(latitude).sub(center).div(width);
  return { bell: exp(x.mul(x).mul(-1)), x };
}

// 大循環の気圧帯 [hPa] = −A·cos 6φ + H·副熱帯の高圧の尾根 − D·e^{−x²}(亜極トラフ)。
// cos 6φ のなだらかな山だけでは副熱帯高圧帯の狭く高い尾根を作れず、熱帯〜中緯度の気圧が
// 軒並み実写より低く出るので、別の鐘として足す。
function bandPressureAt(latitude: FloatNode): FloatNode {
  return cos(latitude.mul(6)).mul(-PRESSURE_BAND_AMPLITUDE)
    .add(pressureBell(latitude, SUBTROPICAL_LATITUDE, SUBTROPICAL_WIDTH).bell.mul(SUBTROPICAL_HEIGHT))
    .sub(pressureBell(latitude, SUBPOLAR_LATITUDE, SUBPOLAR_WIDTH).bell.mul(SUBPOLAR_DEPTH));
}

// 副熱帯の尾根の緯度微分 [hPa/rad]。
function ridgeSlopeAt(latitude: FloatNode): FloatNode {
  const { bell, x } = pressureBell(latitude, SUBTROPICAL_LATITUDE, SUBTROPICAL_WIDTH);
  return sign(latitude).mul(bell).mul(x).mul((-2 * SUBTROPICAL_HEIGHT) / SUBTROPICAL_WIDTH);
}

// 副熱帯の尾根の緯度 2 階微分 p''(φ) [hPa/rad²]。
function ridgeCurvatureAt(latitude: FloatNode): FloatNode {
  const { bell, x } = pressureBell(latitude, SUBTROPICAL_LATITUDE, SUBTROPICAL_WIDTH);
  return bell.mul(x.mul(x).mul(-2).add(1)).mul((-2 * SUBTROPICAL_HEIGHT) / SUBTROPICAL_WIDTH ** 2);
}

// 帯の緯度微分 [hPa/rad](北向き正)。風を解く勾配から帯の分を差し引くのに使う。
function bandPressureSlopeAt(latitude: FloatNode): FloatNode {
  const { bell, x } = pressureBell(latitude, SUBPOLAR_LATITUDE, SUBPOLAR_WIDTH);
  return sin(latitude.mul(6)).mul(6 * PRESSURE_BAND_AMPLITUDE)
    .add(ridgeSlopeAt(latitude))
    .add(sign(latitude).mul(bell).mul(x).mul((2 * SUBPOLAR_DEPTH) / SUBPOLAR_WIDTH));
}

// 帯のラプラシアン [hPa/rad²] = p'' − tanφ·p'(p は緯度だけの関数)。上昇流から帯の分を差し引くのに使う。
function bandPressureLaplacianAt(latitude: FloatNode): FloatNode {
  const { bell, x } = pressureBell(latitude, SUBPOLAR_LATITUDE, SUBPOLAR_WIDTH);
  const troughCurvature = bell.mul(x.mul(x).mul(-2).add(1)).mul((2 * SUBPOLAR_DEPTH) / SUBPOLAR_WIDTH ** 2);
  return cos(latitude.mul(6)).mul(36 * PRESSURE_BAND_AMPLITUDE)
    .add(ridgeCurvatureAt(latitude))
    .add(troughCurvature)
    .sub(tan(latitude).mul(bandPressureSlopeAt(latitude)));
}
