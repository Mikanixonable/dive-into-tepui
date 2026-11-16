// 天気のモデル。天体固定の単位方向と時刻から、気圧 → 風 → 上昇流 → 湿度・対流の天気を TSL の
// グラフで組む。時刻の閉じた関数で、同じ時刻には同じ空が出る。値はすべて見えのための調整値。
import { abs, atan, clamp, dot, exp, fract, max, min, smoothstep, tanh, uniform, vec2 } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { AirMass } from './air-mass';
import { AtmosphericWindField, SURFACE_HEIGHT } from './atmospheric-wind';
import { CirculatingNoise } from './circulating-noise';
import { Circulation, SURFACE_BANDS, UPPER_BANDS } from './circulation';
import { ConvectiveActivity } from './convective-activity';
import { Cyclones } from './cyclones';
import { Anticyclones } from './anticyclones';
import { EpochNoise } from './epoch-noise';
import { PressureField, pressureBandAt } from './pressure-field';
import { latitudeOf } from './sphere-frame';
import { SURFACE_HUMIDITY_BASE, WeatherTransport } from './weather-transport';
import { CLOUD_TUNING } from './cloud/cloud-tuning';
import { layerDepthKmNode, shieldNode, upperInstabilityNode } from './cloud/cirrus-regime-node';
import { TerrainFlow } from './terrain-flow';
import { WindField } from './wind-field';
import type { WebGPURenderer } from 'three/webgpu';
import type { GpuTimingSink } from '../gpu-timings';
import type { NoiseOctave } from './circulating-noise';
import type { ClimateMap } from './climate-map';
import type { TerrainMap } from './terrain-map';
import type { FieldProjection } from '../field-projection';
import type { FloatNode, FloatUniform, Vec2Node, Vec3Node } from '../tsl-types';

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
  readonly band: FloatNode; // 雲の帯(低気圧に繋がる前線、または眼を持つ渦のまわりの雨帯)の強さ 0..1
  readonly front: FloatNode; // 帯のうち、谷の骨格から立つ前線の分 0..1
  readonly warmth: FloatNode; // 暖気の流入 = 出身地からの緯度の差 [rad](負で寒気)
  readonly oceanFetch: FloatNode; // 追跡した気団が海の上にあった時間の割合 0..1(寒気の fetch)
  readonly anvil: FloatNode; // 金床(平らな天蓋)の濃さ 0..1
  readonly eye: FloatNode; // 眼を持つ渦の目の濃さ 0..1
  readonly cirrusPatch: FloatNode; // 薄い雲の斑と透き間を決める百キロ級の場 −1..1(上層の流れに運ばれる)
  readonly upperInstability: FloatNode; // 上層の不安定度の代理量 0..1(対流・斑・上昇から作る)
  readonly layerDepth: FloatNode; // 巻雲の鱗の層の深さ [km]
  readonly shield: FloatNode; // 前線・暖気の盾 0..1(前線の上で暖気が流入し、閉塞の芯でない所)
  readonly meanCloudiness: FloatNode; // 平年の雲量 0..1
  readonly landFraction: FloatNode; // 陸らしさ 0..1
  readonly tropopause: FloatNode; // その緯度の対流の天井(圏界面の高さ)[m]
}

// ノイズのオクターブ定義表。周波数は 1 rad あたりの山数で、角波長 [km] は 6371 ÷ 周波数。気圧は単一オクターブ
// のみとする — 上昇流が気圧値の直接の関数であるため、オクターブを重ねると高周波の格子が雲へそのまま現れてしまうため。
// この段はエポックの混ぜ替えに参加し、気圧の谷と峰は流れに乗るだけでなくその場でも発達・衰退する。
const PRESSURE_NOISE: readonly NoiseOctave[] = [
  { frequency: 1.2, amplitude: 1 }, // 5300 km
];
// 場の振れ幅 [hPa]。オクターブ数によらない。
const PRESSURE_NOISE_AMPLITUDE = CLOUD_TUNING.pressureNoiseAmplitude;

