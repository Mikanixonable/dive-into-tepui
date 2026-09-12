// 天気のモデル。天体固定の単位方向と時刻から、気圧 → 風 → 上昇流 → 湿度・対流の天気を TSL の
// グラフで組む。時刻の閉じた関数で、同じ時刻には同じ空が出る。値はすべて見えのための調整値。
import { abs, clamp, cos, dot, exp, max, min, normalize, sin, smoothstep, tanh, vec2, vec4 } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { AirMass } from './air-mass';
import { AtmosphericWindField, SURFACE_HEIGHT, UPPER_CLOUD_HEIGHT } from './atmospheric-wind';
import { BakedField } from './baked-field';
import { CirculatingNoise } from './circulating-noise';
import { Circulation, SURFACE_BANDS, UPPER_BANDS } from './circulation';
import { ConvectiveActivity } from './convective-activity';
import { Cyclones } from './cyclones';
import { eastAt, latitudeOf, northAt } from './sphere-frame';
import { RossbyWave } from './rossby-wave';
import { SURFACE_HUMIDITY_BASE, WeatherTransport } from './weather-transport';
import { composeWind, FRICTION_RATE, balancedWind, isobarAt } from './wind-law';
import type { WebGPURenderer } from 'three/webgpu';
import type { GpuTimingSink } from '../gpu-timings';
import type { NoiseOctave } from './circulating-noise';
import type { ClimateMap } from './climate-map';
import type { FieldProjection } from './field-projection';
import type { BalancedWind } from './wind-law';
import type { FloatNode, Vec2Node, Vec3Node } from '../tsl-types';

