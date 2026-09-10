// 状態を持たない天気のモデル。天体固定の単位方向と時刻から、気圧 → 風 → 上昇流 → 湿度・対流と
// 辿るグラフを TSL で組む。時刻の閉じた関数なので、どの時刻へ飛んでも同じ空が出る。値はすべて
// 見えのための調整値。
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
import type { ClimateMapLike } from './climate-map';
import type { FieldProjection } from './field-projection';
import type { BalancedWind } from './wind-law';
import type { FloatNode, Vec2Node, Vec3Node } from '../tsl-types';

// 単位方向における天気。気圧は平年からの偏差 [hPa]、地表の風は東向き・北向きの成分 [m/s]、
// 上昇流は [m/s](地形と気圧による、負なら下降)、地表付近と上層の湿度は 0..1、対流は対流セルの
// 強弱(0 中心の高周波、x が粒・y が網目)、対流の活発度はその強弱がどれだけ強く現れるか 0..1、
// 圧縮は気団の境目の押し縮まり(1 で何も起きていない)、帯は気団の折り目に立つ雲の帯の強さ 0..1
// (温帯では前線、眼を持つ渦のまわりでは雨帯。1 で飽和)、暖気の流入は出身地からの緯度の差 [rad]
// (負で寒気)、金床は平らな天蓋の濃さ 0..1、平年の雲量と陸らしさは気候の分布 0..1、圏界面は
// その緯度の対流の天井 [m]。
export type WeatherSample = {
  readonly pressure: FloatNode;
  readonly surfaceWind: Vec2Node;
  readonly lift: FloatNode;
  readonly surfaceHumidity: FloatNode;
  readonly upperHumidity: FloatNode;
  readonly convection: Vec2Node;
  readonly convectiveActivity: FloatNode;
  readonly compression: FloatNode;
  readonly band: FloatNode;
  readonly warmth: FloatNode;
  readonly anvil: FloatNode;
  readonly meanCloudiness: FloatNode;
  readonly landFraction: FloatNode;
  readonly tropopause: FloatNode;
};

// 気圧の写しから読んだ、風を解くのに要る量。gradient は勾配の接ベクトル [hPa/rad]、isobar は
// 等圧線方向の単位接ベクトル、bend は等圧線方向の 2 階微分 [hPa/rad²]。
type PressureField = {
  readonly pressure: FloatNode;
  readonly gradient: Vec3Node;
  readonly isobar: Vec3Node;
  readonly bend: FloatNode;
};

// ノイズの段の表。周波数は 1 rad あたりの山の数で、角波長 [km] は 6371 ÷ 周波数。
// 気圧は 1 段しか持たない。総観規模より細かい構造を実際に持たないうえ、上昇流が気圧そのものの
// 関数なので、段を増やすとノイズの格子が雲へそのまま出る。
const PRESSURE_NOISE: readonly NoiseOctave[] = [
  { frequency: 1.2, amplitude: 1 }, // 5300 km
];
// 場の振れ幅。CirculatingNoise が段の振幅の総和で割って返すので、段数を変えてもここは動かない。
const PRESSURE_NOISE_AMPLITUDE = 18;