// 気圧の偏差から出る上昇流。利得 [m/s] が高気圧側の吹きおろしの上限、低気圧側は尺度 [hPa] ごとに
// e 倍に伸びる(上昇は狭く強く、下降は広く弱い)。尺度は並の低気圧の芯(24 hPa)で 0.03 m/s に
// なる長さ。利得を上げると低気圧が飽和した円盤になり、流入が巻き込んだ渦を塗り潰す。
const PRESSURE_LIFT_GAIN = CLOUD_TUNING.pressureLiftGain;
const PRESSURE_LIFT_SCALE = CLOUD_TUNING.pressureLiftScale;
// 上昇流の頭打ち [m/s]。急な斜面と深い谷の芯では上昇流が並の何倍にもなり、線形のままだと湿度が
// 0/1 で切れて硬い縁の白い塊になる。
const LIFT_LIMIT = CLOUD_TUNING.liftLimit;
// 雨帯。眼を持つ渦が周りの気団を巻き込んで折り畳んだ筋で、圧縮は前線より桁が大きい(腕の稜線で 5〜9)。
// 稜線の最も押し縮まった区間だけが飽和して腕の先へ連続に薄れる幅に取り、芯のまわりのシアの丘(2〜4)と
// 熱帯の背景(99.9 パーセンタイルで 3.2)を拾わない。狭めると腕が太い真っ白な帯になる
// (`DEVELOP/SPEC/RENDERING.md`「雨帯は、渦が周りの気団を巻き込んで折り畳んだ筋に沿う」)。
const RAINBAND_ONSET = CLOUD_TUNING.rainbandOnset;
const RAINBAND_WIDTH = CLOUD_TUNING.rainbandWidth;
// 帯が飽和した所で立つ上昇流 [m/s]。深い谷の芯と同じだけ持ち上げるよう、頭打ち(LIFT_LIMIT)に揃える。
const BAND_LIFT = CLOUD_TUNING.bandLift;
// 帯が飽和した所で地表付近の湿度へ足す底上げ。被覆率の伝達関数の幅(0.22)の 0.45 倍に取る —
// 帯の芯では上昇流による偏差の増幅(VORTEX_CONTRAST)と合わせて被覆率が上端へ届き途切れない帯に
// なるが、前線帯の面全体が湿度の上限へ張り付いて一枚の台地にはならない
// (`DEVELOP/SPEC/RENDERING.md`「前線の帯そのものが、その空でいちばん厚い雲になる」)。
const BAND_HUMIDITY = CLOUD_TUNING.bandHumidity;
// 温帯と熱帯の境界緯度。温帯では前線、熱帯では雨帯の伝達関数を使い、暖気流入の補正は温帯に
// 限定して適用する。
const FRONT_LATITUDE_START = THREE.MathUtils.degToRad(20);
const FRONT_LATITUDE_FULL = THREE.MathUtils.degToRad(35);
// 風が斜面を駆け上がる分の利得。等倍では偏西風や貿易風が山脈へ当たり続けるだけで上昇流が頭打ちに
// 達し、地形の縞が年中貼り付く — 慢性的な湿潤・乾燥は平年の雲量が持つ。
const TERRAIN_LIFT_GAIN = CLOUD_TUNING.terrainLiftGain;
// 陸へ上乗せする高さ [m]。海と陸の比熱の差を、海岸へ吹き込む風が駆け上がる斜面として代用する。
const LAND_HEIGHT_BIAS = 800;
// 地表付近の沈降の乾きは上昇より弱く取る — 海洋境界層は沈降の下でも層積雲を保ち、同じ利得では
// 亜熱帯高圧帯の下の海が丸ごと晴れる。
const SURFACE_SUBSIDENCE_DRYING = CLOUD_TUNING.surfaceSubsidenceDrying;
const UPPER_LIFT_HUMIDITY = CLOUD_TUNING.upperLiftHumidity;
// 上昇流が、移流した地表付近の湿度の偏差(源の底上げ SURFACE_HUMIDITY_BASE からの揺れ)を増幅する利得。
// 頭打ち(LIFT_LIMIT)に張り付いた所で偏差は (1 + 利得) 倍 — 1 で 2 倍になる。
const VORTEX_CONTRAST = CLOUD_TUNING.vortexContrast;
// 沈降が上層を乾かす利得 [per m/s]。上層には境界層のような湿りの溜まりが無いので、地表付近より
// 強く乾く — 高気圧の吹きおろす所では薄い雲も消える。
const UPPER_SUBSIDENCE_DRYING = CLOUD_TUNING.upperSubsidenceDrying;
// 前線の帯の芯が上層を湿らせる高さ。前線は境目をまたぐ空気を押し上げ、その上に巻雲の盾が架かる。
// 帯の強さは二乗で掛ける — 帯の細い裾が筋状の薄い線として上層へ立たず、芯だけが盾になる。
const UPPER_BAND_HUMIDITY = CLOUD_TUNING.upperBandHumidity;

