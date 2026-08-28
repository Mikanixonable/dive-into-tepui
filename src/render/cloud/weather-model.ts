// 状態を持たない天気のモデル。天体固定の単位方向と時刻から、温度・湿度・風と、そこから凝結する
// 雲の場(鉛直光学的厚み・雲頂)を TSL で組む。時刻の閉じた関数なので、どの時刻へ飛んでも同じ
// 空が出る。値はすべて見えのための調整値。
import * as THREE from 'three/webgpu';
import {
  abs, acos, clamp, cross, dot, exp, float, fract, length, max, min, mix, mx_fractal_noise_float,
  normalize, pow, smoothstep, uniform, vec2,
} from 'three/tsl';
import { R_EARTH } from '../../physics/solar-system';
import { eastAt, latitudeOf, northAt } from './sphere-frame';
import type { ClimateMap } from './climate-map';
import type { FloatNode, FloatUniform, Vec2Node, Vec3Node, Vec3Uniform } from '../tsl-types';

// 単位方向における天気。温度は [°C]、湿度は 0..1、風は東向き・北向きの成分 [m/s]。
export type WeatherSample = {
  readonly temperature: FloatNode;
  readonly humidity: FloatNode;
  readonly wind: Vec2Node;
};

// 単位方向における雲。opticalDepth は鉛直光学的厚み(0 で雲なし)、top は雲頂の高さ 0..1。
export type CloudSample = {
  readonly opticalDepth: FloatNode;
  readonly top: FloatNode;
};

// 湿度の源を風で流す 2 位相移流の周期 [s]。長いほど流れの歪みが溜まり、短いほど位相の混ぜ目が目に付く。
const ADVECTION_PERIOD = 6 * 3600;

// 緯度帯の東西風 [m/s](東向きが正)。貿易風・偏西風・極東風の順に、境目の緯度 [rad] と一緒に持つ。
const TRADE_WIND = -8;
const WESTERLIES = 12;
const POLAR_EASTERLIES = -5;
const TRADE_LIMIT = THREE.MathUtils.degToRad(30);
const WESTERLIES_LIMIT = THREE.MathUtils.degToRad(60);
const BAND_BLEND = THREE.MathUtils.degToRad(6);

// 台風の渦。最大風速 [m/s] とその半径 [m]、外側で風が落ちる距離 [m]、湿った核の半径 [m]、
// 中心の緯度 [rad]、西進の速さ [m/s]。
const VORTEX_MAX_WIND = 45;
const VORTEX_RADIUS = 120e3;
const VORTEX_EXTENT = 1200e3;
const VORTEX_CORE_RADIUS = 500e3;
const VORTEX_LATITUDE = THREE.MathUtils.degToRad(15);
const VORTEX_DRIFT = 5;

// ノイズの空間周波数(球面 1 周あたりの山の数)と段数。
const HUMIDITY_NOISE_FREQUENCY = 6;
const HUMIDITY_NOISE_OCTAVES = 5;
const TEMPERATURE_NOISE_FREQUENCY = 2;
const TEMPERATURE_NOISE_OCTAVES = 3;

// 平均湿度(海 1、陸 0)が湿度に効く重み。残りはノイズの取り分。
const MEAN_HUMIDITY_WEIGHT = 0.4;

export class WeatherModel {
  // 2 位相移流の周期の中の位置 0..1。
  private readonly advectionCycle: FloatUniform = uniform(0);
  // 台風の中心の単位方向。
  private readonly vortexCenter: Vec3Uniform = uniform(new THREE.Vector3());

  // 時刻 0 の天気で始める。climate はこの天体の気候の事前分布。
  public constructor(private readonly climate: ClimateMap) {
    this.syncTime(0);
  }

  // 時刻 [s] を uniform へ写す。周期で畳んでから渡すので、大きな時刻でも精度が落ちない。
  public syncTime(seconds: number): void {
    const cycle = (seconds / ADVECTION_PERIOD) % 1;
    this.advectionCycle.value = cycle < 0 ? cycle + 1 : cycle;
    const longitude = -(VORTEX_DRIFT / (R_EARTH * Math.cos(VORTEX_LATITUDE))) * seconds;
    this.vortexCenter.value.set(
      Math.cos(VORTEX_LATITUDE) * Math.sin(longitude),
      Math.sin(VORTEX_LATITUDE),
      Math.cos(VORTEX_LATITUDE) * Math.cos(longitude),
    );
  }

