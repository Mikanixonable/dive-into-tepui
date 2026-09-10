// 湿度・対流の源を写しへ焼き、天気の風で風上へ遡って読む。湿度の地表成分と上層成分、対流を
// 別々の風で運ぶが、すべて同じ2位相移流の規則と写しの寿命で管理する。
import * as THREE from 'three/webgpu';
import { abs, float, fract, inverseSqrt, mix, normalize, uniform, vec2, vec4 } from 'three/tsl';
import { R_EARTH } from '../../game/celestial/solar-system/constants';
import { BakedField } from './baked-field';
import { CirculatingNoise, coarsenessFor } from './circulating-noise';
import { Circulation } from './circulation';
import { windStep } from './wind-law';
import type { WebGPURenderer } from 'three/webgpu';
import type { GpuTimingSink } from '../gpu-timings';
import type { NoiseOctave } from './circulating-noise';
import type { FieldProjection } from './field-projection';
import type { BalancedWind } from './wind-law';
import type { FloatNode, FloatUniform, Vec2Node, Vec3Node, Vec4Node } from '../tsl-types';

// 地表付近は湿度と対流の2枚で周波数を分担する。湿度の基準の段(800 km)が雲塊の配置を、
// 中間の段(400〜100 km)が雲塊を100〜300 kmの塊へ割る境目を、対流(48 kmと24 km)が雲群の
// 活動と列の包絡を決める。積雲セルの4〜12 km級のサイズ分散は雲場の表面形状側で加える。
const SURFACE_HUMIDITY_NOISE: readonly NoiseOctave[] = [
  { frequency: 2, amplitude: 0.4 }, // 3200 km
  { frequency: 8, amplitude: 0.8 }, // 800 km
  { frequency: 16, amplitude: 1.5 }, // 400 km
  { frequency: 32, amplitude: 1.35 }, // 200 km
  { frequency: 64, amplitude: 1.0 }, // 100 km
];
const CONVECTION_NOISE: readonly NoiseOctave[] = [
  { frequency: 133, amplitude: 1 }, // 48 km
  { frequency: 266, amplitude: 0.65 }, // 24 km
];
const UPPER_HUMIDITY_NOISE: readonly NoiseOctave[] = [
  { frequency: 3.75, amplitude: 0.45 }, // 1700 km
  { frequency: 8, amplitude: 0.7 }, // 800 km
  { frequency: 16, amplitude: 0.28 }, // 400 km
  { frequency: 32, amplitude: 0.18 }, // 200 km
  { frequency: 64, amplitude: 0.23 }, // 100 km
];

// 場の振れ幅。CirculatingNoiseが段の振幅の総和で割って返すので、段数を変えてもここは動かない。
export const SURFACE_HUMIDITY_BASE = 0.405;
const UPPER_HUMIDITY_BASE = 0.42;
const SURFACE_HUMIDITY_NOISE_AMPLITUDE = 0.5625;
const CONVECTION_NOISE_AMPLITUDE = 0.30;
const UPPER_HUMIDITY_NOISE_AMPLITUDE = 0.65625;

// 移流の源を風で流す2位相移流の周期 [s]。長いほど流れの歪みが溜まり、短いほど位相の混ぜ目が
// 目に付く。背景の雲がどれだけ伸びるかは、1歩のあいだに風が空間で変わる量から決まる。
const ADVECTION_PERIOD = 20 * 3600;
// 対流を流す1歩を、湿度の1歩の何倍の長さに取るか。
const CONVECTION_ADVECTION = 1.3;
// 上層の湿度の1歩を、地表付近の1歩の何倍の長さに取るか。巻雲の繊維を長く引き伸ばす。
const UPPER_ADVECTION = 1.6;
// 対流の1歩が渦のまわりを巻く角の上限 [rad]。強く巻く渦の中だけ歩幅を縮める。
const CONVECTION_WINDING = 2.5;

// 移流後の場。地表付近と上層の湿度は0..1、対流は0中心の高周波(xが粒、yが網目)。
export type AdvectedFields = {
  readonly surfaceHumidity: FloatNode;
  readonly upperHumidity: FloatNode;
  readonly convection: Vec2Node;
};

export class WeatherTransport {
  private readonly surfaceHumidityNoise: CirculatingNoise;
  private readonly convectionNoise: CirculatingNoise;
  private readonly upperHumidityNoise: CirculatingNoise;
  private readonly humiditySource: BakedField;
  private readonly convectionSource: BakedField;
  // 2位相移流の周期の中の位置0..1。
  private readonly advectionCycle: FloatUniform = uniform(0);