// 単位方向における天気。
export interface WeatherSample {
  readonly pressure: FloatNode; // 平年からの偏差 [hPa]
  readonly surfaceWind: Vec2Node; // 地表の風の東向き・北向きの成分 [m/s]
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

// 気圧の写しから読んだ、風を解くのに要る量。gradient は勾配の接ベクトル [hPa/rad]、isobar は
// 等圧線方向の単位接ベクトル、bend は等圧線方向の 2 階微分 [hPa/rad²]。
interface PressureField {
  readonly pressure: FloatNode;
  readonly gradient: Vec3Node;
  readonly isobar: Vec3Node;
  readonly bend: FloatNode;
}

// ノイズの段の表。周波数は 1 rad あたりの山の数で、角波長 [km] は 6371 ÷ 周波数。気圧は 1 段に
// 取る — 上昇流が気圧そのものの関数なので、段を増やすとノイズの格子が雲へそのまま出る。
const PRESSURE_NOISE: readonly NoiseOctave[] = [
  { frequency: 1.2, amplitude: 1 }, // 5300 km
];
// 場の振れ幅 [hPa]。段数によらない。
const PRESSURE_NOISE_AMPLITUDE = 18;

// 気圧の偏差から出る上昇流。利得 [m/s] が高気圧側の吹きおろしの上限、低気圧側は尺度 [hPa] ごとに
// e 倍に伸びる(上昇は狭く強く、下降は広く弱い)。尺度は並の低気圧の芯(24 hPa)で 0.03 m/s に
// なる長さ。利得を上げると低気圧が飽和した円盤になり、流入が巻き込んだ渦を塗り潰す。
const PRESSURE_LIFT_GAIN = 0.02;
const PRESSURE_LIFT_SCALE = 27;
// 上昇流の頭打ち [m/s]。急な斜面と深い谷の芯では上昇流が並の何倍にもなり、線形のままだと湿度が
// 0/1 で切れて硬い縁の白い塊になる。
const LIFT_LIMIT = 0.06;
// 前線の帯。気団の圧縮が効き始めから幅ぶん進む間に、帯の強さが 0 から 1 へ渡る。効き始めは 35〜60° の
// 帯が背景として持つ圧縮(90 パーセンタイルで 1.19〜1.28)の 2 割上 — 下げると空の半分が前線になる。
// 幅は、圧縮の稜線(幅 500〜600 km の丘、頂点は 99 パーセンタイルで 2.3〜2.7)が丘ごと飽和する狭さに
// 取り、いちばん白い芯に帯の幅を持たせる(`DEVELOP/SPEC/RENDERING.md`「いちばん白い芯も帯の幅
// いっぱいを占め」)。
const FRONT_ONSET = 1.45;
const FRONT_WIDTH = 0.35;
// 前線を強める湿度の水平勾配の効き始めと幅 [1/rad]。湿った空気と乾いた空気の境目にも雲帯を立てる。
// 幅は湿度写しの量子化より十分広く取る — 狭いと線状の格子が出る。
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
// 帯が飽和した所で地表付近の湿度へ足す底上げ。被覆率の伝達関数の幅(0.22)の 1.4 倍で、帯の芯では
// 上昇流による偏差の増幅(VORTEX_CONTRAST)と合わせて被覆率が上端へ届き、途切れない帯になる
// (`DEVELOP/SPEC/RENDERING.md`「前線の帯そのものが、その空でいちばん厚い雲になる」)。
const BAND_HUMIDITY = 0.3;
// 温帯と熱帯を分ける緯度の門。温帯では前線の、熱帯では雨帯の伝達関数を使い、暖気の流入も温帯に
// 効かせる — 熱帯では貿易風の収束が緯線に沿った圧縮の環を作り、流入を通すと熱帯全体が一律に乾く。
const FRONT_LATITUDE_START = THREE.MathUtils.degToRad(20);
const FRONT_LATITUDE_FULL = THREE.MathUtils.degToRad(35);
// 風が斜面を駆け上がる分の利得。等倍では偏西風や貿易風が山脈へ当たり続けるだけで上昇流が頭打ちに
// 達し、地形の縞が年中貼り付く — 慢性的な湿潤・乾燥は平年の雲量が持つ。
const TERRAIN_LIFT_GAIN = 0.35;
// 陸へ上乗せする高さ [m]。海と陸の比熱の差を、海岸へ吹き込む風が駆け上がる斜面として代用する。
const LAND_HEIGHT_BIAS = 800;
// 上昇流が湿度へ効く利得 [per m/s]。地表付近の上向きの湿りは、足す分(ここ)と偏差を増幅する分
// (VORTEX_CONTRAST)に分ける — 足すだけでは渦の上に飽和した円盤を塗り、流入が巻き込んだ筋を消す。
// 地表付近の沈降の乾きは上昇より弱く取る — 海洋境界層は沈降の下でも層積雲を保ち、同じ利得では
// 亜熱帯高圧帯の下の海が丸ごと晴れる。
const SURFACE_LIFT_HUMIDITY = 1.3;
const SURFACE_SUBSIDENCE_DRYING = 1.0;
const UPPER_LIFT_HUMIDITY = 0.7;
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

// 大循環の気圧帯 [hPa]: 赤道と ±60° が低く、±30° と極が高い。緯度の 6 倍の余弦なので、緯度に
// ついての微分は sin(6 φ) × 6 × 振幅 [hPa/rad]。
const PRESSURE_BAND_AMPLITUDE = 8;

// 気圧の勾配を取る中心差分の刻み [rad]。台風の芯の広がり(250 km ≈ 0.039 rad)より細かく、
// 気圧の写しの 1 texel より粗い。写しは視点中心の cap なので texel の角は視点の高さで変わるが、
// いちばん粗い置き方(半径 π/2)でも 2/512 ≈ 3.9e-3 rad で、この刻みを越えない。
const GRADIENT_STEP = 0.01;
// 等圧線方向の 2 階微分を取る刻み [rad]。写しは半精度で、2 階差分に乗る量子化の雑音は刻みの二乗で
// 効く。勾配と同じ刻みで取ると、帯とノイズだけの平らな所で曲がりが雑音に埋もれる。
const BEND_STEP = 0.02;
// 対流を流す風の摩擦 [1/s]。湿度を流す風より強く取ると、等圧線を深く横切って 20〜30° 違う向きへ
// 伸びる。同じ風で流すと 2 枚が同じ向きへ伸びて、掛け合わせても筋のままになる。
const CONVECTION_FRICTION = 3 * FRICTION_RATE;
// 風が等圧線を横切る角の上限 [rad]。湿度の風は中緯度で摩擦が作る角(45° で 30°)そのものに取る。
// 対流の風は摩擦が作る 60° を 50° に抑え、湿度の風と向きを 20° 離して 2 枚の移流場を交差させる。
// 熱帯では両方が大きな流入角を切り、台風のまわりで粒が放射状の筋に引かれるのを止める。
const SURFACE_WIND_CROSSING_LIMIT = THREE.MathUtils.degToRad(30);
const CONVECTION_WIND_CROSSING_LIMIT = THREE.MathUtils.degToRad(50);

// 渦の目が移流後の湿度から引く深さ。眼壁の飽和と金床の天蓋(ANVIL_HUMIDITY)の両方を貫く深さに
// 取る。上層を深く引いて、薄い雲の穴を厚い雲の目よりひとまわり広く開ける。
const SURFACE_EYE_DRYNESS = 0.8;
const UPPER_EYE_DRYNESS = 2;
// 金床の天蓋が地表付近の湿度へ足す高さ。天蓋の下の円盤が隙間なく埋まるよう、並の湿度からでも
// 雲量が飽和する分を足す。
const ANVIL_HUMIDITY = 0.5;
// 暖気の流入が地表付近の湿度へ効く利得 [per rad]。並の流入(0.26 rad)で伝達関数の幅の半分ほど
// 動く高さ。この項の平均は正なので、源の底上げ(SURFACE_HUMIDITY_BASE)をそのぶん下げて釣り合わせる。
const WARM_HUMIDITY = 0.6;
// 移流後に足す平年の雲量の重み(地表付近と上層)。雲量の地理的な差が凝結のしきい値をまたぐ幅に
// 取る — 小さいと砂漠にも海と同じだけ雲が湧き、大きいと雲の多い海が覆われたまま平年の雲量図が
// 貼り付く。
const SURFACE_MEAN_CLOUDINESS_WEIGHT = 0.30;
const UPPER_MEAN_CLOUDINESS_WEIGHT = 0.24;
// 平年の雲量を湿度へ渡す S 字の裾と肩。線形では、砂漠を晴らす重みで雲の多い海が覆われたまま動かなく
// なる。裾は砂漠(0.14)の下、肩は年中曇りの海(0.89)の側に置く — 狭めると乾いた大陸(0.43〜0.51)や
// 貿易風帯の海(0.50〜0.65)まで雲を失う。
const MEAN_CLOUDINESS_DRY = 0.10;
const MEAN_CLOUDINESS_WET = 0.85;

export class WeatherModel {
  // 大循環の平均風。地表付近と上層の背景風をここから引く。
  private readonly atmosphericWind = new AtmosphericWindField();
  private readonly surfaceCirculation = new Circulation(SURFACE_BANDS);
  private readonly upperCirculation = new Circulation(UPPER_BANDS);
  private readonly rossbyWave = new RossbyWave();
  private readonly cyclones: Cyclones;
  private readonly pressureNoise: CirculatingNoise;
  private readonly transport: WeatherTransport;
  private readonly pressure: BakedField;
  private readonly convectiveActivity: ConvectiveActivity;
  private readonly airMass: AirMass;