// 圏界面の高さ [m] とその緯度依存。熱帯で 16〜17 km、極で 9 km 前後で、亜熱帯のジェットの下で
// 段をなして下がる(NCAR ACOM「Cloud Tops and Tropopause」)。深い対流はここに当たって横へ広がる
// ので、対流の天井そのものになる。
const TROPOPAUSE_EQUATOR = CLOUD_TUNING.tropopauseEquator;
const TROPOPAUSE_POLE = CLOUD_TUNING.tropopausePole;
const TROPOPAUSE_STEP_START = THREE.MathUtils.degToRad(15);
const TROPOPAUSE_STEP_END = THREE.MathUtils.degToRad(60);

// 渦の目が移流後の湿度から引く深さ。眼壁の飽和と金床の天蓋(ANVIL_HUMIDITY)の両方を貫く深さに
// 取る。上層を深く引いて、薄い雲の穴を厚い雲の目よりひとまわり広く開ける。
const SURFACE_EYE_DRYNESS = CLOUD_TUNING.surfaceEyeDryness;
const UPPER_EYE_DRYNESS = CLOUD_TUNING.upperEyeDryness;
// 金床の天蓋が地表付近の湿度へ足す高さ。天蓋の芯では並の湿度からでも雲量が飽和する分を足すが、
// 円盤の縁まで一様に上限へ張り付かせないよう、天蓋自身の濃さの落ち際と合わせて効かせる。
const ANVIL_HUMIDITY = CLOUD_TUNING.anvilHumidity;
// 暖気流入が地表付近の湿度へ寄与する伝達利得 [per rad]。平均的な暖気流入（0.26 rad）で伝達関数幅の約半分が
// 変位する係数。本項の期待値が正のため、基底湿度 (SURFACE_HUMIDITY_BASE) をオフセットして均衡させる。
const WARM_HUMIDITY = CLOUD_TUNING.warmHumidity;
// 寒気噴出 — 寒気の流入(warmth < 0)が暖かい海を渡ると湿り、細胞状の雲が立つ(MCAO)。底上げは
// 追跡が海の上にあった時間の割合(fetch)で逓減する: 海岸を出たばかりでは閉じた細胞の高い被覆、
// 長く海を流れた先では開いた細胞へ崩れて被覆が落ちる(衛星合成で閉じた細胞 ~90%、開いた細胞
// ~50%)。効きが飽和する寒気の流入の深さ [rad]。
const OUTBREAK_WARMTH_FULL = 0.15;
const OUTBREAK_HUMIDITY_SHORT = 0.28;
const OUTBREAK_HUMIDITY_LONG = 0.09;
// 寒気が湿り始めるまでの海上滞在の時間比。陸を出たばかりの気団はまだ乾いていて雲を立たせない
// — 海面からの供給が境界層へ届くまで数時間かかるので、追跡(36 h)のこの割合から湿らせ始める。
const OUTBREAK_FETCH_RAMP = 0.2;
// 閉塞した低気圧の構造 — 赤道側から芯へ巻き込む乾いた舌が地表付近と上層を乾かし、極側の
// コンマの頭の層状域が地表付近を湿らせる。乾いた舌は上層の乾きが主(水蒸気画像の暗帯)なので、
// 上層を深く引く。
const DRY_TONGUE_DRYING = 0.3;
const DRY_TONGUE_UPPER_DRYING = 0.55;
const COMMA_HEAD_HUMIDITY = 0.15;
// 移流後に足す平年の雲量の重み(地表付近と上層)。雲量の地理的な差が凝結のしきい値をまたぐ幅に
// 取る — 小さいと砂漠にも海と同じだけ雲が湧き、大きいと雲の多い海が覆われたまま平年の雲量図が
// 貼り付く。地表付近は、貼り付いた図が中緯度の長波長スペクトルの過剰の支配項だったので半分に
// 弱め、減った平均ぶんは基底湿度の底上げで埋める(cloud-lab Phase 3-10)。上層は薄い雲の分布が
// 平年の図へ素直に従うため据え置く。
const SURFACE_MEAN_CLOUDINESS_WEIGHT = CLOUD_TUNING.surfaceMeanCloudinessWeight;
const UPPER_MEAN_CLOUDINESS_WEIGHT = CLOUD_TUNING.upperMeanCloudinessWeight;
// 平年の雲量を湿度へ渡す S 字の裾と肩。線形では、砂漠を晴らす重みで雲の多い海が覆われたまま動かなく
// なる。裾は砂漠(0.14)の下、肩は年中曇りの海(0.89)の側に置く — 狭めると乾いた大陸(0.43〜0.51)や
// 貿易風帯の海(0.50〜0.65)まで雲を失う。
const MEAN_CLOUDINESS_DRY = CLOUD_TUNING.meanCloudinessDry;
const MEAN_CLOUDINESS_WET = CLOUD_TUNING.meanCloudinessWet;

