// 状態を持たない天気のモデル。天体固定の単位方向と時刻から、気圧 → 風 → 上昇流 → 温度・湿度と
// 辿るグラフを TSL で組む。時刻の閉じた関数なので、どの時刻へ飛んでも同じ空が出る。値はすべて
// 見えのための調整値。
import {
  abs, clamp, cos, cross, dot, float, fract, length, max, min, mix, normalize, sin, tanh, uniform, vec2, vec4,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { R_EARTH } from '../../physics/solar-system';
import { BakedField } from './baked-field';
import { Cyclones } from './cyclones';
import { DriftingNoise } from './drifting-noise';
import { eastAt, latitudeOf, northAt } from './sphere-frame';
import type { ClimateMap } from './climate-map';
import type { FloatNode, FloatUniform, Vec2Node, Vec3Node } from '../tsl-types';

// 単位方向における天気。気圧は平年からの偏差 [hPa]、収束は風の収束 [1/s]、風は東向き・北向きの
// 成分 [m/s]、上昇流は [m/s](地形と収束による、負なら下降)、温度は [°C]、湿度は 0..1
// (humidity が地表付近、upperHumidity が上層)。
export type WeatherSample = {
  readonly pressure: FloatNode;
  readonly convergence: FloatNode;
  readonly wind: Vec2Node;
  readonly lift: FloatNode;
  readonly temperature: FloatNode;
  readonly humidity: FloatNode;
  readonly upperHumidity: FloatNode;
};

const DAY = 86400;

// ノイズの段。段ごとに空間周波数(球面 1 周あたりの山の数)・段数・動きの周期 [s] を変える。
// 気圧と気温は 1 段しか持たない。どちらも総観規模より細かい構造を実際に持たず、気圧はさらに、
// 収束がそのラプラシアンなので、段を増やすとノイズの格子が上昇流と雲へそのまま出る。
const PRESSURE_NOISE = [1.2, 1, 8 * DAY] as const;
const TEMPERATURE_NOISE = [2, 1, 10 * DAY] as const;
// 湿度は基準周波数を低く段を多く取る。基準の角波長(2550 km)が一枚板の雲の広がりを、
// 最上段(160 km)が凝結のしきい値をまたぐ縁の細かさを決める。上層はこれ以上段を減らせない —
// 薄い雲はしきい値で切らずに不透明度へ連続に写すので、上の段が縁ではなく繊維として直に出る。
const HUMIDITY_NOISE = [2.5, 5, 6 * DAY] as const;
const UPPER_HUMIDITY_NOISE = [1.6, 5, 7 * DAY] as const;
const PRESSURE_NOISE_AMPLITUDE = 18;
const TEMPERATURE_NOISE_AMPLITUDE = 12;
const HUMIDITY_NOISE_AMPLITUDE = 0.3;
const UPPER_HUMIDITY_NOISE_AMPLITUDE = 0.35;

// 上昇流: 収束が持ち上げる気柱の厚み [m]。地形の上昇流は風と斜面の内積そのもの。
// 厚みは、低気圧の中心の上昇流が地形の上昇流と同じ桁に収まる高さに置く。ここを厚く取ると
// 低気圧が湿度へ自分で飽和した円盤を書き、流入が巻き込んだ渦をその上から塗り潰してしまう
// — 渦の見えは、収束が書く滑らかな円盤ではなく、流入が既にある雲を縮める分から出る。
const CONVERGENCE_DEPTH = 133;
// 上昇流の頭打ち [m/s]。最も急な斜面へ強い風が当たると上昇流は並の 5 倍以上になり、線形のままだと
// 湿度が 0/1 で切れて、山脈が硬い縁の白い帯になる。漸近させて、並の上昇流はほぼ素通しにする。
const LIFT_LIMIT = 0.06;
// 上昇流の利得。地形の上昇流は風上を冷やし風下(下降)を暖める [°C per m/s]。上昇流は地表付近の
// 湿度へ(下降で乾く)、上向きの分だけが上層の湿度へ効く [per m/s]。
const LIFT_COOLING = 50;
const LIFT_HUMIDITY = 5;
const UPPER_LIFT_HUMIDITY = 3;

// 大循環の気圧帯 [hPa]: 赤道と ±60° が低く、±30° と極が高い。
const PRESSURE_BAND_AMPLITUDE = 8;

// 気圧の勾配とラプラシアンを取る中心差分の刻み [rad]。台風の半径(700 km ≈ 0.11 rad)より小さく、
// 気圧の写しの texel より数倍大きい。
const GRADIENT_STEP = 0.01;
// 風の利得 [m/s あたり hPa/rad]。流入は気圧の低い方へ、地衡風は等圧線に沿って(緯度の正弦に比例)。
// 流入と地衡風の比が、風が等圧線を横切る角(中緯度で 20° 前後)を決める。
const INFLOW_GAIN = 0.15;
const GEOSTROPHIC_GAIN = 0.6;
// 風速の上限 [m/s]。台風の中心近くの勾配で地衡風が発散するのを抑える。
const WIND_CAP = 50;

// 湿度の源を風で流す 2 位相移流の周期 [s]。長いほど流れの歪みが溜まり、短いほど位相の混ぜ目が目に付く。
const ADVECTION_PERIOD = 12 * 3600;
// 台風の目。移流前の湿度をこれだけ下げる。焼いてから流すので、目は流れに沿って中心へ引き込まれて
// 歪み、見えの穴は Cyclones が持つ半径よりずっと小さくなる。
const TYPHOON_EYE_DRYNESS = 0.45;
// 湿度の底上げ(平年の雲量が 0 の土地での値)と、平年の雲量の重み。地表付近と上層で別に持つ。
// 重みは、雲量の地理的な差が凝結のしきい値をまたぐ幅に取る — 小さく取ると砂漠にも海と同じだけ
// 雲が湧き、大きく取ると雲の多い海が覆われたまま動かなくなって、平年の雲量図がそのまま貼り付く。
const HUMIDITY_BASE = 0.349;
const MEAN_CLOUDINESS_WEIGHT = 0.35;
const UPPER_HUMIDITY_BASE = 0.31;
const UPPER_MEAN_CLOUDINESS_WEIGHT = 0.28;

export class WeatherModel {
  private readonly pressureNoise = new DriftingNoise(...PRESSURE_NOISE);
  private readonly temperatureNoise = new DriftingNoise(...TEMPERATURE_NOISE);
  private readonly humidityNoise = new DriftingNoise(...HUMIDITY_NOISE);
  private readonly upperHumidityNoise = new DriftingNoise(...UPPER_HUMIDITY_NOISE);
  private readonly cyclones = new Cyclones(R_EARTH);
  private readonly pressure = new BakedField(
    'pressure', THREE.RedFormat, (direction) => vec4(this.pressureSourceAt(direction), 0, 0, 1));
  private readonly humiditySource = new BakedField(
    'humiditySource', THREE.RGFormat, (direction) => vec4(this.humiditySourceAt(direction), 0, 1));
  // 2 位相移流の周期の中の位置 0..1。
  private readonly advectionCycle: FloatUniform = uniform(0);

  // 時刻 0 の天気で始める。climate はこの天体の気候の事前分布。
  public constructor(private readonly climate: ClimateMap) {
    this.syncTime(0);
  }

  // いまの時刻の気圧と、移流前の湿度を写しへ焼く。syncTime のあと、weatherAt のグラフを描く前に呼ぶ。
  public bake(renderer: WebGPURenderer): void {
    this.pressure.render(renderer);
    this.humiditySource.render(renderer);
  }

  // 時刻 [s] を uniform へ写す。
  public syncTime(seconds: number): void {
    this.pressureNoise.syncTime(seconds);
    this.temperatureNoise.syncTime(seconds);
    this.humidityNoise.syncTime(seconds);
    this.upperHumidityNoise.syncTime(seconds);
    this.cyclones.syncTime(seconds);
    const cycle = (seconds / ADVECTION_PERIOD) % 1;
    this.advectionCycle.value = cycle < 0 ? cycle + 1 : cycle;
  }

  // 単位方向 direction における天気のグラフ。
  public weatherAt(direction: Vec3Node): WeatherSample {
    const latitude = latitudeOf(direction);
    const east = eastAt(direction);
    const north = northAt(direction);

    // 気圧の写しの 5 点差分から勾配(接ベクトル [hPa/rad])とラプラシアン。
    const pressure = this.pressure.at(direction).r;
    const eastStep = east.mul(GRADIENT_STEP);
    const northStep = north.mul(GRADIENT_STEP);
    const pressureEast = this.pressure.at(normalize(direction.add(eastStep))).r;
    const pressureWest = this.pressure.at(normalize(direction.sub(eastStep))).r;
    const pressureNorth = this.pressure.at(normalize(direction.add(northStep))).r;
    const pressureSouth = this.pressure.at(normalize(direction.sub(northStep))).r;
    const gradient = east.mul(pressureEast.sub(pressureWest)).add(north.mul(pressureNorth.sub(pressureSouth)))
      .div(2 * GRADIENT_STEP);
    const laplacian = pressureEast.add(pressureWest).add(pressureNorth).add(pressureSouth).sub(pressure.mul(4))
      .div(GRADIENT_STEP * GRADIENT_STEP);

    // 風 = 低い方への流入 + 等圧線に沿う地衡風(コリオリ力の向きは半球で反転)。
    const inflow = gradient.mul(-INFLOW_GAIN);
    const geostrophic = cross(direction, gradient).mul(sin(latitude).mul(GEOSTROPHIC_GAIN));
    const wind = capWind(inflow.add(geostrophic));
    const convergence = laplacian.mul(INFLOW_GAIN / R_EARTH);

    // 上昇流: 風が斜面を駆け上がる分と、収束が押し上げる分。
    const components = (v: Vec3Node): Vec2Node => vec2(dot(v, east), dot(v, north));
    const terrainLift = dot(components(wind), this.climate.slope(direction));
    const lift = limitLift(terrainLift.add(convergence.mul(CONVERGENCE_DEPTH)));

    // 気候の平均へノイズと上昇流の効果を重ねる。湿度は写しを風で流したものへ上昇流を足す。
    const temperature = this.climate.meanTemperature(direction)
      .add(this.temperatureNoise.at(direction).mul(TEMPERATURE_NOISE_AMPLITUDE))
      .sub(terrainLift.mul(LIFT_COOLING));
    const advected = this.advected(direction, wind);
    const humidity = clamp(advected.x.add(lift.mul(LIFT_HUMIDITY)), 0, 1);
    const upperHumidity = clamp(advected.y.add(max(lift, 0).mul(UPPER_LIFT_HUMIDITY)), 0, 1);

    return {
      pressure, convergence, wind: components(wind),
      lift, temperature, humidity, upperHumidity,
    };
  }

  // 写しへ焼く気圧の偏差 [hPa]: 大循環の帯 + ノイズ + 低気圧の谷。読むのは pressure.at()。
  private pressureSourceAt(direction: Vec3Node): FloatNode {
    const band = cos(latitudeOf(direction).mul(6)).mul(-PRESSURE_BAND_AMPLITUDE);
    return band.add(this.pressureNoise.at(direction).mul(PRESSURE_NOISE_AMPLITUDE)).add(this.cyclones.pressureAt(direction));
  }

  // 移流前の湿度(x が地表付近、y が上層)。平年の雲量も台風の目も、ここへ入れたものがまとめて
  // 風で流れる。写しへ焼かれ、advected() が風上へ遡って読む。
  public humiditySourceAt(direction: Vec3Node): Vec2Node {
    const meanCloudiness = this.climate.meanCloudiness(direction);
    const eye = this.cyclones.typhoonEyeAt(direction).mul(TYPHOON_EYE_DRYNESS);
    return vec2(
      float(HUMIDITY_BASE).add(meanCloudiness.mul(MEAN_CLOUDINESS_WEIGHT))
        .add(this.humidityNoise.at(direction).mul(HUMIDITY_NOISE_AMPLITUDE)).sub(eye),
      float(UPPER_HUMIDITY_BASE).add(meanCloudiness.mul(UPPER_MEAN_CLOUDINESS_WEIGHT))
        .add(this.upperHumidityNoise.at(direction).mul(UPPER_HUMIDITY_NOISE_AMPLITUDE)).sub(eye),
    );
  }

  // 移流前の湿度の写しを風で流したもの(x が地表付近、y が上層)。周期の半分ずれた 2 位相を三角波で
  // 混ぜるので、流れの変位が周期ぶんで頭打ちになり、渦に巻き込まれた模様が無限に細くならない。
  private advected(direction: Vec3Node, wind: Vec3Node): Vec2Node {
    const phaseA = this.advectionCycle;
    const phaseB = fract(phaseA.add(0.5));
    const weightA = float(1).sub(abs(phaseA.mul(2).sub(1)));
    // 位相 phase(周期に対する比)だけ風上へ遡った点の源。
    const sourceAt = (phase: FloatNode): Vec2Node =>
      this.humiditySource.at(normalize(direction.sub(wind.mul(phase.mul(ADVECTION_PERIOD / R_EARTH))))).xy;
    return mix(sourceAt(phaseB), sourceAt(phaseA), weightA);
  }

  // 保持している GPU 資源を解放する。
  public dispose(): void {
    this.pressure.dispose();
    this.humiditySource.dispose();
  }
}

// 風速を WIND_CAP で頭打ちにする。
function capWind(wind: Vec3Node): Vec3Node {
  return wind.mul(min(float(1), float(WIND_CAP).div(max(length(wind), 1e-3))));
}

// 上昇流を LIFT_LIMIT へ漸近させる。LIFT_LIMIT より十分弱い上昇流はほぼ素通しで、強いものだけが丸まる。
function limitLift(lift: FloatNode): FloatNode {
  return tanh(lift.div(LIFT_LIMIT)).mul(LIFT_LIMIT);
}
