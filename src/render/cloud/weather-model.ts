// 状態を持たない天気のモデル。天体固定の単位方向と時刻から、気圧 → 風 → 上昇流 → 温度・湿度と
// 辿り、そこから凝結する雲(高度スラブごとの不透明雲と、薄い雲)を TSL で組む。時刻の閉じた関数
// なので、どの時刻へ飛んでも同じ空が出る。値はすべて見えのための調整値。
import {
  abs, clamp, cos, cross, dot, float, fract, length, max, min, mix, normalize, sin, smoothstep, uniform, vec2,
} from 'three/tsl';
import { R_EARTH } from '../../physics/solar-system';
import { Cyclones } from './cyclones';
import { DriftingNoise } from './drifting-noise';
import { eastAt, latitudeOf, northAt } from './sphere-frame';
import type { ClimateMap } from './climate-map';
import type { FloatNode, FloatUniform, Vec2Node, Vec3Node } from '../tsl-types';

// 単位方向における天気。気圧は平年からの偏差 [hPa]、収束は地表風の収束 [1/s]、風は東向き・北向きの
// 成分 [m/s](wind が地表、upperWind が上層)、上昇流は [m/s](地形と収束による、負なら下降)、
// 温度は [°C]、湿度は 0..1(humidity が地表付近、upperHumidity が上層)。
export type WeatherSample = {
  readonly pressure: FloatNode;
  readonly convergence: FloatNode;
  readonly wind: Vec2Node;
  readonly upperWind: Vec2Node;
  readonly lift: FloatNode;
  readonly temperature: FloatNode;
  readonly humidity: FloatNode;
  readonly upperHumidity: FloatNode;
};

// 不透明雲の高度スラブ。スラブ k は高度 [SLAB_BASE + k·SLAB_THICKNESS, +SLAB_THICKNESS) [m] を占め、
// SLAB_COUNT 枚で対流圏を覆う。
export const SLAB_COUNT = 8;
export const SLAB_BASE = 500;
export const SLAB_THICKNESS = 1500;

// 単位方向における雲。slabs はスラブごとの不透明雲の光学的厚み(SLAB_COUNT 個、0 で雲なし)、
// translucent は薄く透ける雲の光学的厚み。両者は独立に分布する。
export type CloudSample = {
  readonly slabs: readonly FloatNode[];
  readonly translucent: FloatNode;
};

const DAY = 86400;

// ノイズの段。段ごとに空間周波数(球面 1 周あたりの山の数)・段数・動きの周期 [s] を変える。
const PRESSURE_NOISE = [1.5, 3, 8 * DAY] as const;
const TEMPERATURE_NOISE = [2, 2, 10 * DAY] as const;
const HUMIDITY_NOISE = [6, 5, 10 * DAY] as const;
const UPPER_HUMIDITY_NOISE = [3, 4, 7 * DAY] as const;
const PRESSURE_NOISE_AMPLITUDE = 6;
const TEMPERATURE_NOISE_AMPLITUDE = 8;
const HUMIDITY_NOISE_AMPLITUDE = 0.35;
const UPPER_HUMIDITY_NOISE_AMPLITUDE = 0.35;

// 上昇流: 収束が持ち上げる気柱の厚み [m]。地形の上昇流は風と斜面の内積そのもの。
const CONVERGENCE_DEPTH = 3000;
// 上昇流の利得。地形の上昇流は風上を冷やし風下(下降)を暖める [°C per m/s]。上昇流は地表付近の
// 湿度へ(下降で乾く)、上向きの分だけが上層の湿度へ効く [per m/s]。
const LIFT_COOLING = 50;
const LIFT_HUMIDITY = 5;
const UPPER_LIFT_HUMIDITY = 3;

// 凝結。地表付近の湿度が COVERAGE_ONSET から COVERAGE_FULL の間で雲量 0..1 になり、雲底は
// 乾いているほど高く(持ち上げ凝結高度 [m/湿度不足])、層の厚みは層雲の厚み [m] に、暖かさ
// [m/°C] と上昇流 [m per m/s] で伸びる対流の分を足す。スラブ 1 枚を満たす雲の光学的厚みが TAU_PER_SLAB。
const COVERAGE_ONSET = 0.6;
const COVERAGE_FULL = 0.85;
const CONDENSATION_LEVEL_PER_DRYNESS = 2500;
const CLOUD_BASE_MIN = 300;
const STRATUS_DEPTH = 800;
const CONVECTION_ONSET = 15;
const CONVECTION_DEPTH_PER_DEGREE = 600;
const LIFT_DEPTH = 20000;
const TAU_PER_SLAB = 8;
// 中層雲: 上層湿度が MID_COVERAGE_ONSET..MID_COVERAGE_FULL で雲量になり、高度 MID_BASE..MID_TOP [m] を占める。
const MID_COVERAGE_ONSET = 0.55;
const MID_COVERAGE_FULL = 0.8;
const MID_BASE = 4000;
const MID_TOP = 7000;
const MID_TAU = 4;
// 薄い雲: 上層湿度のベール(光学的厚み THIN_TAU まで)と、対流の雲頂が ANVIL_ONSET..ANVIL_FULL [m] へ
// 届いたときのかなとこ(ANVIL_TAU まで)。
const THIN_ONSET = 0.45;
const THIN_FULL = 0.75;
const THIN_TAU = 0.8;
const ANVIL_ONSET = 9000;
const ANVIL_FULL = 12000;
const ANVIL_TAU = 0.6;

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
// 湿度の底上げと、平均湿度(海 1、陸 0)の重み。地表付近と上層で別に持つ。
const HUMIDITY_BASE = 0.35;
const MEAN_HUMIDITY_WEIGHT = 0.3;
const UPPER_HUMIDITY_BASE = 0.3;
const UPPER_MEAN_HUMIDITY_WEIGHT = 0.2;