  public constructor(
    surfaceCirculation: Circulation, upperCirculation: Circulation, projection: FieldProjection,
  ) {
    // 湿度は雲塊の配置しか持たないので投影より粗くて足りることがあり、同じ細かさを要る対流とは
    // 写しを分ける。
    const humidityCoarseness = coarsenessFor(projection, SURFACE_HUMIDITY_NOISE, UPPER_HUMIDITY_NOISE);
    const convectionCoarseness = coarsenessFor(projection, CONVECTION_NOISE);
    const humidityTexel = projection.texelAngle.mul(humidityCoarseness);
    const convectionTexel = projection.texelAngle.mul(convectionCoarseness);
    this.surfaceHumidityNoise = new CirculatingNoise(
      surfaceCirculation, SURFACE_HUMIDITY_NOISE, humidityTexel);
    this.convectionNoise = new CirculatingNoise(surfaceCirculation, CONVECTION_NOISE, convectionTexel);
    this.upperHumidityNoise = new CirculatingNoise(
      upperCirculation, UPPER_HUMIDITY_NOISE, humidityTexel);
    this.humiditySource = new BakedField(
      'humiditySource', THREE.RGFormat, projection, humidityCoarseness,
      (direction) => vec4(this.humiditySourceAt(direction), 0, 1));
    this.convectionSource = new BakedField(
      'convectionSource', THREE.RGFormat, projection, convectionCoarseness,
      (direction) => vec4(this.convectionSourceAt(direction), 0, 1));
  }

  // 時刻[s]を移流位相へ写す。
  public syncTime(seconds: number): void {
    const cycle = (seconds / ADVECTION_PERIOD) % 1;
    this.advectionCycle.value = cycle < 0 ? cycle + 1 : cycle;
  }

  // 移流前の場を写しへ描く。sourceAt()で読む前に必ず一度呼ぶ。
  public bake(renderer: WebGPURenderer, gpu?: GpuTimingSink): void {
    this.humiditySource.render(renderer, gpu);
    this.convectionSource.render(renderer, gpu);
  }

  // 移流前の湿度(xが地表付近、yが上層)。平年の雲量はここへ入れず、場所に貼り付いた気候として
  // WeatherModelが移流後へ加える。
  public humiditySourceAt(direction: Vec3Node): Vec2Node {
    return vec2(
      float(SURFACE_HUMIDITY_BASE).add(this.surfaceHumidityNoise.at(direction).mul(SURFACE_HUMIDITY_NOISE_AMPLITUDE)),
      float(UPPER_HUMIDITY_BASE).add(this.upperHumidityNoise.at(direction).mul(UPPER_HUMIDITY_NOISE_AMPLITUDE)),
    );
  }

  // 移流前の対流の強弱(xが粒、yが網目)。同じ勾配ノイズから出るので1回の評価で両方が積める。
  public convectionSourceAt(direction: Vec3Node): Vec2Node {
    return this.convectionNoise.pairAt(direction).mul(CONVECTION_NOISE_AMPLITUDE);
  }

  // 湿度写しの地表成分の標本。前線へ渡す水平勾配を求めるため、焼いた場から読む。
  public surfaceHumidityAt(direction: Vec3Node): FloatNode {
    return this.humiditySource.at(direction).r;
  }

  // 移流前の写しを風で流したもの。周期の半分ずれた2位相を三角波で混ぜるので、流れの変位が
  // 周期ぶんで頭打ちになり、渦に巻き込まれた模様が無限に細くならない。
  public advectedAt(
    direction: Vec3Node, surfaceWind: BalancedWind, upperWind: BalancedWind, convectionWind: BalancedWind,
  ): AdvectedFields {
    const phaseA = this.advectionCycle;
    const phaseB = fract(phaseA.add(0.5));
    const weightA = float(1).sub(abs(phaseA.mul(2).sub(1)));
    // seconds秒だけflowに流された点のsource。負に取れば風上へ遡る。
    const sourceAt = (source: BakedField, flow: BalancedWind, seconds: FloatNode): Vec4Node =>
      source.at(normalize(direction.add(windStep(flow, direction, seconds).div(R_EARTH))));
    // 遡る秒数[s](負)。位相が周期の終わりへ近づくほど遠くまで遡る。
    const stepA = phaseA.mul(-ADVECTION_PERIOD);
    const stepB = phaseB.mul(-ADVECTION_PERIOD);
    // 対流の1歩の倍率。巻きがCONVECTION_WINDINGを超える渦の中だけ縮む。
    const winding = abs(convectionWind.turn).mul(ADVECTION_PERIOD * CONVECTION_ADVECTION / CONVECTION_WINDING);
    const convectionStep = inverseSqrt(winding.mul(winding).add(1)).mul(CONVECTION_ADVECTION);
    return {
      surfaceHumidity: mix(
        sourceAt(this.humiditySource, surfaceWind, stepB).x,
        sourceAt(this.humiditySource, surfaceWind, stepA).x, weightA),
      upperHumidity: mix(
        sourceAt(this.humiditySource, upperWind, stepB.mul(UPPER_ADVECTION)).y,
        sourceAt(this.humiditySource, upperWind, stepA.mul(UPPER_ADVECTION)).y, weightA),
      convection: mix(
        sourceAt(this.convectionSource, convectionWind, stepB.mul(convectionStep)).rg,
        sourceAt(this.convectionSource, convectionWind, stepA.mul(convectionStep)).rg, weightA),
    };
  }

  // 保持しているGPU資源を解放する。
  public dispose(): void {
    this.humiditySource.dispose();
    this.convectionSource.dispose();
  }
}
