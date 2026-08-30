// 状態を持たない天気のモデル。天体固定の単位方向と時刻から、気圧 → 風 → 上昇流 → 湿度・対流と
// 辿るグラフを TSL で組む。時刻の閉じた関数なので、どの時刻へ飛んでも同じ空が出る。値はすべて
// 見えのための調整値。
import {
  abs, clamp, cos, cross, dot, exp, float, fract, length, max, min, mix, normalize, sin, tanh, uniform, vec2, vec3,
  vec4,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { R_EARTH } from '../../physics/solar-system';
import { BakedField } from './baked-field';
import { CirculatingNoise } from './circulating-noise';
import { Circulation, SURFACE_BANDS, UPPER_BANDS } from './circulation';
import { Cyclones } from './cyclones';
import { eastAt, latitudeOf, northAt } from './sphere-frame';
import type { ClimateMap } from './climate-map';
import type { FieldProjection } from './field-projection';
import type { FloatNode, FloatUniform, Vec2Node, Vec3Node, Vec4Node } from '../tsl-types';

// 単位方向における天気。気圧は平年からの偏差 [hPa]、風は東向き・北向きの成分 [m/s]、
// 上昇流は [m/s](地形と気圧による、負なら下降)、湿度は 0..1(humidity が地表付近、
// upperHumidity が上層)、対流は 0..1 の深さ(深いほど雲頂が高い)。
export type WeatherSample = {
  readonly pressure: FloatNode;
  readonly wind: Vec2Node;
  readonly lift: FloatNode;
  readonly humidity: FloatNode;
  readonly upperHumidity: FloatNode;
  readonly convection: FloatNode;
};

// ノイズの段。段ごとに空間周波数(1 rad あたりの山の数)と段数を変える。
// 気圧は 1 段しか持たない。総観規模より細かい構造を実際に持たないうえ、上昇流が気圧そのものの
// 関数なので、段を増やすとノイズの格子が雲へそのまま出る。
const PRESSURE_NOISE = [1.2, 1] as const;
// 地表付近は湿度と対流の 2 枚で周波数を分担する。湿度の基準の角波長(1270 km)が雲塊の配置を、
// 対流の最上段(159 km)が粒の細かさを決める。**対流の最上段は対流の移流の 1 歩より大きく取る**
// — 下回ると、模様が変位場に沿って引き伸ばされ、粒ではなく筋の束になる。上層はこれ以上段を
// 減らせない — 薄い雲は光学的厚みが 1 に届かず下地が透けるので、上の段が縁ではなく繊維の濃淡と
// して直に見える。
const HUMIDITY_NOISE = [5, 3] as const;
const CONVECTION_NOISE = [20, 2] as const;
const UPPER_HUMIDITY_NOISE = [3.2, 5] as const;
const PRESSURE_NOISE_AMPLITUDE = 18;
const HUMIDITY_NOISE_AMPLITUDE = 0.3;
const CONVECTION_NOISE_AMPLITUDE = 0.35;
const UPPER_HUMIDITY_NOISE_AMPLITUDE = 0.35;

// 気圧の偏差から出る上昇流。利得 [m/s] が高気圧側の吹きおろしの上限で、低気圧側は圧力の尺度
// [hPa] ごとに e 倍に伸びる。上昇は狭く強く、下降は広く弱いので、写像は原点で非対称に取る。
// 利得を上げると低気圧が湿度へ飽和した円盤を書き、流入が巻き込んだ渦をその上から塗り潰す
// — 渦の見えは、滑らかな円盤ではなく、流入が既にある雲を縮める分から出る。
const PRESSURE_LIFT_GAIN = 0.02;
const PRESSURE_LIFT_SCALE = 20;
// 上昇流の頭打ち [m/s]。急な斜面へ強い風が当たる所と深い谷の芯では上昇流が並の何倍にもなり、
// 線形のままだと湿度が 0/1 で切れて硬い縁の白い塊になる。漸近させて、並の上昇流はほぼ素通しにする。
const LIFT_LIMIT = 0.06;
// 風が斜面を駆け上がる分の利得。等倍だと、偏西風や貿易風が山脈へ当たり続けるだけで上昇流が
// 頭打ちに達し、気候と無関係な地形の縞が年中貼り付く。慢性的な湿潤・乾燥は平年の雲量が持つので、
// ここは低気圧が山へぶつかったときだけ効く高さへ落とす。
const TERRAIN_LIFT_GAIN = 0.35;
// 上昇流の利得。上昇流は地表付近の湿度へ(下降で乾く)、上向きの分だけが上層の湿度と対流へ効く
// [per m/s]。対流の利得は、上昇流が頭打ちに張り付く眼壁と螺旋帯でノイズの振れ幅を超える高さに取る
// — そこで対流が飽和して、雲頂が上限まで立つ。
const LIFT_HUMIDITY = 5;
const UPPER_LIFT_HUMIDITY = 3;
const CONVECTION_LIFT = 3;

// 大循環の気圧帯 [hPa]: 赤道と ±60° が低く、±30° と極が高い。
const PRESSURE_BAND_AMPLITUDE = 8;

// 気圧の勾配を取る中心差分の刻み [rad]。台風の広がり(900 km ≈ 0.14 rad)より小さく、
// 気圧の写しの texel より数倍大きい。
const GRADIENT_STEP = 0.01;
// 風の利得 [m/s あたり hPa/rad]。流入は気圧の低い方へ、地衡風は等圧線に沿って(緯度の正弦に比例)。
// 流入と地衡風の比が、風が等圧線を横切る角を決める。
const INFLOW_GAIN = 0.15;
const GEOSTROPHIC_GAIN = 0.6;
// 対流を流す風で流入に掛ける重み。横切る角が深くなり、湿度を流す風と 20° 違う向きへ伸びる
// (45°・勾配 48 hPa/rad で 11.6° → 31.7°)。同じ風で流すと 2 枚が同じ向きへ伸びて、
// 掛け合わせても筋のままになる。
const CONVECTION_INFLOW_WEIGHT = 3;
// 流れの曲がりが流入を細らせる度合い [1 あたり hPa/rad]。曲がった流れでは遠心力がコリオリに
// 上乗せされて釣り合いを受け持つぶん、等圧線を横切る流入が減る。勾配が急なほど強く効くので、
// 台風の芯では横切る角が数分の一になる。これが無いと角が緯度だけの関数になり、熱帯の台風が
// 中緯度の低気圧より緩く巻く。
const CURVATURE_GAIN = 0.015;
// 風速の上限 [m/s]。台風の中心近くの勾配で地衡風が発散するのを抑える。
const WIND_CAP = 50;

// 移流の源を風で流す 2 位相移流の周期 [s]。長いほど流れの歪みが溜まり、短いほど位相の混ぜ目が目に付く。
const ADVECTION_PERIOD = 12 * 3600;
// 対流の移流の変位(湿度の変位に対する比)。対流は筋へ伸ばさずわずかに変形させるだけなので、
// 1 歩は並の風(20 m/s)で 86 km と、対流の最上段より小さくなる。
const CONVECTION_ADVECTION = 0.1;
// 台風の目。移流の後の湿度をこれだけ下げる。目は渦とともに動く定常の構造なので、風に流さない。
// 眼壁は上昇流が頭打ちに張り付いて飽和しているので、そこを貫く深さが要る。
const TYPHOON_EYE_DRYNESS = 0.55;
// 湿度の底上げ(移流前の源が持つ、平年の雲量を抜きにした値)と、移流後に足す平年の雲量の重み。
// 地表付近と上層で別に持つ。重みは、雲量の地理的な差が凝結のしきい値をまたぐ幅に取る — 小さく
// 取ると砂漠にも海と同じだけ雲が湧き、大きく取ると雲の多い海が覆われたまま動かなくなって、
// 平年の雲量図がそのまま貼り付く。底上げは、重みを変えても平年並みの土地の湿度が動かないように
// 取る(平年の雲量の中央値ぶんを差し引く)。対流は平年の雲量を受けないので底上げだけを持ち、
// 湿度と同じ 0..1 の目盛りに乗る。
const HUMIDITY_BASE = 0.246;
const MEAN_CLOUDINESS_WEIGHT = 0.5;
const UPPER_HUMIDITY_BASE = 0.227;
const UPPER_MEAN_CLOUDINESS_WEIGHT = 0.4;
const CONVECTION_BASE = 0.5;

export class WeatherModel {
  private readonly circulation = new Circulation(SURFACE_BANDS);
  private readonly upperCirculation = new Circulation(UPPER_BANDS);
  private readonly cyclones = new Cyclones(R_EARTH);
  // ノイズは焼く先の texel で標本化できない段を畳むので、写しの持ち方が決まってから組む。
  private readonly pressureNoise: CirculatingNoise;
  private readonly humidityNoise: CirculatingNoise;
  private readonly convectionNoise: CirculatingNoise;
  private readonly upperHumidityNoise: CirculatingNoise;
  private readonly pressure: BakedField;
  private readonly advectionSource: BakedField;
  // 2 位相移流の周期の中の位置 0..1。
  private readonly advectionCycle: FloatUniform = uniform(0);

  // 時刻 0 の天気で始める。climate はこの天体の気候の事前分布、projection は写しの持ち方。
  public constructor(private readonly climate: ClimateMap, projection: FieldProjection) {
    const texel = projection.texelAngle;
    this.pressureNoise = new CirculatingNoise(this.circulation, ...PRESSURE_NOISE, texel);
    this.humidityNoise = new CirculatingNoise(this.circulation, ...HUMIDITY_NOISE, texel);
    this.convectionNoise = new CirculatingNoise(this.circulation, ...CONVECTION_NOISE, texel);
    this.upperHumidityNoise = new CirculatingNoise(this.upperCirculation, ...UPPER_HUMIDITY_NOISE, texel);
    this.pressure = new BakedField(
      'pressure', THREE.RedFormat, projection, (direction) => vec4(this.pressureSourceAt(direction), 0, 0, 1));
    this.advectionSource = new BakedField(
      'advectionSource', THREE.RGBAFormat, projection, (direction) => vec4(this.advectionSourceAt(direction), 1));
    this.syncTime(0);
  }

  // いまの時刻の気圧と、移流前の場を写しへ焼く。syncTime のあと、weatherAt のグラフを描く前に呼ぶ。
  public bake(renderer: WebGPURenderer): void {
    this.pressure.render(renderer);
    this.advectionSource.render(renderer);
  }

  // 時刻 [s] を uniform へ写す。
  public syncTime(seconds: number): void {
    this.circulation.syncTime(seconds);
    this.upperCirculation.syncTime(seconds);
    this.cyclones.syncTime(seconds);
    const cycle = (seconds / ADVECTION_PERIOD) % 1;
    this.advectionCycle.value = cycle < 0 ? cycle + 1 : cycle;
  }

  // 単位方向 direction における天気のグラフ。
  public weatherAt(direction: Vec3Node): WeatherSample {
    const latitude = latitudeOf(direction);
    const east = eastAt(direction);
    const north = northAt(direction);

    // 気圧の写しの 4 点差分から勾配(接ベクトル [hPa/rad])。
    const pressure = this.pressure.at(direction).r;
    const eastStep = east.mul(GRADIENT_STEP);
    const northStep = north.mul(GRADIENT_STEP);
    const pressureEast = this.pressure.at(normalize(direction.add(eastStep))).r;
    const pressureWest = this.pressure.at(normalize(direction.sub(eastStep))).r;
    const pressureNorth = this.pressure.at(normalize(direction.add(northStep))).r;
    const pressureSouth = this.pressure.at(normalize(direction.sub(northStep))).r;
    const gradient = east.mul(pressureEast.sub(pressureWest)).add(north.mul(pressureNorth.sub(pressureSouth)))
      .div(2 * GRADIENT_STEP);

    // 風 = 低い方への流入 + 等圧線に沿う地衡風(コリオリ力の向きは半球で反転)。流入は流れの
    // 曲がりのぶん細る。
    const inflow = gradient.mul(float(-INFLOW_GAIN).div(length(gradient).mul(CURVATURE_GAIN).add(1)));
    const geostrophic = cross(direction, gradient).mul(sin(latitude).mul(GEOSTROPHIC_GAIN));
    const wind = capWind(inflow.add(geostrophic));
    const convectionWind = capWind(inflow.mul(CONVECTION_INFLOW_WEIGHT).add(geostrophic));

    // 上昇流: 風が斜面を駆け上がる分と、気圧の谷が引き上げる分。
    const components = (v: Vec3Node): Vec2Node => vec2(dot(v, east), dot(v, north));
    const terrainLift = dot(components(wind), this.climate.slope(direction)).mul(TERRAIN_LIFT_GAIN);
    const lift = limitLift(terrainLift.add(liftFromPressure(pressure)));

    // 湿度は、風で流した写しへ、その場の平年の雲量と上昇流を足し、台風の目のぶんを引いたもの。
    // 後の 3 つは移流を通らないので、気候と地形と渦に貼り付いたまま歪まない。対流も同じく、
    // わずかに流した写しへ上昇流を足す。
    const advected = this.advected(direction, wind, convectionWind);
    const meanCloudiness = this.climate.meanCloudiness(direction);
    const eye = this.cyclones.typhoonEyeAt(direction).mul(TYPHOON_EYE_DRYNESS);
    const humidity = clamp(
      advected.x.add(meanCloudiness.mul(MEAN_CLOUDINESS_WEIGHT)).add(lift.mul(LIFT_HUMIDITY)).sub(eye), 0, 1);
    const upperHumidity = clamp(
      advected.y.add(meanCloudiness.mul(UPPER_MEAN_CLOUDINESS_WEIGHT)).add(max(lift, 0).mul(UPPER_LIFT_HUMIDITY)),
      0, 1);
    const convection = advected.z.add(max(lift, 0).mul(CONVECTION_LIFT));

    return { pressure, wind: components(wind), lift, humidity, upperHumidity, convection };
  }

  // 写しへ焼く気圧の偏差 [hPa]: 大循環の帯 + ノイズ + 低気圧の谷。読むのは pressure.at()。
  private pressureSourceAt(direction: Vec3Node): FloatNode {
    const band = cos(latitudeOf(direction).mul(6)).mul(-PRESSURE_BAND_AMPLITUDE);
    return band.add(this.pressureNoise.at(direction).mul(PRESSURE_NOISE_AMPLITUDE)).add(this.cyclones.pressureAt(direction));
  }

  // 移流前の場(x が地表付近の湿度、y が上層の湿度、z が対流)。ここへ入れたものが風で流れる。
  // 写しへ焼かれ、advected() が風上へ遡って読む。
  //
  // **平年の雲量はここへ入れない。** 移流の変位は雲を筋に引くのに要る大きさなので、通すと気候の
  // 分布がその変位ぶん歪んで読めなくなる — 慢性的な湿潤・乾燥は場所に貼り付いているべきもので、
  // 流れていくものではない。
  public advectionSourceAt(direction: Vec3Node): Vec3Node {
    return vec3(
      float(HUMIDITY_BASE).add(this.humidityNoise.at(direction).mul(HUMIDITY_NOISE_AMPLITUDE)),
      float(UPPER_HUMIDITY_BASE).add(this.upperHumidityNoise.at(direction).mul(UPPER_HUMIDITY_NOISE_AMPLITUDE)),
      float(CONVECTION_BASE).add(this.convectionNoise.at(direction).mul(CONVECTION_NOISE_AMPLITUDE)),
    );
  }

  // 移流前の写しを風で流したもの(x が地表付近の湿度、y が上層の湿度、z が対流)。周期の半分
  // ずれた 2 位相を三角波で混ぜるので、流れの変位が周期ぶんで頭打ちになり、渦に巻き込まれた模様が
  // 無限に細くならない。湿度と対流は別の風・別の変位で流すので、伸びた先でも 2 枚の向きが揃わない。
  private advected(direction: Vec3Node, wind: Vec3Node, convectionWind: Vec3Node): Vec3Node {
    const phaseA = this.advectionCycle;
    const phaseB = fract(phaseA.add(0.5));
    const weightA = float(1).sub(abs(phaseA.mul(2).sub(1)));
    // 位相 phase(周期に対する比)だけ flow の風上へ遡った点の源。span は変位の倍率。
    const sourceAt = (flow: Vec3Node, phase: FloatNode, span: number): Vec4Node =>
      this.advectionSource.at(normalize(direction.sub(flow.mul(phase.mul((span * ADVECTION_PERIOD) / R_EARTH)))));
    return vec3(
      mix(sourceAt(wind, phaseB, 1).xy, sourceAt(wind, phaseA, 1).xy, weightA),
      mix(
        sourceAt(convectionWind, phaseB, CONVECTION_ADVECTION).z,
        sourceAt(convectionWind, phaseA, CONVECTION_ADVECTION).z, weightA),
    );
  }

  // 保持している GPU 資源を解放する。
  public dispose(): void {
    this.pressure.dispose();
    this.advectionSource.dispose();
  }
}

// 風速を WIND_CAP で頭打ちにする。
function capWind(wind: Vec3Node): Vec3Node {
  return wind.mul(min(float(1), float(WIND_CAP).div(max(length(wind), 1e-3))));
}

// 気圧の偏差 [hPa] が生む上昇流 [m/s]。低気圧で正、高気圧で負。
function liftFromPressure(pressure: FloatNode): FloatNode {
  return exp(pressure.div(-PRESSURE_LIFT_SCALE)).sub(1).mul(PRESSURE_LIFT_GAIN);
}

// 上昇流を LIFT_LIMIT へ漸近させる。LIFT_LIMIT より十分弱い上昇流はほぼ素通しで、強いものだけが丸まる。
function limitLift(lift: FloatNode): FloatNode {
  return tanh(lift.div(LIFT_LIMIT)).mul(LIFT_LIMIT);
}
