// 状態を持たない天気のモデル。天体固定の単位方向と時刻から、気圧 → 風 → 温度・湿度と辿り、
// そこから凝結する雲の場(鉛直光学的厚み・雲頂)を TSL で組む。時刻の閉じた関数なので、
// どの時刻へ飛んでも同じ空が出る。値はすべて見えのための調整値。
import {
  abs, clamp, cos, cross, dot, float, fract, length, max, min, mix, normalize, sin, smoothstep, uniform, vec2,
} from 'three/tsl';
import { R_EARTH } from '../../physics/solar-system';
import { Cyclones } from './cyclones';
import { DriftingNoise } from './drifting-noise';
import { eastAt, latitudeOf, northAt } from './sphere-frame';
import type { ClimateMap } from './climate-map';
import type { FloatNode, FloatUniform, Vec2Node, Vec3Node } from '../tsl-types';

// 単位方向における天気。気圧は平年からの偏差 [hPa]、収束は地表風の収束 [1/s]、温度は [°C]、
// 湿度は 0..1、風は東向き・北向きの成分 [m/s](wind が地表、upperWind が上層)。
export type WeatherSample = {
  readonly pressure: FloatNode;
  readonly convergence: FloatNode;
  readonly wind: Vec2Node;
  readonly upperWind: Vec2Node;
  readonly temperature: FloatNode;
  readonly humidity: FloatNode;
};

// 単位方向における雲。opticalDepth は鉛直光学的厚み(0 で雲なし)、top は雲頂の高さ 0..1。
export type CloudSample = {
  readonly opticalDepth: FloatNode;
  readonly top: FloatNode;
};

const DAY = 86400;

// ノイズの段。段ごとに空間周波数(球面 1 周あたりの山の数)・段数・動きの周期 [s] を変える。
const PRESSURE_NOISE = [1.5, 3, 8 * DAY] as const;
const TEMPERATURE_NOISE = [2, 2, 10 * DAY] as const;
const HUMIDITY_NOISE = [6, 5, 10 * DAY] as const;
const PRESSURE_NOISE_AMPLITUDE = 6;
const TEMPERATURE_NOISE_AMPLITUDE = 8;
const HUMIDITY_NOISE_AMPLITUDE = 0.35;

// 大循環の気圧帯 [hPa]: 赤道と ±60° が低く、±30° と極が高い。
const PRESSURE_BAND_AMPLITUDE = 8;

// 気圧の勾配とラプラシアンを取る中心差分の刻み [rad]。台風の半径(300 km ≈ 0.047 rad)より小さい。
const GRADIENT_STEP = 0.01;
// 風の利得 [m/s あたり hPa/rad]。流入は気圧の低い方へ、地衡風は等圧線に沿って(緯度の正弦に比例)。
const INFLOW_GAIN = 0.02;
const GEOSTROPHIC_GAIN = 0.4;
// 風速の上限 [m/s]。台風の中心近くの勾配で地衡風が発散するのを抑える。
const WIND_CAP = 50;
// 上層の風: 地衡風の倍率と、流入の反転(吹き出し)。
const UPPER_GEOSTROPHIC_FACTOR = 2;

// 湿度の源を風で流す 2 位相移流の周期 [s]。長いほど流れの歪みが溜まり、短いほど位相の混ぜ目が目に付く。
const ADVECTION_PERIOD = 6 * 3600;
// 湿度の底上げと、平均湿度(海 1、陸 0)の重み。
const HUMIDITY_BASE = 0.4;
const MEAN_HUMIDITY_WEIGHT = 0.4;

export class WeatherModel {
  private readonly pressureNoise = new DriftingNoise(...PRESSURE_NOISE);
  private readonly temperatureNoise = new DriftingNoise(...TEMPERATURE_NOISE);
  private readonly humidityNoise = new DriftingNoise(...HUMIDITY_NOISE);
  private readonly cyclones = new Cyclones(R_EARTH);
  // 2 位相移流の周期の中の位置 0..1。
  private readonly advectionCycle: FloatUniform = uniform(0);

  // 時刻 0 の天気で始める。climate はこの天体の気候の事前分布。
  public constructor(private readonly climate: ClimateMap) {
    this.syncTime(0);
  }

  // 時刻 [s] を uniform へ写す。
  public syncTime(seconds: number): void {
    this.pressureNoise.syncTime(seconds);
    this.temperatureNoise.syncTime(seconds);
    this.humidityNoise.syncTime(seconds);
    this.cyclones.syncTime(seconds);
    const cycle = (seconds / ADVECTION_PERIOD) % 1;
    this.advectionCycle.value = cycle < 0 ? cycle + 1 : cycle;
  }