// 気圧の偏差から出る上昇流。利得 [m/s] が高気圧側の吹きおろしの上限で、低気圧側は圧力の尺度
// [hPa] ごとに e 倍に伸びる。上昇は狭く強く、下降は広く弱いので、写像は原点で非対称に取る。
// 利得を上げると低気圧が湿度へ飽和した円盤を書き、流入が巻き込んだ渦をその上から塗り潰す
// — 渦の見えは、滑らかな円盤ではなく、流入が既にある雲を縮める分から出る。尺度は、並の低気圧の
// 芯(24 hPa)で 0.03 m/s になる長さ。
const PRESSURE_LIFT_GAIN = 0.02;
const PRESSURE_LIFT_SCALE = 27;
// 上昇流の頭打ち [m/s]。急な斜面へ強い風が当たる所と深い谷の芯では上昇流が並の何倍にもなり、
// 線形のままだと湿度が 0/1 で切れて硬い縁の白い塊になる。漸近させて、並の上昇流はほぼ素通しにする。
const LIFT_LIMIT = 0.06;
// 前線の帯。気団の圧縮が効き始めを超えてから幅ぶん進む所まで、帯の強さが 0 から 1 へ渡る。前線は
// 低気圧を囲む閉じた流れ(猫の目)の縁に沿う浅い弧に立つ。効き始めは、低気圧から離れた 35〜60° の
// 帯が背景として持つ圧縮(90 パーセンタイルの実測 1.19〜1.28)の 2 割上に取る — ここを下げると
// 気団の境目ではなく空の半分が前線になる。**幅は、折り目の丘そのものが飽和する狭さに取る** —
// 圧縮の稜線は線ではなく幅 500〜600 km の丘で、その頂点(99 パーセンタイルの実測 2.3〜2.7)だけを
// 飽和させると、帯は丘の芯を走る細い筋になっていちばん白い所が帯の幅を持たない
// (`DEVELOP/SPEC/RENDERING.md`「いちばん白い芯も帯の幅いっぱいを占め」)。上端は、35〜60° の帯の
// 4%(北)・7%(南)が飽和する高さ。**幅を狭めても帯が湿度へ足す総量は動かない** — 飽和する面が
// 広がった分だけ半端な強さの裾が痩せるので、同じ量が細い筋から幅のある面へ移るだけになる。
const FRONT_ONSET = 1.45;
const FRONT_WIDTH = 0.35;
// 湿度の水平勾配 [1/rad]。気団の温度差だけでなく、湿った空気と乾いた空気の境界でも前線の
// 雲帯が強まるようにする。湿度写しの量子化より十分広い幅で渡し、線状の格子を作らない。
const MOISTURE_GRADIENT_ONSET = 0.12;
const MOISTURE_GRADIENT_WIDTH = 0.28;
// 雨帯。眼を持つ渦が周りの気団を巻き込んで折り畳んだ筋で、圧縮は前線の帯より桁が大きい(台風の芯から
// ±1180 km では 45% が 2 を超え、腕の稜線は 5〜9)。効き始めは稜線の下端に置き、幅は稜線の中でいちばん
// 押し縮まった区間だけが帯として飽和して、腕の先へ向けて連続に薄れる長さに取る — 芯のまわりのシアの丘
// (2〜4)と、渦から離れた熱帯の背景(99.9 パーセンタイルの実測 3.2)には掛からない。ここを狭めると
// 稜線が丸ごと飽和し、腕は太い真っ白な帯になって被覆率が実写の 2 倍を超える(`DEVELOP/SPEC/
// RENDERING.md`「雨帯は、渦が周りの気団を巻き込んで折り畳んだ筋に沿う」)。
const RAINBAND_ONSET = 5;
const RAINBAND_WIDTH = 4;
// 帯が飽和した所で立つ上昇流 [m/s]。頭打ち(LIFT_LIMIT)と同じ高さに取る — 帯の中は深い谷の芯と
// 同じだけ持ち上がる。
const BAND_LIFT = 0.06;
// 帯が飽和した所で地表付近の湿度へ足す底上げ。被覆率の伝達関数の幅(0.22)の 1.4 倍で、帯の芯
// (強さ 1)では帯の上昇流が偏差を増幅する分(VORTEX_CONTRAST)と合わせて被覆率が上端へ届き、途切れない
// 帯になる(`DEVELOP/SPEC/RENDERING.md`「前線の帯そのものが、その空でいちばん厚い雲になる」)。
// 帯の外へ落ちていく縁では底上げも比例して痩せ、移流した湿度の濃淡が階調として残る。
const BAND_HUMIDITY = 0.3;
// 前線が立つ緯度の門。**前線と、その両側の気団の性質はどちらもこの門を通る** — 前線の伝達関数
// (効き始め 1.45)は温帯だけに掛け、熱帯では貿易風の収束が緯線に沿った圧縮の環を作るので、代わりに
// 雨帯の伝達関数(効き始め 4)が眼を持つ渦の腕の稜線だけを拾う。気団の流入も、熱帯では貿易風が
// どこでも高緯度から吹き込むので、門が無いと熱帯全体が一律に乾く。
const FRONT_LATITUDE_START = THREE.MathUtils.degToRad(20);
const FRONT_LATITUDE_FULL = THREE.MathUtils.degToRad(35);
// 風が斜面を駆け上がる分の利得。等倍だと、偏西風や貿易風が山脈へ当たり続けるだけで上昇流が
// 頭打ちに達し、気候と無関係な地形の縞が年中貼り付く。慢性的な湿潤・乾燥は平年の雲量が持つので、
// ここは低気圧が山へぶつかったときだけ効く高さへ落とす。
const TERRAIN_LIFT_GAIN = 0.35;
// 陸へ上乗せする高さ [m]。海と陸の比熱の差を、海岸へ吹き込む風が駆け上がる斜面として代用する。
// 地形の上昇流は釣り合い風(帯の平均風を含まない)から出るので、低気圧が海から吹き込むときだけ効く。
const LAND_HEIGHT_BIAS = 800;
// 上昇流の利得 [per m/s]。上向きは地表付近と上層の両方を湿らせ、下向きは地表付近だけを乾かす。
// **地表付近の上向きの湿りは、足す分(ここ)と、移流した湿度の偏差を増幅する分(VORTEX_CONTRAST)に
// 分けて持つ。** 足すだけでは渦の上に飽和した円盤を塗り、流入が巻き込んだ筋を消す — 増幅は
// 螺旋を残し、湿った筋をより白く、乾いた隙間をより晴らす。**下降の利得は上昇より小さく取る。**
// 沈降は自由大気を乾かすが、その下の海洋境界層は湿ったまま層積雲を保つ — 同じ利得で乾かすと、
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
// 気圧の写しの texel(全球で 6.1e-3 rad)より粗い。
const GRADIENT_STEP = 0.01;
// 等圧線方向の 2 階微分を取る刻み [rad]。写しは半精度で、2 階差分に乗る量子化の雑音は刻みの二乗で
// 効く。勾配と同じ刻みで取ると、帯とノイズだけの平らな所で曲がりが雑音に埋もれる。
const BEND_STEP = 0.02;
// 対流を流す風の摩擦 [1/s]。湿度を流す風より強く取ると、等圧線を深く横切って 20〜30° 違う向きへ
// 伸びる。同じ風で流すと 2 枚が同じ向きへ伸びて、掛け合わせても筋のままになる。
const CONVECTION_FRICTION = 3 * FRICTION_RATE;
// 風が等圧線を横切る角の上限 [rad]。湿度を流す風と対流を流す風で別に持つ。湿度の風の上限は中緯度で
// 摩擦が作る角そのもの(45° で 30°)で、熱帯の外では 45° より低緯度の流れが高気圧性に曲がる所でだけ
// 効く(実測: 45°N の低気圧の撮影で風の写しが動くのは texel の 2.6%、それも 5 LSB 以下で、35〜60° の
// 帯の平均は動かない)。対流の風は中緯度で摩擦が作る 60° より内側の 50° に常に抑えられ、湿度の風と
// 向きが 20° 離れたままになる — 2 枚の移流場は同じ向きへ筋を引かず交差する。熱帯(15°)では上限が
// 57° と 78° の流入を切り、台風のまわりで粒が放射状の筋に引かれるのを止める。
const SURFACE_WIND_CROSSING_LIMIT = THREE.MathUtils.degToRad(30);
const CONVECTION_WIND_CROSSING_LIMIT = THREE.MathUtils.degToRad(50);