  // 単位方向 direction における天気のグラフ。
  public weatherAt(direction: Vec3Node): WeatherSample {
    const latitude = latitudeOf(direction);
    const east = eastAt(direction);
    const north = northAt(direction);
    const wind: Vec3Node = east.mul(this.zonalWind(latitude)).add(this.vortexWind(direction));

    const temperature = this.climate.meanTemperature(direction)
      .add(mx_fractal_noise_float(direction.mul(TEMPERATURE_NOISE_FREQUENCY), TEMPERATURE_NOISE_OCTAVES).mul(8));
    // 海陸の平均湿度へ、風で流した源と台風の湿った核を重ねる。
    const vortexCore = exp(this.vortexDistance(direction).div(VORTEX_CORE_RADIUS).pow(2).negate()).mul(0.3);
    const humidity = clamp(
      float(0.4).add(this.climate.meanHumidity(direction).mul(MEAN_HUMIDITY_WEIGHT))
        .add(this.advectedSource(direction, wind).mul(0.35)).add(vortexCore),
      0, 1,
    );

    return { temperature, humidity, wind: vec2(dot(wind, east), dot(wind, north)) };
  }

  // 天気から凝結する雲。湿度が閾値を超えた分が厚みになり、暖かいほど高く盛り上がる。
  public condense(weather: WeatherSample): CloudSample {
    const opticalDepth = smoothstep(0.55, 0.85, weather.humidity).mul(8);
    const top = smoothstep(0.6, 0.95, weather.humidity).mul(smoothstep(0, 25, weather.temperature));
    return { opticalDepth, top };
  }

  // 緯度帯の東西風 [m/s]。帯の境目は BAND_BLEND の幅で滑らかに繋ぐ。
  private zonalWind(latitude: FloatNode): FloatNode {
    const lat = abs(latitude);
    const trades = mix(float(TRADE_WIND), float(WESTERLIES), smoothstep(-BAND_BLEND, BAND_BLEND, lat.sub(TRADE_LIMIT)));
    return mix(trades, float(POLAR_EASTERLIES), smoothstep(-BAND_BLEND, BAND_BLEND, lat.sub(WESTERLIES_LIMIT)));
  }

  // 台風の中心からの地表距離 [m]。
  private vortexDistance(direction: Vec3Node): FloatNode {
    return acos(clamp(dot(this.vortexCenter, direction), -1, 1)).mul(R_EARTH);
  }

  // 台風の渦の風 [m/s]。中心のまわりを反時計回り(北半球の低気圧)に回り、VORTEX_RADIUS で最大、
  // その外は距離の −0.6 乗で緩く落ちて VORTEX_EXTENT で消える。
  private vortexWind(direction: Vec3Node): Vec3Node {
    const tangent = cross(this.vortexCenter, direction);
    const tangentDir = tangent.div(max(length(tangent), 1e-6));
    const distance = this.vortexDistance(direction);
    const x = distance.div(VORTEX_RADIUS);
    const profile = min(x, pow(max(x, 1e-3), -0.6)).mul(exp(distance.div(VORTEX_EXTENT).pow(2).negate()));
    return tangentDir.mul(profile.mul(VORTEX_MAX_WIND));
  }

  // 湿度の源(ノイズ)を風で流したもの −1..1。周期の半分ずれた 2 位相を三角波で混ぜるので、
  // 流れの変位が周期ぶんで頭打ちになり、渦に巻き込まれた模様が無限に細くならない。
  private advectedSource(direction: Vec3Node, wind: Vec3Node): FloatNode {
    const phaseA = this.advectionCycle;
    const phaseB = fract(phaseA.add(0.5));
    const weightA = float(1).sub(abs(phaseA.mul(2).sub(1)));
    // 位相 phase(周期に対する比)だけ風上へ遡った点の源。
    const sourceAt = (phase: FloatNode): FloatNode => {
      const traced = normalize(direction.sub(wind.mul(phase.mul(ADVECTION_PERIOD / R_EARTH))));
      return mx_fractal_noise_float(traced.mul(HUMIDITY_NOISE_FREQUENCY), HUMIDITY_NOISE_OCTAVES);
    };
    return mix(sourceAt(phaseB), sourceAt(phaseA), weightA);
  }
}