// 上昇源 — 地理に貼り付き、供給した湿りが風下へ運ばれてプルームをなす項。
// 一時的な上昇源のノイズ。周波数は 1 rad あたりの山数(角波長 [km] = 6371 ÷ 周波数)。平地や海上で
// 数時間〜日のあいだ持続する対流の塊(200〜800 km)を、エポックの混ぜ替えで生滅させる。
const TRANSIENT_NOISE: readonly NoiseOctave[] = [
  { frequency: 8, amplitude: 1 },   // 800 km
  { frequency: 16, amplitude: 0.7 }, // 400 km
  { frequency: 32, amplitude: 0.5 }, // 200 km
];
// エポックの混ぜ替えに参加するのは総観規模の段まで — 細い段は形の足場として残す。
const TRANSIENT_EPOCH_MAX_FREQUENCY = 16;
// 薄い雲の斑のノイズ。上層の大循環に運ばれる百キロ級の湿りの斑で、靄の透き間を決める
// (`DEVELOP/SPEC/RENDERING.md`「薄い雲は一面を均一な靄で覆わず、湿りのある帯や斑と透き間が
// 百キロ級の尺度で交互に並ぶ」)。上層の循環に乗せるので、斑はジェットや渦の流れに沿って運ばれる。
const CIRRUS_PATCH_NOISE: readonly NoiseOctave[] = [
  { frequency: 16, amplitude: 1 },   // 400 km
  { frequency: 32, amplitude: 0.7 }, // 200 km
  { frequency: 64, amplitude: 0.4 }, // 100 km
];
const CIRRUS_PATCH_EPOCH_MAX_FREQUENCY = 32;
// 過渡源の活動度の門。ノイズ(−1..1 を 0..1 へ写したもの)がこの幅を渡る間に 0 から 1 へ立つ。
const TRANSIENT_ACTIVITY_ONSET = CLOUD_TUNING.transientActivityOnset;
const TRANSIENT_ACTIVITY_FULL = CLOUD_TUNING.transientActivityFull;
const TRANSIENT_GAIN = CLOUD_TUNING.transientGain;
const LAND_HEATING_GAIN = CLOUD_TUNING.landHeatingGain;
const OROGRAPHIC_GAIN = CLOUD_TUNING.orographicGain;
// 風上で凝結して降った水が湿度から剥奪する利得。吹き付けの上り成分 [m/s] × 源の湿りを
// 乾きへ換算する — 上昇源と同じ吹き付けの式で、高い地形ほど堰き止めが強く乾きも強い。
const RAINOUT_GAIN = CLOUD_TUNING.rainoutGain;
// 島や陸の日射加熱が上昇源になる地方太陽時の窓 [時]。陸が暖まって対流が立つまでの遅れを込めて
// 昼過ぎを中心に取る(雲道の観測では午後に発生率が立つ)。
const HEATING_HOUR_START = 9;
const HEATING_HOUR_FULL = 11;
const HEATING_HOUR_EBB = 16;
const HEATING_HOUR_END = 18;
// 平均太陽日 [s]。発射時刻の地方太陽時は、太陽直下経度がこの周期で西へ一周するとして遡る。
const MEAN_SOLAR_DAY = 86400;