  // 単位方向 direction における天気のグラフ。
  public weatherAt(direction: Vec3Node): WeatherSample {
    const latitude = latitudeOf(direction);
    const east = eastAt(direction);
    const north = northAt(direction);

    // 気圧の 5 点差分から勾配(接ベクトル [hPa/rad])とラプラシアン。
    const pressure = this.pressureAt(direction);
    const eastStep = east.mul(GRADIENT_STEP);
    const northStep = north.mul(GRADIENT_STEP);
    const pressureEast = this.pressureAt(normalize(direction.add(eastStep)));
    const pressureWest = this.pressureAt(normalize(direction.sub(eastStep)));
    const pressureNorth = this.pressureAt(normalize(direction.add(northStep)));
    const pressureSouth = this.pressureAt(normalize(direction.sub(northStep)));
    const gradient = east.mul(pressureEast.sub(pressureWest)).add(north.mul(pressureNorth.sub(pressureSouth)))
      .div(2 * GRADIENT_STEP);
    const laplacian = pressureEast.add(pressureWest).add(pressureNorth).add(pressureSouth).sub(pressure.mul(4))
      .div(GRADIENT_STEP * GRADIENT_STEP);

    // 風 = 低い方への流入 + 等圧線に沿う地衡風(コリオリ力の向きは半球で反転)。
    const inflow = gradient.mul(-INFLOW_GAIN);
    const geostrophic = cross(direction, gradient).mul(sin(latitude).mul(GEOSTROPHIC_GAIN));
    const wind = capWind(inflow.add(geostrophic));
    const upperWind = capWind(geostrophic.mul(UPPER_GEOSTROPHIC_FACTOR).sub(inflow));
    const convergence = laplacian.mul(INFLOW_GAIN / R_EARTH);

    const temperature = this.climate.meanTemperature(direction)
      .add(this.temperatureNoise.at(direction).mul(TEMPERATURE_NOISE_AMPLITUDE));
    const humidity = clamp(
      float(HUMIDITY_BASE).add(this.climate.meanHumidity(direction).mul(MEAN_HUMIDITY_WEIGHT))
        .add(this.advected(this.humidityNoise, direction, wind).mul(HUMIDITY_NOISE_AMPLITUDE)),
      0, 1,
    );

    const components = (v: Vec3Node): Vec2Node => vec2(dot(v, east), dot(v, north));
    return { pressure, convergence, wind: components(wind), upperWind: components(upperWind), temperature, humidity };
  }

  // 天気から凝結する雲。湿度が閾値を超えた分が厚みになり、暖かいほど高く盛り上がる。
  public condense(weather: WeatherSample): CloudSample {
    const opticalDepth = smoothstep(0.55, 0.85, weather.humidity).mul(8);
    const top = smoothstep(0.6, 0.95, weather.humidity).mul(smoothstep(0, 25, weather.temperature));
    return { opticalDepth, top };
  }

  // 気圧の偏差 [hPa]: 大循環の帯 + ノイズ + 低気圧の谷。
  private pressureAt(direction: Vec3Node): FloatNode {
    const band = cos(latitudeOf(direction).mul(6)).mul(-PRESSURE_BAND_AMPLITUDE);
    return band.add(this.pressureNoise.at(direction).mul(PRESSURE_NOISE_AMPLITUDE)).add(this.cyclones.pressureAt(direction));
  }

  // ノイズの段を風で流したもの −1..1。周期の半分ずれた 2 位相を三角波で混ぜるので、流れの変位が
  // 周期ぶんで頭打ちになり、渦に巻き込まれた模様が無限に細くならない。
  private advected(noise: DriftingNoise, direction: Vec3Node, wind: Vec3Node): FloatNode {
    const phaseA = this.advectionCycle;
    const phaseB = fract(phaseA.add(0.5));
    const weightA = float(1).sub(abs(phaseA.mul(2).sub(1)));
    // 位相 phase(周期に対する比)だけ風上へ遡った点の源。
    const sourceAt = (phase: FloatNode): FloatNode =>
      noise.at(normalize(direction.sub(wind.mul(phase.mul(ADVECTION_PERIOD / R_EARTH)))));
    return mix(sourceAt(phaseB), sourceAt(phaseA), weightA);
  }
}

// 風速を WIND_CAP で頭打ちにする。
function capWind(wind: Vec3Node): Vec3Node {
  return wind.mul(min(float(1), float(WIND_CAP).div(max(length(wind), 1e-3))));
}