  // 時刻 0 の天気で始める。climate はこの天体の気候の事前分布、projection は写しの持ち方、
  // surfaceRadius は天体の半径 [m]、rotationPeriod は自転周期 [s]。
  public constructor(
    private readonly climate: ClimateMap, projection: FieldProjection,
    private readonly surfaceRadius: number, private readonly rotationPeriod: number,
  ) {
    const texel = projection.texelAngle;
    this.cyclones = new Cyclones(surfaceRadius, rotationPeriod);
    this.pressureNoise = new CirculatingNoise(this.surfaceCirculation, PRESSURE_NOISE, texel);
    this.transport = new WeatherTransport(
      this.surfaceCirculation, this.upperCirculation, projection, surfaceRadius);
    this.pressure = new BakedField(
      'pressure', THREE.RedFormat, projection, (direction) => vec4(this.pressureSourceAt(direction), 0, 0, 1));
    this.convectiveActivity = new ConvectiveActivity(this.surfaceCirculation, projection);
    this.airMass = new AirMass(projection, (direction) => this.traceFlowAt(direction), surfaceRadius);
    this.syncTime(0);
  }

  // いまの時刻の気圧と、移流前の場を写しへ焼く。syncTime のあと、weatherAt のグラフを描く前に呼ぶ。
  public bake(renderer: WebGPURenderer, gpu?: GpuTimingSink): void {
    this.pressure.render(renderer, gpu);
    // 気団は気圧の写しを読んで遡るので、気圧の後に焼く。
    this.airMass.bake(renderer, gpu);
    this.transport.bake(renderer, gpu);
    this.convectiveActivity.bake(renderer, gpu);
  }