// 渦の目。移流の後の湿度をこれだけ下げる。目は渦とともに動く定常の構造なので、風に流さない。
// 眼壁は上昇流が頭打ちに張り付いて飽和し、その上に金床の天蓋(ANVIL_HUMIDITY)が乗るので、
// 両方を貫く深さが要る。上層を深く引くのは、薄い雲の穴を厚い雲の目よりひとまわり広く開けるため。
const SURFACE_EYE_DRYNESS = 0.8;
const UPPER_EYE_DRYNESS = 2;
// 金床の天蓋が地表付近の湿度へ足す高さ。天蓋の下の円盤は隙間なく埋まるべきなので、並の湿度からでも
// 雲量が飽和する分を足す。目はこの後に引くので、天蓋を貫いて開く深さは SURFACE_EYE_DRYNESS が持つ。
const ANVIL_HUMIDITY = 0.5;
// 暖気の流入が地表付近の湿度へ効く利得 [per rad]。36 h の追跡で気団は最大 0.3 rad ぶんの緯度を
// 越えてくるので、並の流入(0.26 rad)で伝達関数の幅の半分ほど動く高さに取る。**この項は
// 平均が 0 ではない** — 暖気の流入する所のほうが広いので、底上げをそのぶん下げて釣り合わせる。
const WARM_HUMIDITY = 0.6;
// 湿度の底上げ(移流前の源が持つ、平年の雲量を抜きにした値)と、移流後に足す平年の雲量の重み。
// 地表付近と上層で別に持つ。重みは、雲量の地理的な差が凝結のしきい値をまたぐ幅に取る — 小さく
// 取ると砂漠にも海と同じだけ雲が湧き、大きく取ると雲の多い海が覆われたまま動かなくなって、
// 平年の雲量図がそのまま貼り付く。底上げは層ごとに合わせる量が違う。地表付近は、重みを変えても
// 平年並みの土地の湿度が動かないように取る(平年の雲量の中央値 0.70 ぶんを差し引き、さらに前線の
// 上昇流と暖気の流入が平均で足す分を差し引く)。上層は、±60° の薄い雲の明るさ(1 − e^−τ)の平均が
// 実写(0.13 付近)に合う高さに実測で取る。
const SURFACE_MEAN_CLOUDINESS_WEIGHT = 0.30;
const UPPER_MEAN_CLOUDINESS_WEIGHT = 0.24;
// 平年の雲量を湿度へ渡す S 字の裾と肩。**線形では乾燥帯だけを強く晴らせない** — 砂漠を晴らす
// 重みでは、雲の多い海が覆われたまま動かなくなる。裾は砂漠(0.14)より下、肩は年中曇りの海
// (0.89)の側へ置き、あいだを広く渡す — 幅を狭めると、乾いた大陸(0.43〜0.51)や貿易風帯の海
// (0.50〜0.65)まで裾へ落ちて、砂漠でない土地まで丸ごと雲を失う。
const MEAN_CLOUDINESS_DRY = 0.10;
const MEAN_CLOUDINESS_WET = 0.85;