export class WeatherModel {
  // 大循環の平均風。地表付近と上層の背景風をここから引く。
  private readonly atmosphericWind = new AtmosphericWindField();
  private readonly surfaceCirculation: Circulation;
  private readonly upperCirculation: Circulation;
  private readonly cyclones: Cyclones;
  private readonly highs: Anticyclones;
  private readonly pressureNoise: CirculatingNoise;
  private readonly cirrusPatchNoise: CirculatingNoise;
  private readonly transport: WeatherTransport;
  private readonly pressure: PressureField;
  private readonly winds: WindField;
  private readonly convectiveActivity: ConvectiveActivity;
  private readonly airMass: AirMass;
  // 地理に貼り付いた一時的な上昇源の場。循環に運ばれないので、平地や海上で定点に雲を供給し続ける。
  private readonly transientField: EpochNoise;
  // 太陽直下経度 [rad]。暦を持つ呼び出し側が setSolarLongitude で上書きしない限り、
  // 平均太陽日の速さで西へ回る架空の太陽を使う。
  private readonly solarLongitude: FloatUniform = uniform(0);
  private solarLongitudeOverride: number | null = null;
  // 現在時刻 [s]。発射時刻の地方太陽時を遡るのに使う。
  private readonly secondsUniform: FloatUniform = uniform(0);
  // 写しの texel 角 [rad]。細かい地形やノイズを読むフットプリント。
  private readonly texel: FloatNode;

  // 時刻 0 の天気で始める。climate はこの天体の気候の事前分布、terrain は細かい地形、
  // projection は写しの持ち方、surfaceRadius は天体の半径 [m]、rotationPeriod は自転周期 [s]。
  public constructor(
    private readonly climate: ClimateMap, private readonly terrain: TerrainMap,
    projection: FieldProjection,
    private readonly surfaceRadius: number, rotationPeriod: number,
  ) {
    const texel = this.texel = projection.texelAngle;
    this.surfaceCirculation = new Circulation(SURFACE_BANDS, surfaceRadius);
    this.upperCirculation = new Circulation(UPPER_BANDS, surfaceRadius);
    this.cyclones = new Cyclones(surfaceRadius, rotationPeriod);
    this.highs = new Anticyclones(surfaceRadius, rotationPeriod);
    this.pressureNoise = new CirculatingNoise(
      this.surfaceCirculation, PRESSURE_NOISE, texel, PRESSURE_NOISE[0]!.frequency);
    this.cirrusPatchNoise = new CirculatingNoise(
      this.upperCirculation, CIRRUS_PATCH_NOISE, texel, CIRRUS_PATCH_EPOCH_MAX_FREQUENCY);
    this.transientField = new EpochNoise(TRANSIENT_NOISE, texel, TRANSIENT_EPOCH_MAX_FREQUENCY);
    this.pressure = new PressureField(
      projection, (direction) => this.pressureSourceAt(direction));
    this.winds = new WindField(
      this.pressure, new TerrainFlow(terrain, climate, texel), surfaceRadius, rotationPeriod);
    // 上昇源は地形へ吹き付ける風を読むので、風場を持ったあとで組む(評価はベイク時)。
    this.transport = new WeatherTransport(
      this.surfaceCirculation, this.upperCirculation, projection, surfaceRadius,
      (direction, emissionSeconds, ambientHumidity) =>
        this.moistureSourceAt(direction, emissionSeconds, ambientHumidity));
    this.convectiveActivity = new ConvectiveActivity(this.surfaceCirculation, projection);
    this.airMass = new AirMass(
      projection, (direction) => this.winds.traceFlowAt(direction),
      (direction) => this.climate.landFraction(direction), surfaceRadius);
    this.syncTime(0);
  }

  // いまの時刻の気圧と、移流前の場を写しへ焼く。syncTime のあと、weatherAt のグラフを描く前に呼ぶ。
  public bake(renderer: WebGPURenderer, gpu?: GpuTimingSink): void {
    this.pressure.render(renderer, gpu);
    // 気団は気圧の写しを読んで遡るので、気圧の後に焼く。
    this.airMass.bake(renderer, gpu);
    this.transport.bake(renderer, gpu);
  }

  // 時刻 [s] を各サブシステムの uniform へ反映する。
  public syncTime(seconds: number): void {
    this.secondsUniform.value = seconds;
    this.solarLongitude.value =
      this.solarLongitudeOverride ?? (seconds * -2 * Math.PI / MEAN_SOLAR_DAY) % (2 * Math.PI);
    this.surfaceCirculation.syncTime(seconds);
    this.upperCirculation.syncTime(seconds);
    this.winds.syncTime(seconds);
    this.cyclones.syncTime(seconds);
    this.highs.syncTime(seconds);
    this.pressureNoise.syncTime(seconds);
    this.cirrusPatchNoise.syncTime(seconds);
    this.transientField.syncTime(seconds);
    this.transport.syncTime(seconds);
  }