  // 時刻 [s] を uniform へ写す。
  public syncTime(seconds: number): void {
    this.surfaceCirculation.syncTime(seconds);
    this.upperCirculation.syncTime(seconds);
    this.rossbyWave.syncTime(seconds);
    this.cyclones.syncTime(seconds);
    this.transport.syncTime(seconds);
  }

  // 単位方向 direction における天気のグラフ。
  public weatherAt(direction: Vec3Node): WeatherSample {
    const latitude = latitudeOf(direction);
    const east = eastAt(direction);
    const north = northAt(direction);

    const { pressure, gradient, isobar, bend } = this.pressureFieldAt(direction, east, north);

    // 風: 局所的な気圧風へ、大循環の背景風(地表付近/上層)とロスビー波を重ねる。
    const rossby = this.rossbyWave.perturbationAt(direction, this.surfaceRadius);
    const surfaceMean = this.atmosphericWind.sampleNode(latitude, SURFACE_HEIGHT);
    const upperMean = this.atmosphericWind.sampleNode(latitude, UPPER_CLOUD_HEIGHT);
    const surfaceBackground = east.mul(surfaceMean.x).add(north.mul(surfaceMean.y)).add(rossby);
    const upperBackground = east.mul(upperMean.x).add(north.mul(upperMean.y)).add(rossby);
    const surfaceWind = composeWind(balancedWind(
      gradient, isobar, bend, latitude, FRICTION_RATE, SURFACE_WIND_CROSSING_LIMIT,
      this.surfaceRadius, this.rotationPeriod,
    ), surfaceBackground);
    const convectionWind = composeWind(balancedWind(
      gradient, isobar, bend, latitude, CONVECTION_FRICTION, CONVECTION_WIND_CROSSING_LIMIT,
      this.surfaceRadius, this.rotationPeriod,
    ), surfaceBackground);
    const upperWind = composeWind(balancedWind(
      gradient, isobar, bend, latitude, FRICTION_RATE, SURFACE_WIND_CROSSING_LIMIT,
      this.surfaceRadius, this.rotationPeriod,
    ), upperBackground);

    // 風で流した湿度・対流と、前線を強める湿度の勾配。
    const advected = this.transport.advectedAt(direction, surfaceWind, upperWind, convectionWind);
    const moistureGradient = this.moistureGradientAt(direction, east, north);

    // 上昇流: 風が斜面を駆け上がる分と、気圧の谷が引き上げる分と、気団の境目が押し上げる分。
    const windComponents = eastNorthComponents(surfaceWind.velocity, east, north);
    const airMass = this.airMass.at(direction, latitude);
    const extratropical = smoothstep(FRONT_LATITUDE_START, FRONT_LATITUDE_FULL, abs(latitude));
    const warmth = airMass.warmth.mul(extratropical);
    const terrainLift = dot(windComponents, this.climate.slope(direction, LAND_HEIGHT_BIAS, this.surfaceRadius))
      .mul(TERRAIN_LIFT_GAIN);
    // 折り目の帯: 温帯では前線(気団の圧縮へ、湿度の境目と気圧の上昇流を少し足す)、熱帯では雨帯の
    // 伝達関数が圧縮の稜線を帯の強さへ写す。
    const updraft = smoothstep(0.01, 0.04, max(liftFromPressure(pressure), 0));
    const temperatureFront = smoothstep(FRONT_ONSET, FRONT_ONSET + FRONT_WIDTH, airMass.compression);
    const moistureFront = smoothstep(
      MOISTURE_GRADIENT_ONSET,
      MOISTURE_GRADIENT_ONSET + MOISTURE_GRADIENT_WIDTH,
      moistureGradient,
    );
    const front = temperatureFront.add(moistureFront.mul(0.2)).add(updraft.mul(0.15)).min(1).mul(extratropical);
    const rainband = smoothstep(RAINBAND_ONSET, RAINBAND_ONSET + RAINBAND_WIDTH, airMass.compression)
      .mul(extratropical.oneMinus());
    const band = min(front.add(rainband), 1);
    const bandLift = band.mul(BAND_LIFT);
    const lift = limitLift(terrainLift.add(liftFromPressure(pressure)).add(bandLift));

    // 湿度: 流した写しへ、場所と渦に貼り付く項(平年の雲量・上昇流・帯・金床・目)を足し引きする。
    const meanCloudiness = this.climate.meanCloudiness(direction);
    const landFraction = this.climate.landFraction(direction);
    const eye = this.cyclones.eyeAt(direction);
    const anvil = this.cyclones.anvilAt(direction);
    const deviation = advected.surfaceHumidity.sub(SURFACE_HUMIDITY_BASE);
    const surfaceHumidity = clamp(
      advected.surfaceHumidity.add(deviation.mul(max(lift, 0).div(LIFT_LIMIT)).mul(VORTEX_CONTRAST))
        .add(cloudinessBias(meanCloudiness).mul(SURFACE_MEAN_CLOUDINESS_WEIGHT))
        .add(max(lift, 0).mul(SURFACE_LIFT_HUMIDITY)).add(min(lift, 0).mul(SURFACE_SUBSIDENCE_DRYING))
        .add(warmth.mul(WARM_HUMIDITY)).add(band.mul(BAND_HUMIDITY))
        .add(anvil.mul(ANVIL_HUMIDITY)).sub(eye.mul(SURFACE_EYE_DRYNESS)), 0, 1);
    const upperHumidity = clamp(
      advected.upperHumidity.add(cloudinessBias(meanCloudiness).mul(UPPER_MEAN_CLOUDINESS_WEIGHT))
        .add(max(lift, 0).mul(UPPER_LIFT_HUMIDITY)).add(min(lift, 0).mul(UPPER_SUBSIDENCE_DRYING))
        .sub(eye.mul(UPPER_EYE_DRYNESS)), 0, 1);

    return {
      pressure,
      surfaceWind: windComponents,
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
    // 曲がりは等圧線に沿って測る — 勾配の向きに測ると、谷の深さそのものを曲がりとして拾う。
    const isobar = isobarAt(direction, gradient);
    const isobarStep = isobar.mul(BEND_STEP);
    const pressureAhead = this.pressure.at(normalize(direction.add(isobarStep))).r;
    const pressureBehind = this.pressure.at(normalize(direction.sub(isobarStep))).r;
    const bend = pressureAhead.add(pressureBehind).sub(pressure.mul(2)).div(BEND_STEP ** 2);
    return { pressure, gradient, isobar, bend };
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
    const eddy = gradient.sub(north.mul(sin(latitude.mul(6)).mul(6 * PRESSURE_BAND_AMPLITUDE)));
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

  // 気圧の偏差 [hPa]: 大循環の帯 + ノイズ + 低気圧の谷。
  private pressureSourceAt(direction: Vec3Node): FloatNode {
    const band = cos(latitudeOf(direction).mul(6)).mul(-PRESSURE_BAND_AMPLITUDE);
    return band.add(this.pressureNoise.at(direction).mul(PRESSURE_NOISE_AMPLITUDE))
      .add(this.cyclones.pressureAt(direction));
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

// 気圧の偏差 [hPa] が生む上昇流 [m/s]。低気圧で正、高気圧で負。
function liftFromPressure(pressure: FloatNode): FloatNode {
  return exp(pressure.div(-PRESSURE_LIFT_SCALE)).sub(1).mul(PRESSURE_LIFT_GAIN);
}

// 上昇流を LIFT_LIMIT へ漸近させる。LIFT_LIMIT より十分弱い上昇流はほぼ素通しで、強いものだけが丸まる。
function limitLift(lift: FloatNode): FloatNode {
  return tanh(lift.div(LIFT_LIMIT)).mul(LIFT_LIMIT);
}