export class WeatherModel {
  private readonly pressureNoise = new DriftingNoise(...PRESSURE_NOISE);
  private readonly temperatureNoise = new DriftingNoise(...TEMPERATURE_NOISE);
  private readonly humidityNoise = new DriftingNoise(...HUMIDITY_NOISE);
  private readonly upperHumidityNoise = new DriftingNoise(...UPPER_HUMIDITY_NOISE);
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

    // 上昇流: 風が斜面を駆け上がる分と、収束が押し上げる分。
    const components = (v: Vec3Node): Vec2Node => vec2(dot(v, east), dot(v, north));
    const terrainLift = dot(components(wind), this.climate.slope(direction));
    const lift = terrainLift.add(convergence.mul(CONVERGENCE_DEPTH));

    // 気候の平均へノイズと上昇流の効果を重ねる。湿度の源は風で流す。
    const temperature = this.climate.meanTemperature(direction)
      .add(this.temperatureNoise.at(direction).mul(TEMPERATURE_NOISE_AMPLITUDE))
      .sub(terrainLift.mul(LIFT_COOLING));
    const meanHumidity = this.climate.meanHumidity(direction);
    const humidity = clamp(
      float(HUMIDITY_BASE).add(meanHumidity.mul(MEAN_HUMIDITY_WEIGHT))
        .add(this.advected(this.humidityNoise, direction, wind).mul(HUMIDITY_NOISE_AMPLITUDE))
        .add(lift.mul(LIFT_HUMIDITY)),
      0, 1,
    );
    const upperHumidity = clamp(
      float(UPPER_HUMIDITY_BASE).add(meanHumidity.mul(UPPER_MEAN_HUMIDITY_WEIGHT))
        .add(this.advected(this.upperHumidityNoise, direction, upperWind).mul(UPPER_HUMIDITY_NOISE_AMPLITUDE))
        .add(max(lift, 0).mul(UPPER_LIFT_HUMIDITY)),
      0, 1,
    );

    return {
      pressure, convergence, wind: components(wind), upperWind: components(upperWind),
      lift, temperature, humidity, upperHumidity,
    };
  }

  // 天気から凝結する雲。地表付近の湿度が雲底から雲頂までの対流雲・層雲に、上層の湿度が中層雲と
  // 薄いベールになり、雲頂が高く届いた対流雲はかなとこの薄い雲を広げる。
  public condense(weather: WeatherSample): CloudSample {
    const coverage = smoothstep(COVERAGE_ONSET, COVERAGE_FULL, weather.humidity);
    const base = max(float(1).sub(weather.humidity).mul(CONDENSATION_LEVEL_PER_DRYNESS), CLOUD_BASE_MIN);
    const depth = float(STRATUS_DEPTH)
      .add(max(weather.temperature.sub(CONVECTION_ONSET), 0).mul(CONVECTION_DEPTH_PER_DEGREE).mul(coverage))
      .add(max(weather.lift, 0).mul(LIFT_DEPTH));
    const top = base.add(depth);
    const midCoverage = smoothstep(MID_COVERAGE_ONSET, MID_COVERAGE_FULL, weather.upperHumidity);

    // スラブごとに、雲の層と重なる割合を光学的厚みにする。
    const overlap = (k: number, layerBase: FloatNode, layerTop: FloatNode): FloatNode => {
      const slabBase = SLAB_BASE + k * SLAB_THICKNESS;
      const covered = min(layerTop, slabBase + SLAB_THICKNESS).sub(max(layerBase, slabBase));
      return clamp(covered.div(SLAB_THICKNESS), 0, 1);
    };
    const slabs = Array.from({ length: SLAB_COUNT }, (_, k) =>
      overlap(k, base, top).mul(coverage).mul(TAU_PER_SLAB)
        .add(overlap(k, float(MID_BASE), float(MID_TOP)).mul(midCoverage).mul(MID_TAU)));

    const translucent = smoothstep(THIN_ONSET, THIN_FULL, weather.upperHumidity).mul(THIN_TAU)
      .add(smoothstep(ANVIL_ONSET, ANVIL_FULL, top).mul(ANVIL_TAU));
    return { slabs, translucent };
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