  // 天体固定で見た太陽直下点の経度 [rad](経度は正距円筒の u の規約: lon0 が +Z、東が +X)。
  // 暦を持つ呼び出し側が、雲の昼夜を実際の太陽位置へ合わせるためにフレームごとに渡す。
  // null を渡すと、平均太陽日で西へ回る架空の太陽へ戻る。
  public setSolarLongitude(rad: number | null): void {
    this.solarLongitudeOverride = rad;
  }

  // 単位方向 direction における天気のグラフ。
  public weatherAt(direction: Vec3Node): WeatherSample {
    const latitude = latitudeOf(direction);

    const winds = this.winds.at(direction);
    const { pressure, surfaceWind, upperWind } = winds;

    // 風で流した湿度・対流。湿度の地表成分と上層成分は同じ風を違う歩幅で遡り、対流は別の風で遡る。
    const advected = this.transport.advectedAt(
      direction, winds.advection, winds.convectionAdvection);

    // 上昇流: 風が斜面を駆け上がる分と、気圧の谷が引き上げる分と、気団の境目が押し上げる分。
    const airMass = this.airMass.at(direction, latitude);
    const extratropical = smoothstep(FRONT_LATITUDE_START, FRONT_LATITUDE_FULL, abs(latitude));
    const warmth = airMass.warmth.mul(extratropical);
    const terrainLift = dot(surfaceWind, this.climate.slope(direction, LAND_HEIGHT_BIAS, this.surfaceRadius))
      .mul(TERRAIN_LIFT_GAIN);
    // 帯: 温帯では谷の骨格から立つ前線、熱帯では気団の圧縮の稜線を写像する雨帯。
    const front = this.cyclones.frontAt(direction);
    const rainband = smoothstep(RAINBAND_ONSET, RAINBAND_ONSET.add(RAINBAND_WIDTH), airMass.compression)
      .mul(extratropical.oneMinus());
    const band = min(front.add(rainband), 1);
    const bandLift = band.mul(BAND_LIFT);
    const lift = limitLift(terrainLift.add(liftFromPressure(pressure)).add(bandLift));

    // 湿度: 流した写しへ、場所と渦に貼り付く項(平年の雲量・上昇流・帯・金床・目)を足し引きする。
    const meanCloudiness = this.climate.meanCloudiness(direction);
    // 平年雲量バイアスの重みを緯度で絞る: 熱帯は 1.0 のまま、中緯度では半分にする。
    // 最長波長の担い手のうち中緯度側の分だけを切り、ITCZ は保つ。
    const surfaceBiasWeight = extratropical.oneMinus().mul(0.5).add(0.5);
    const landFraction = this.climate.landFraction(direction);
    const eye = this.cyclones.eyeAt(direction);
    const anvil = this.cyclones.anvilAt(direction);
    // 閉塞した低気圧の構造 — 赤道側から芯へ巻き込む乾いた舌、極側のコンマの頭、暖域の舌が
    // 切り離される芯(その内側で暖気流入による加湿を止める)。
    const dryTongue = this.cyclones.dryTongueAt(direction);
    const commaHead = this.cyclones.commaHeadAt(direction);
    const occludedCore = this.cyclones.occludedCoreAt(direction);
    // 寒気噴出 — 寒気の流入かつ海上で地表付近を湿らせる。底上げは海上滞在の時間比(fetch)で
    // 逓減し、海岸を出たばかりの閉じた細胞から、海を流れ続けた開いた細胞へ被覆を落とす。
    const outbreak = smoothstep(0, OUTBREAK_WARMTH_FULL, airMass.warmth.negate())
      .mul(landFraction.oneMinus())
      .mul(smoothstep(0, OUTBREAK_FETCH_RAMP, airMass.ocean))
      .mul(airMass.ocean.oneMinus().mul(OUTBREAK_HUMIDITY_SHORT - OUTBREAK_HUMIDITY_LONG)
        .add(OUTBREAK_HUMIDITY_LONG));
    const deviation = advected.surfaceHumidity.sub(SURFACE_HUMIDITY_BASE);
    const surfaceHumidity = clamp(
      advected.surfaceHumidity.add(deviation.mul(max(lift, 0).div(LIFT_LIMIT)).mul(VORTEX_CONTRAST))
        .add(cloudinessBias(meanCloudiness).mul(SURFACE_MEAN_CLOUDINESS_WEIGHT).mul(surfaceBiasWeight))
        .add(min(lift, 0).mul(SURFACE_SUBSIDENCE_DRYING))
        .add(warmth.mul(WARM_HUMIDITY).mul(occludedCore.oneMinus())).add(band.mul(BAND_HUMIDITY))
        .add(anvil.mul(ANVIL_HUMIDITY)).add(outbreak).add(commaHead.mul(COMMA_HEAD_HUMIDITY))
        .sub(eye.mul(SURFACE_EYE_DRYNESS)).sub(dryTongue.mul(DRY_TONGUE_DRYING)), 0, 1);
    const upperHumidity = clamp(
      advected.upperHumidity.add(cloudinessBias(meanCloudiness).mul(UPPER_MEAN_CLOUDINESS_WEIGHT))
        .add(max(lift, 0).mul(UPPER_LIFT_HUMIDITY)).add(min(lift, 0).mul(UPPER_SUBSIDENCE_DRYING))
        .add(band.mul(band).mul(UPPER_BAND_HUMIDITY))
        .sub(eye.mul(UPPER_EYE_DRYNESS)).sub(dryTongue.mul(DRY_TONGUE_UPPER_DRYING)), 0, 1);

    const convectiveActivity = this.convectiveActivity.at(direction, lift, warmth, band, {
      land: landFraction,
      elevation: this.climate.elevation(direction),
      temperatureK: this.climate.temperatureK(direction),
    });
    const cirrusPatch = this.cirrusPatchNoise.at(direction);
    // 巻雲の鱗の入力。上層の不安定度・鱗の層の深さ・前線の盾は既存の量から組む(式は cirrus-regime-node.ts)。
    const upperInstability = upperInstabilityNode(convectiveActivity, cirrusPatch, lift);

    return {
      pressure,
      surfaceWind,
      upperWind,
      lift,
      surfaceHumidity,
      upperHumidity,
      convection: advected.convection,
      convectiveActivity,
      compression: airMass.compression,
      band,
      front,
      warmth,
      oceanFetch: airMass.ocean,
      anvil,
      eye,
      cirrusPatch,
      upperInstability,
      layerDepth: layerDepthKmNode(upperHumidity),
      shield: shieldNode(front, warmth, occludedCore),
      meanCloudiness,
      landFraction,
      tropopause: tropopauseAt(latitude),
    };
  }