export class WeatherModel {
  // One physical background profile is shared by the local pressure solver,
  // upper-air transport, and the pattern circulations below.
  private readonly atmosphericWind = new AtmosphericWindField();
  private readonly surfaceCirculation = new Circulation(SURFACE_BANDS);
  private readonly upperCirculation = new Circulation(UPPER_BANDS);
  private readonly rossbyWave = new RossbyWave();
  private readonly cyclones = new Cyclones();
  // ノイズは焼く先の texel で標本化できない段を畳むので、写しの持ち方が決まってから組む。
  private readonly pressureNoise: CirculatingNoise;
  private readonly transport: WeatherTransport;
  private readonly pressure: BakedField;
  private readonly convectiveActivity: ConvectiveActivity;
  private readonly airMass: AirMass;

  // 時刻 0 の天気で始める。climate はこの天体の気候の事前分布、projection は写しの持ち方。
  public constructor(private readonly climate: ClimateMapLike, projection: FieldProjection) {
    const texel = projection.texelAngle;
    this.pressureNoise = new CirculatingNoise(this.surfaceCirculation, PRESSURE_NOISE, texel);
    this.transport = new WeatherTransport(this.surfaceCirculation, this.upperCirculation, projection);
    // 気圧の写しだけは段ではなく、読む側の中心差分の刻み(GRADIENT_STEP)が細かさを決める。
    this.pressure = new BakedField(
      'pressure', THREE.RedFormat, projection, 1, (direction) => vec4(this.pressureSourceAt(direction), 0, 0, 1));
    this.convectiveActivity = new ConvectiveActivity(this.surfaceCirculation, projection);
    this.airMass = new AirMass(projection, (direction) => this.traceFlowAt(direction));
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

    // 湿度と対流は、同じ物理的な背景風へ局所的な気圧風を重ねる。上層は同じ局所風に
    // 高度依存の偏西風を重ね、雲・気団・前線が別々の平均風を持たないようにする。
    const rossby = this.rossbyWave.perturbationAt(direction);
    const surfaceMean = this.atmosphericWind.sampleNode(latitude, SURFACE_HEIGHT);
    const upperMean = this.atmosphericWind.sampleNode(latitude, UPPER_CLOUD_HEIGHT);
    const surfaceBackground = east.mul(surfaceMean.x).add(north.mul(surfaceMean.y)).add(rossby);
    const upperBackground = east.mul(upperMean.x).add(north.mul(upperMean.y)).add(rossby);
    const surfaceWind = composeWind(balancedWind(
      gradient, isobar, bend, latitude, FRICTION_RATE, SURFACE_WIND_CROSSING_LIMIT,
    ), surfaceBackground);
    const convectionWind = composeWind(balancedWind(
      gradient, isobar, bend, latitude, CONVECTION_FRICTION, CONVECTION_WIND_CROSSING_LIMIT,
    ), surfaceBackground);
    const upperWind = composeWind(balancedWind(
      gradient, isobar, bend, latitude, FRICTION_RATE, SURFACE_WIND_CROSSING_LIMIT,
    ), upperBackground);

    // 湿度場も同じ風で移流したあと、温度代理(気団圧縮)と湿度勾配を前線へ渡す。
    const advected = this.transport.advectedAt(direction, surfaceWind, upperWind, convectionWind);
    const moistureGradient = this.moistureGradientAt(direction, east, north);

    // 上昇流: 風が斜面を駆け上がる分と、気圧の谷が引き上げる分と、気団の境目が押し上げる分。
    const windComponents = eastNorthComponents(surfaceWind.velocity, east, north);
    const airMass = this.airMass.at(direction, latitude);
    const extratropical = smoothstep(FRONT_LATITUDE_START, FRONT_LATITUDE_FULL, abs(latitude));
    const warmth = airMass.warmth.mul(extratropical);
    const terrainLift = dot(windComponents, this.climate.slope(direction, LAND_HEIGHT_BIAS)).mul(TERRAIN_LIFT_GAIN);
    // 折り目の帯: 温帯では前線の伝達関数が、熱帯では雨帯の伝達関数が、圧縮の稜線を帯の強さへ写す。
    // Fronts follow the air-mass temperature gradient, with a small continuous
    // enhancement where pressure-driven ascent supplies convergence/updraft.
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

    // 湿度は、風で流した写しへ、その場の平年の雲量と上昇流と金床を足し、渦の目のぶんを引いたもの。
    // 写しの偏差は上昇流が増幅する。写し以外は移流を通らないので、気候と地形と渦に貼り付いたまま
    // 歪まない。
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

  // 単位方向 direction(接平面の東 east・北 north)における気圧の写しの読み。4 点差分から勾配を、
  // 等圧線方向の 2 点差分からその向きの 2 階微分を取る。
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

  // 湿度写しの地表成分の水平勾配 [1/rad]。気団の温度代理とは別の境界を前線強度へ渡す。
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

  // 気団を風上へ遡らせる風。**経度に依らない流れをすべて落とし、渦と総観規模の擾乱だけで遡る。**
  // 気圧の勾配からは大循環の気圧帯を差し引き、帯の平均風は東向きの成分だけを足す — どちらも
  // 南北の成分は経度に依らないので、残すと収束する緯度に緯線に沿った圧縮の環と、緯度で決まる
  // 気団の流入の偏りができる。東西の流れが緯度で変わる分は残す。渦の作った気団の境目を
  // 南西–北東へ傾けるのがそれで、経度に依らない流れでも圧縮は作らない。
  // **移流の風には平均風を足さない** — 2 位相移流へ入れると、位相 A と B が数百 km ずれた別の
  // 模様を混ぜることになり、背景が全域でぼける。
  private traceFlowAt(direction: Vec3Node): BalancedWind {
    const east = eastAt(direction);
    const north = northAt(direction);
    const latitude = latitudeOf(direction);
    const { gradient, bend } = this.pressureFieldAt(direction, east, north);
    // 気圧帯は緯度だけの関数なので、その勾配は解析的に差し引ける。
    const eddy = gradient.sub(north.mul(sin(latitude.mul(6)).mul(6 * PRESSURE_BAND_AMPLITUDE)));
    const wind = balancedWind(
      eddy, isobarAt(direction, eddy), bend, latitude, FRICTION_RATE, SURFACE_WIND_CROSSING_LIMIT,
    );
    return {
      velocity: wind.velocity
        .add(east.mul(this.meanWindAt(direction).x))
        .add(north.mul(this.meanWindAt(direction).y))
        .add(this.rossbyWave.perturbationAt(direction)),
      turn: wind.turn,
    };
  }

  // 気圧の偏差 [hPa]: 大循環の帯 + ノイズ + 低気圧の谷。
  private pressureSourceAt(direction: Vec3Node): FloatNode {
    const band = cos(latitudeOf(direction).mul(6)).mul(-PRESSURE_BAND_AMPLITUDE);
    return band.add(this.pressureNoise.at(direction).mul(PRESSURE_NOISE_AMPLITUDE))
      .add(this.cyclones.pressureAt(direction));
  }

  // 移流前の湿度(x が地表付近、y が上層)。ここへ入れたものが風で流れる。
  //
  // **平年の雲量はここへ入れない。** 移流の変位は雲を筋に引くのに要る大きさなので、通すと気候の
  // 分布がその変位ぶん歪んで読めなくなる — 慢性的な湿潤・乾燥は場所に貼り付いているべきもので、
  // 流れていくものではない。
  public humiditySourceAt(direction: Vec3Node): Vec2Node {
    return this.transport.humiditySourceAt(direction);
  }

  // 単位方向 direction における高度1 kmの大循環の平均風(東向き・北向きの成分 [m/s])。
  public meanWindAt(direction: Vec3Node): Vec2Node {
    return this.atmosphericWind.sampleNode(latitudeOf(direction), SURFACE_HEIGHT);
  }

  // 移流前の対流の強弱(0 中心の高周波)。x が粒(細胞の芯)、y が網目(細胞の壁)で、**同じ
  // 勾配ノイズから出るので 1 回の評価で両方が積める。** 湿度と別の写しへ焼き、別の風で流す。
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
