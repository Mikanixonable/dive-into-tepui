// 状態を持たない天気のモデル。天体固定の単位方向と時刻から、気圧 → 風 → 上昇流 → 湿度・対流と
// 辿るグラフを TSL で組む。時刻の閉じた関数なので、どの時刻へ飛んでも同じ空が出る。値はすべて
// 見えのための調整値。
import {
  abs, clamp, cos, dot, exp, float, fract, inverseSqrt, max, mix, normalize, smoothstep, tanh, uniform,
  vec2, vec4,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { R_EARTH } from '../../game/celestial/solar-system/constants';
import { BakedField } from './baked-field';
import { CirculatingNoise, coarsenessFor } from './circulating-noise';
import { Circulation, SURFACE_BANDS, UPPER_BANDS } from './circulation';
import { ConvectiveActivity } from './convective-activity';
import { Cyclones } from './cyclones';
import { eastAt, latitudeOf, northAt } from './sphere-frame';
import { FRICTION_RATE, balancedWind, isobarAt, windStep } from './wind-law';
import type { ClimateMap } from './climate-map';
import type { FieldProjection } from './field-projection';
import type { BalancedWind } from './wind-law';
import type { FloatNode, FloatUniform, Vec2Node, Vec3Node, Vec4Node } from '../tsl-types';

// 単位方向における天気。気圧は平年からの偏差 [hPa]、風は東向き・北向きの成分 [m/s]、
// 上昇流は [m/s](地形と気圧による、負なら下降)、湿度は 0..1(humidity が地表付近、
// upperHumidity が上層)、対流は対流セルの強弱(0 中心の高周波)、対流の活発度はその強弱が
// どれだけ強く現れるか 0..1、金床は平らな天蓋の濃さ 0..1、圏界面はその緯度の対流の天井 [m]。
export type WeatherSample = {
  readonly pressure: FloatNode;
  readonly wind: Vec2Node;
  readonly lift: FloatNode;
  readonly humidity: FloatNode;
  readonly upperHumidity: FloatNode;
  readonly convection: FloatNode;
  readonly convectiveActivity: FloatNode;
  readonly anvil: FloatNode;
  readonly tropopause: FloatNode;
};

// 風で流したあとの場。地表付近と上層の湿度は 0..1、対流は 0 中心の高周波。
type AdvectedFields = {
  readonly humidity: FloatNode;
  readonly upperHumidity: FloatNode;
  readonly convection: FloatNode;
};

// **仮設**: 末尾が _KNOB の定数は、cloud-lab のつまみ(tools/cloud-lab/tuning-knobs.ts)から
// 動かせるよう uniform にしてある。生成の場を実写へ寄せる追い込みが終わるまでは畳まない。

// ノイズの段。段ごとに空間周波数(1 rad あたりの山の数)と段数を変える。
// 気圧は 1 段しか持たない。総観規模より細かい構造を実際に持たないうえ、上昇流が気圧そのものの
// 関数なので、段を増やすとノイズの格子が雲へそのまま出る。
const PRESSURE_NOISE = [1.2, 1] as const;
// 地表付近は湿度と対流の 2 枚で周波数を分担する。湿度の基準の角波長(800 km)が雲塊の配置を、
// 対流(80 km と 40 km の 2 段)が積雲の粒の細かさを決める。**対流が載るかどうかは写しの texel が
// 決める** — 40 km/texel より粗い写しでは 2 段とも落ちて湿度だけの滑らかな塊になり、10 km/texel
// まで寄れば 2 段とも乗る。上層はこれ以上段を減らせない — 薄い雲は光学的厚みが 1 に届かず下地が透けるので、
// 細かい段が縁ではなく繊維の濃淡として直に見える。
const HUMIDITY_NOISE = [8, 4] as const;
const CONVECTION_NOISE = [80, 2] as const;
const UPPER_HUMIDITY_NOISE = [6, 4] as const;
const PRESSURE_NOISE_AMPLITUDE = 18;
const HUMIDITY_NOISE_AMPLITUDE = 0.5625;
export const CONVECTION_NOISE_AMPLITUDE_KNOB: FloatUniform = uniform(0.30);
const UPPER_HUMIDITY_NOISE_AMPLITUDE = 0.65625;

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
export const TERRAIN_LIFT_GAIN_KNOB: FloatUniform = uniform(0.35);
// 上昇流の利得。上昇流は地表付近の湿度へ(下降で乾く)、上向きの分だけが上層の湿度へ効く
// [per m/s]。
export const LIFT_HUMIDITY_KNOB: FloatUniform = uniform(2.2);
export const UPPER_LIFT_HUMIDITY_KNOB: FloatUniform = uniform(0.7);

// 圏界面の高さ [m] とその緯度依存。熱帯で 16〜17 km、極で 9 km 前後で、亜熱帯のジェットの下で
// 段をなして下がる(NCAR ACOM「Cloud Tops and Tropopause」)。深い対流はここに当たって横へ広がる
// ので、対流の天井そのものになる。
const TROPOPAUSE_EQUATOR = 17000;
const TROPOPAUSE_POLE = 9000;
const TROPOPAUSE_STEP_START = THREE.MathUtils.degToRad(15);
const TROPOPAUSE_STEP_END = THREE.MathUtils.degToRad(60);

// 大循環の気圧帯 [hPa]: 赤道と ±60° が低く、±30° と極が高い。
export const PRESSURE_BAND_AMPLITUDE_KNOB: FloatUniform = uniform(8);

// 大循環の帯の角速度 [°/日] を、この天体の表面での速さ [m/s] へ直す係数。
const BAND_RATE_TO_SPEED = (THREE.MathUtils.degToRad(1) / 86400) * R_EARTH;

// 気圧の勾配を取る中心差分の刻み [rad]。台風の芯の広がり(250 km ≈ 0.039 rad)より細かく、
// 気圧の写しの texel(全球で 6.1e-3 rad)より粗い。
const GRADIENT_STEP = 0.01;
// 等圧線方向の 2 階微分を取る刻み [rad]。写しは半精度で、2 階差分に乗る量子化の雑音は刻みの二乗で
// 効く。勾配と同じ刻みで取ると、帯とノイズだけの平らな所で曲がりが雑音に埋もれる。
const BEND_STEP = 0.02;
// 対流を流す風の摩擦 [1/s]。湿度を流す風より強く取ると、等圧線を深く横切って 20〜30° 違う向きへ
// 伸びる。同じ風で流すと 2 枚が同じ向きへ伸びて、掛け合わせても筋のままになる。
const CONVECTION_FRICTION = 3 * FRICTION_RATE;

// 移流の源を風で流す 2 位相移流の周期 [s]。長いほど流れの歪みが溜まり、短いほど位相の混ぜ目が目に付く。
// **背景の雲がどれだけ伸びるかを決めるのはここ。** 伸びは 1 歩のあいだに風が空間で変わる量から出る
// ので、風そのものを速くしても増えず、歩を長く取ったぶんだけ増える。
const ADVECTION_PERIOD = 20 * 3600;
// 対流を流す 1 歩を、湿度の 1 歩の何倍の長さに取るか。1 周期の変位が写しに載る粒(80〜40 km)より
// 大きいと、粒は流れの向きへ伸びる。
const CONVECTION_ADVECTION = 1.3;
// 上層の湿度の 1 歩を、地表付近の 1 歩の何倍に取るか。巻雲の繊維は、同じ風の場でも地表付近の
// 雲より長く引き伸ばされる。
const UPPER_ADVECTION = 2.0;
// 対流の 1 歩が渦のまわりを巻く角の上限 [rad]。台風の芯では流れが 3 周ぶん巻き、半径ごとに違う角だけ
// 捻れた粒が髪のような筋へ潰れる。1 歩をここへ漸近するまで縮めると、縮むのは芯から 600 km の内側だけで、
// 巻きの浅い背景(0.9 rad)は 6% しか変わらない。
const CONVECTION_WINDING = 2.5;
// 渦の目。移流の後の湿度をこれだけ下げる。目は渦とともに動く定常の構造なので、風に流さない。
// 眼壁は上昇流が頭打ちに張り付いて飽和しているので、そこを貫く深さが要る。上層を深く引くのは、
// 薄い雲の穴を厚い雲の目よりひとまわり広く開けるため。
const EYE_DRYNESS = 0.55;
const UPPER_EYE_DRYNESS = 2;
// 湿度の底上げ(移流前の源が持つ、平年の雲量を抜きにした値)と、移流後に足す平年の雲量の重み。
// 地表付近と上層で別に持つ。重みは、雲量の地理的な差が凝結のしきい値をまたぐ幅に取る — 小さく
// 取ると砂漠にも海と同じだけ雲が湧き、大きく取ると雲の多い海が覆われたまま動かなくなって、
// 平年の雲量図がそのまま貼り付く。底上げは、重みを変えても平年並みの土地の湿度が動かないように
// 取る(平年の雲量の中央値ぶんを差し引く)。
export const HUMIDITY_BASE_KNOB: FloatUniform = uniform(0.424);
export const MEAN_CLOUDINESS_WEIGHT_KNOB: FloatUniform = uniform(0.17);
export const UPPER_HUMIDITY_BASE_KNOB: FloatUniform = uniform(0.400);
export const UPPER_MEAN_CLOUDINESS_WEIGHT_KNOB: FloatUniform = uniform(0.15);

export class WeatherModel {
  private readonly circulation = new Circulation(SURFACE_BANDS);
  private readonly upperCirculation = new Circulation(UPPER_BANDS);
  private readonly cyclones = new Cyclones();
  // ノイズは焼く先の texel で標本化できない段を畳むので、写しの持ち方が決まってから組む。
  private readonly pressureNoise: CirculatingNoise;
  private readonly humidityNoise: CirculatingNoise;
  private readonly convectionNoise: CirculatingNoise;
  private readonly upperHumidityNoise: CirculatingNoise;
  private readonly pressure: BakedField;
  private readonly humiditySource: BakedField;
  private readonly convectionSource: BakedField;
  private readonly convectiveActivity: ConvectiveActivity;
  // 2 位相移流の周期の中の位置 0..1。
  private readonly advectionCycle: FloatUniform = uniform(0);

  // 時刻 0 の天気で始める。climate はこの天体の気候の事前分布、projection は写しの持ち方。
  public constructor(private readonly climate: ClimateMap, projection: FieldProjection) {
    const texel = projection.texelAngle;
    // 湿度は雲塊の配置しか持たないので投影より粗くて足りることがあり、同じ細かさを要る対流とは
    // 写しを分ける。
    const humidityCoarseness = coarsenessFor(projection, HUMIDITY_NOISE, UPPER_HUMIDITY_NOISE);
    const convectionCoarseness = coarsenessFor(projection, CONVECTION_NOISE);
    const humidityTexel = texel.mul(humidityCoarseness);
    const convectionTexel = texel.mul(convectionCoarseness);
    this.pressureNoise = new CirculatingNoise(this.circulation, ...PRESSURE_NOISE, texel, 'smooth');
    this.humidityNoise = new CirculatingNoise(this.circulation, ...HUMIDITY_NOISE, humidityTexel, 'smooth');
    // 積雲の粒は細胞の網目なので、対流だけ段の形を変える。
    this.convectionNoise = new CirculatingNoise(
      this.circulation, ...CONVECTION_NOISE, convectionTexel, 'cellular');
    this.upperHumidityNoise = new CirculatingNoise(
      this.upperCirculation, ...UPPER_HUMIDITY_NOISE, humidityTexel, 'smooth');
    // 気圧の写しだけは段ではなく、読む側の中心差分の刻み(GRADIENT_STEP)が細かさを決める。
    this.pressure = new BakedField(
      'pressure', THREE.RedFormat, projection, 1, (direction) => vec4(this.pressureSourceAt(direction), 0, 0, 1));
    this.humiditySource = new BakedField(
      'humiditySource', THREE.RGFormat, projection, humidityCoarseness,
      (direction) => vec4(this.humiditySourceAt(direction), 0, 1));
    this.convectionSource = new BakedField(
      'convectionSource', THREE.RedFormat, projection, convectionCoarseness,
      (direction) => vec4(this.convectionSourceAt(direction), 0, 0, 1));
    this.convectiveActivity = new ConvectiveActivity(this.circulation, projection);
    this.syncTime(0);
  }

  // いまの時刻の気圧と、移流前の場を写しへ焼く。syncTime のあと、weatherAt のグラフを描く前に呼ぶ。
  public bake(renderer: WebGPURenderer): void {
    this.pressure.render(renderer);
    this.humiditySource.render(renderer);
    this.convectionSource.render(renderer);
    this.convectiveActivity.bake(renderer);
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

    // 気圧の写しの 4 点差分から勾配(接ベクトル [hPa/rad])、等圧線方向の 2 点差分からその向きの
    // 2 階微分 [hPa/rad²]。
    const pressure = this.pressure.at(direction).r;
    const eastStep = east.mul(GRADIENT_STEP);
    const northStep = north.mul(GRADIENT_STEP);
    const pressureEast = this.pressure.at(normalize(direction.add(eastStep))).r;
    const pressureWest = this.pressure.at(normalize(direction.sub(eastStep))).r;
    const pressureNorth = this.pressure.at(normalize(direction.add(northStep))).r;
    const pressureSouth = this.pressure.at(normalize(direction.sub(northStep))).r;
    const gradient = east.mul(pressureEast.sub(pressureWest)).add(north.mul(pressureNorth.sub(pressureSouth)))
      .div(2 * GRADIENT_STEP);
    const isobar = isobarAt(direction, gradient);
    const isobarStep = isobar.mul(BEND_STEP);
    const pressureAhead = this.pressure.at(normalize(direction.add(isobarStep))).r;
    const pressureBehind = this.pressure.at(normalize(direction.sub(isobarStep))).r;
    const bend = pressureAhead.add(pressureBehind).sub(pressure.mul(2)).div(BEND_STEP ** 2);

    // 湿度と対流は、摩擦の違う 2 本の風で流す。上層の湿度はそこへ上層の帯の平均風を足した風で流す
    // — 巻雲の繊維はジェットに沿って伸びるので、地表付近の風で流すと向きが揃わない。
    const wind = balancedWind(gradient, isobar, bend, latitude, FRICTION_RATE);
    const convectionWind = balancedWind(gradient, isobar, bend, latitude, CONVECTION_FRICTION);
    const upperMean = this.upperCirculation.meanWindAt(direction);
    const upperWind: BalancedWind = {
      velocity: wind.velocity
        .add(east.mul(upperMean.x.mul(cos(latitude)).mul(BAND_RATE_TO_SPEED)))
        .add(north.mul(upperMean.y.mul(BAND_RATE_TO_SPEED))),
      turn: wind.turn,
    };

    // 上昇流: 風が斜面を駆け上がる分と、気圧の谷が引き上げる分。
    const components = (v: Vec3Node): Vec2Node => vec2(dot(v, east), dot(v, north));
    const terrainLift = dot(components(wind.velocity), this.climate.slope(direction)).mul(TERRAIN_LIFT_GAIN_KNOB);
    const lift = limitLift(terrainLift.add(liftFromPressure(pressure)));

    // 湿度は、風で流した写しへ、その場の平年の雲量と上昇流を足し、渦の目のぶんを引いたもの。
    // 後の 3 つは移流を通らないので、気候と地形と渦に貼り付いたまま歪まない。
    const advected = this.advected(direction, wind, upperWind, convectionWind);
    const meanCloudiness = this.climate.meanCloudiness(direction);
    const eye = this.cyclones.eyeAt(direction);
    const humidity = clamp(
      advected.humidity.add(meanCloudiness.mul(MEAN_CLOUDINESS_WEIGHT_KNOB)).add(lift.mul(LIFT_HUMIDITY_KNOB))
        .sub(eye.mul(EYE_DRYNESS)), 0, 1);
    const upperHumidity = clamp(
      advected.upperHumidity.add(meanCloudiness.mul(UPPER_MEAN_CLOUDINESS_WEIGHT_KNOB))
        .add(max(lift, 0).mul(UPPER_LIFT_HUMIDITY_KNOB)).sub(eye.mul(UPPER_EYE_DRYNESS)), 0, 1);

    return {
      pressure,
      wind: components(wind.velocity),
      lift,
      humidity,
      upperHumidity,
      convection: advected.convection,
      convectiveActivity: this.convectiveActivity.at(direction, lift),
      anvil: this.cyclones.anvilAt(direction),
      tropopause: tropopauseAt(latitude),
    };
  }

  // 気圧の偏差 [hPa]: 大循環の帯 + ノイズ + 低気圧の谷。
  private pressureSourceAt(direction: Vec3Node): FloatNode {
    const band = cos(latitudeOf(direction).mul(6)).mul(PRESSURE_BAND_AMPLITUDE_KNOB.negate());
    return band.add(this.pressureNoise.at(direction).mul(PRESSURE_NOISE_AMPLITUDE))
      .add(this.cyclones.pressureAt(direction));
  }

  // 移流前の湿度(x が地表付近、y が上層)。ここへ入れたものが風で流れる。
  //
  // **平年の雲量はここへ入れない。** 移流の変位は雲を筋に引くのに要る大きさなので、通すと気候の
  // 分布がその変位ぶん歪んで読めなくなる — 慢性的な湿潤・乾燥は場所に貼り付いているべきもので、
  // 流れていくものではない。
  public humiditySourceAt(direction: Vec3Node): Vec2Node {
    return vec2(
      HUMIDITY_BASE_KNOB.add(this.humidityNoise.at(direction).mul(HUMIDITY_NOISE_AMPLITUDE)),
      UPPER_HUMIDITY_BASE_KNOB.add(this.upperHumidityNoise.at(direction).mul(UPPER_HUMIDITY_NOISE_AMPLITUDE)),
    );
  }

  // 単位方向 direction における大循環の平均風(東向き・北向きの成分 [m/s])。
  public meanWindAt(direction: Vec3Node): Vec2Node {
    // 東西は緯線に沿って進むので、同じ角速度でも高緯度ほど遅い。
    const mean = this.circulation.meanWindAt(direction);
    return vec2(mean.x.mul(cos(latitudeOf(direction))), mean.y).mul(BAND_RATE_TO_SPEED);
  }

  // 移流前の対流の強弱(0 中心の高周波)。湿度と別の写しへ焼き、別の風で流す。
  public convectionSourceAt(direction: Vec3Node): FloatNode {
    return this.convectionNoise.at(direction).mul(CONVECTION_NOISE_AMPLITUDE_KNOB);
  }

  // 移流前の写しを風で流したもの。周期の半分ずれた 2 位相を三角波で混ぜるので、流れの変位が
  // 周期ぶんで頭打ちになり、渦に巻き込まれた模様が無限に細くならない。地表付近の湿度・上層の湿度・
  // 対流は向きも速さも違う風で流すので、伸びた先でも 3 枚の向きが揃わない。
  private advected(
    direction: Vec3Node, wind: BalancedWind, upperWind: BalancedWind, convectionWind: BalancedWind,
  ): AdvectedFields {
    const phaseA = this.advectionCycle;
    const phaseB = fract(phaseA.add(0.5));
    const weightA = float(1).sub(abs(phaseA.mul(2).sub(1)));
    // seconds 秒だけ flow に流された点の source。負に取れば風上へ遡る。
    const sourceAt = (source: BakedField, flow: BalancedWind, seconds: FloatNode): Vec4Node =>
      source.at(normalize(direction.add(windStep(flow, direction, seconds).div(R_EARTH))));
    // 遡る秒数 [s](負)。位相が周期の終わりへ近づくほど遠くまで遡る。
    const stepA = phaseA.mul(-ADVECTION_PERIOD);
    const stepB = phaseB.mul(-ADVECTION_PERIOD);
    // 対流の 1 歩の倍率。巻きが CONVECTION_WINDING を超える渦の中だけ縮み、超えない所では
    // CONVECTION_ADVECTION 倍のまま。
    const winding = abs(convectionWind.turn).mul(ADVECTION_PERIOD * CONVECTION_ADVECTION / CONVECTION_WINDING);
    const convectionStep = inverseSqrt(winding.mul(winding).add(1)).mul(CONVECTION_ADVECTION);
    const humidity = this.humiditySource;
    const convection = this.convectionSource;
    return {
      humidity: mix(sourceAt(humidity, wind, stepB).x, sourceAt(humidity, wind, stepA).x, weightA),
      upperHumidity: mix(
        sourceAt(humidity, upperWind, stepB.mul(UPPER_ADVECTION)).y,
        sourceAt(humidity, upperWind, stepA.mul(UPPER_ADVECTION)).y, weightA),
      convection: mix(
        sourceAt(convection, convectionWind, stepB.mul(convectionStep)).r,
        sourceAt(convection, convectionWind, stepA.mul(convectionStep)).r, weightA),
    };
  }

  // 保持している GPU 資源を解放する。
  public dispose(): void {
    this.pressure.dispose();
    this.humiditySource.dispose();
    this.convectionSource.dispose();
    this.convectiveActivity.dispose();
  }
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