  // 単位方向 direction で雲を運ぶ、地表付近と上層の風の東・北の成分 [m/s]。weatherAt の風と同じ式で、
  // 湿度・気団のグラフを通らない。焼いた気圧の写しを読むので、bake のあとに描く。
  public windsAt(direction: Vec3Node): { readonly surfaceWind: Vec2Node; readonly upperWind: Vec2Node } {
    return this.winds.windsAt(direction);
  }

  // 単位方向 direction における気団を遡らせる風(東向き・北向きの成分 [m/s])。
  public traceWindAt(direction: Vec3Node): Vec2Node {
    return this.winds.traceWindAt(direction);
  }

  // 気圧の偏差 [hPa]: 大循環の帯 + ノイズ + 低気圧の谷 + 高気圧の丘。
  private pressureSourceAt(direction: Vec3Node): FloatNode {
    return pressureBandAt(latitudeOf(direction))
      .add(this.pressureNoise.at(direction).mul(PRESSURE_NOISE_AMPLITUDE))
      .add(this.cyclones.pressureAt(direction)).add(this.highs.pressureAt(direction));
  }

  // 移流前の湿度(x が地表付近、y が上層)。平年の雲量は移流の後に weatherAt が足す — 移流を通すと
  // 気候の分布が雲を筋に引く変位ぶん歪む。
  public humiditySourceAt(direction: Vec3Node): Vec2Node {
    return this.transport.humiditySourceAt(direction);
  }

  // 地表の湿りの源: x=上昇源の加湿、y=降水枯渇の乾き。平地や海上の一時的な源、島・陸の
  // 日射加熱、風が斜面を駆け上がる分を足す。emissionSeconds は発射時刻 [s] — 移流の位相が
  // 遡った時刻で評価するので、昼に発射された湿りは日没後も風下へ残る。地形性上昇と降水
  // 枯渇にだけ陸の重みを掛けて、海底の起伏が大気を動かさないようにする(過渡源は海上にも立つ)。
  // ambientHumidity は移流前の地表付近の湿度 — 乾いた空気は降らせる水を持たない。
  private moistureSourceAt(
    direction: Vec3Node, emissionSeconds: FloatNode, ambientHumidity: FloatNode,
  ): Vec2Node {
    const transient = smoothstep(
      TRANSIENT_ACTIVITY_ONSET, TRANSIENT_ACTIVITY_FULL,
      this.transientField.at(direction, emissionSeconds).mul(0.5).add(0.5)).mul(TRANSIENT_GAIN);
    const fineLand = this.terrain.landFraction(direction, this.texel);
    const hour = this.localSolarHourAt(direction, emissionSeconds);
    const heating = smoothstep(HEATING_HOUR_START, HEATING_HOUR_FULL, hour)
      .mul(smoothstep(HEATING_HOUR_EBB, HEATING_HOUR_END, hour).oneMinus())
      .mul(fineLand).mul(LAND_HEATING_GAIN);
    // 風は発射時刻でなく現在時刻の場で評価する近似 — 歴史的な風の保存は持たない。
    const { surfaceWind, impingingWind } = this.winds.windsAt(direction);
    const slope = this.terrain.slope(direction, this.texel);
    // 加湿は地形を越えるぶんの上り(回された後の風)が担う — 堰き止めの強い高い地形では
    // 上りが消えて、風上の雲道ではなく風下の乾きへ回る。
    const orographic = max(dot(surfaceWind, slope), 0).mul(fineLand).mul(OROGRAPHIC_GAIN);
    // 降水枯渇は地形へ吹き付ける総量(回される前の風)で見る — 堰き止められた空気も
    // 風上で凝結して水を落とすので、高い地形ほど乾きが強い。
    const rainout = max(dot(impingingWind, slope), 0)
      .mul(fineLand).mul(ambientHumidity).mul(RAINOUT_GAIN);
    return vec2(transient.add(heating).add(orographic), rainout);
  }

  // 発射時刻における地方太陽時 [時] 0..24(直下点で 12)。太陽直下経度は現在時刻の値から、
  // 発射時刻まで平均太陽日の速さで遡る — 位相が遡る範囲(移流 1 周期ぶん)なら、実際の太陽も
  // ほぼこの速さで動く。
  private localSolarHourAt(direction: Vec3Node, emissionSeconds: FloatNode): FloatNode {
    const longitude = atan(direction.x, direction.z);
    const emissionSolarLongitude = this.solarLongitude.add(
      this.secondsUniform.sub(emissionSeconds).mul(2 * Math.PI / MEAN_SOLAR_DAY));
    return fract(longitude.sub(emissionSolarLongitude).div(2 * Math.PI).add(0.5)).mul(24);
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
    this.airMass.dispose();
  }
}

// 平年の雲量 0..1 が湿度へ渡す偏り ±0.5。乾燥帯で −0.5、年中曇りの土地で +0.5 に振り切る。
function cloudinessBias(meanCloudiness: FloatNode): FloatNode {
  return smoothstep(MEAN_CLOUDINESS_DRY, MEAN_CLOUDINESS_WET, meanCloudiness).sub(0.5);
}

// 緯度 [rad] における圏界面の高さ [m]。
function tropopauseAt(latitude: FloatNode): FloatNode {
  const drop = smoothstep(TROPOPAUSE_STEP_START, TROPOPAUSE_STEP_END, abs(latitude));
  return drop.mul(TROPOPAUSE_POLE.sub(TROPOPAUSE_EQUATOR)).add(TROPOPAUSE_EQUATOR);
}

// 気圧の偏差 [hPa] が生む上昇流 [m/s]。低気圧で正、高気圧で負。
function liftFromPressure(pressure: FloatNode): FloatNode {
  return exp(pressure.div(PRESSURE_LIFT_SCALE.mul(-1))).sub(1).mul(PRESSURE_LIFT_GAIN);
}

// 上昇流を LIFT_LIMIT へ漸近させる。LIFT_LIMIT より十分弱い上昇流はほぼ素通しで、強いものだけが丸まる。
function limitLift(lift: FloatNode): FloatNode {
  return tanh(lift.div(LIFT_LIMIT)).mul(LIFT_LIMIT);
}
