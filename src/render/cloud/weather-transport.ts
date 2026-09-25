// 湿度・対流の源を表示時刻の写しへ焼き、有限時間だけ風上へ遡って読む。元の写し自体が
// Circulation の絶対時刻で連続移動するため、表示時刻を周期で折り返さずに伸長と変形を加える。
import * as THREE from 'three/webgpu';
import { abs, float, inverseSqrt, mix, normalize, vec2, vec4 } from 'three/tsl';
import { advectSphericalPositionUnitVector } from '../../physics/cloud-spherical-transport';
import { cross, len, norm, rotateAxis, scale, v3 } from '../../math/vec3';
import type { Vec3 } from '../../math/vec3';
import { BakedField } from '../baked-field';
import { GPU_PASS } from '../gpu-timings';
import { CirculatingNoise } from './circulating-noise';
import type { Circulation } from './circulation';
import { windStep } from './wind-law';
import type { WebGPURenderer } from 'three/webgpu';
import type { GpuTimingSink } from '../gpu-timings';
import type { NoiseOctave } from './circulating-noise';
import type { FieldProjection } from '../field-projection';
import type { BalancedWind } from './wind-law';
import type { FloatNode, Vec2Node, Vec3Node, Vec4Node } from '../tsl-types';

export interface CloudParcelWind {
  readonly tangentVelocityMPerS: Vec3;
  readonly verticalVelocityMPerS: number;
}

export type CloudParcelWindAt = (
  directionUnitVector: Vec3,
  geometricHeightM: number,
  timeS: number,
) => CloudParcelWind;

export interface CloudParcelPosition {
  readonly directionUnitVector: Vec3;
  readonly geometricHeightM: number;
  readonly steps: number;
}

const CLOUD_PARCEL_MAX_STEPS = 1_000_000;

function requireFiniteTransportValue(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function requirePositiveTransportValue(value: number, name: string): void {
  requireFiniteTransportValue(value, name);
  if (value <= 0) throw new RangeError(`${name} must be positive`);
}

function sampleParcelWind(
  windAt: CloudParcelWindAt,
  directionUnitVector: Vec3,
  geometricHeightM: number,
  timeS: number,
): CloudParcelWind {
  const wind = windAt(directionUnitVector, geometricHeightM, timeS);
  requireFiniteTransportValue(wind.tangentVelocityMPerS.x, 'tangentVelocityMPerS.x');
  requireFiniteTransportValue(wind.tangentVelocityMPerS.y, 'tangentVelocityMPerS.y');
  requireFiniteTransportValue(wind.tangentVelocityMPerS.z, 'tangentVelocityMPerS.z');
  requireFiniteTransportValue(wind.verticalVelocityMPerS, 'verticalVelocityMPerS');
  return wind;
}

// 風を吹いていく向きとして読み、局所接平面上の速度を時間中点で評価する RK2 で雲を再構成する。
// 球面上の各移動には解析大円stepを用い、中点の接線風は大円に沿う平行移動で開始点へ戻してから
// 1 step 進める。高度は幾何高度[m]、時刻とstepは[s]。決定性はwindAtが純関数であることを前提とする。
// 適用限界: 風が1 step内で急変する場合はmaxStepSを小さくする。有限step上限を超える入力は拒否する。
export function reconstructCloudParcel(
  startDirectionUnitVector: Vec3,
  startGeometricHeightM: number,
  sphereRadiusM: number,
  startTimeS: number,
  endTimeS: number,
  maxStepS: number,
  windAt: CloudParcelWindAt,
): CloudParcelPosition {
  requireFiniteTransportValue(startDirectionUnitVector.x, 'startDirectionUnitVector.x');
  requireFiniteTransportValue(startDirectionUnitVector.y, 'startDirectionUnitVector.y');
  requireFiniteTransportValue(startDirectionUnitVector.z, 'startDirectionUnitVector.z');
  requireFiniteTransportValue(startGeometricHeightM, 'startGeometricHeightM');
  requirePositiveTransportValue(sphereRadiusM, 'sphereRadiusM');
  requireFiniteTransportValue(startTimeS, 'startTimeS');
  requireFiniteTransportValue(endTimeS, 'endTimeS');
  requirePositiveTransportValue(maxStepS, 'maxStepS');
  if (typeof windAt !== 'function') throw new TypeError('windAt must be a function');
  const elapsedTimeS = endTimeS - startTimeS;
  requireFiniteTransportValue(elapsedTimeS, 'endTimeS - startTimeS');
  const stepCount = Math.ceil(Math.abs(elapsedTimeS) / maxStepS);
  if (stepCount > CLOUD_PARCEL_MAX_STEPS) {
    throw new RangeError(`transport requires more than ${CLOUD_PARCEL_MAX_STEPS} steps`);
  }
  const initialRadiusM = sphereRadiusM + startGeometricHeightM;
  if (!Number.isFinite(initialRadiusM) || initialRadiusM <= 0) {
    throw new RangeError('sphereRadiusM + startGeometricHeightM must be positive and finite');
  }
  const initialDirection = advectSphericalPositionUnitVector(
    startDirectionUnitVector, v3(0, 0, 0), sphereRadiusM, 0,
  );
  if (stepCount === 0) {
    return { directionUnitVector: initialDirection, geometricHeightM: startGeometricHeightM, steps: 0 };
  }

  const stepTimeS = elapsedTimeS / stepCount;
  let directionUnitVector = initialDirection;
  let geometricHeightM = startGeometricHeightM;
  for (let stepIndex = 0; stepIndex < stepCount; stepIndex += 1) {
    const timeS = startTimeS + stepTimeS * stepIndex;
    const midpointTimeS = timeS + stepTimeS / 2;
    const startRadiusM = sphereRadiusM + geometricHeightM;
    if (startRadiusM <= 0) throw new RangeError('sphereRadiusM + geometricHeightM must be positive');
    const startWind = sampleParcelWind(windAt, directionUnitVector, geometricHeightM, timeS);
    const startSpeedMPerS = len(startWind.tangentVelocityMPerS);
    const midpointHeightM = geometricHeightM + startWind.verticalVelocityMPerS * stepTimeS / 2;
    const midpointRadiusM = sphereRadiusM + midpointHeightM;
    if (!Number.isFinite(midpointHeightM) || !Number.isFinite(midpointRadiusM) || midpointRadiusM <= 0) {
      throw new RangeError('midpoint sphere radius must be positive and finite');
    }
    const halfAngleRad = startSpeedMPerS * stepTimeS / (2 * startRadiusM);
    requireFiniteTransportValue(halfAngleRad, 'midpoint angular displacement');
    const initialTangentDirection = startSpeedMPerS === 0
      ? v3(0, 0, 0)
      : scale(startWind.tangentVelocityMPerS, 1 / startSpeedMPerS);
    const rotationAxis = startSpeedMPerS === 0
      ? v3(0, 0, 0)
      : norm(cross(directionUnitVector, initialTangentDirection));
    const midpointDirectionUnitVector = advectSphericalPositionUnitVector(
      directionUnitVector,
      startWind.tangentVelocityMPerS,
      startRadiusM,
      stepTimeS / 2,
    );
    const midpointWind = sampleParcelWind(
      windAt, midpointDirectionUnitVector, midpointHeightM, midpointTimeS,
    );
    const midpointWindAtStart = startSpeedMPerS === 0
      ? midpointWind.tangentVelocityMPerS
      : rotateAxis(midpointWind.tangentVelocityMPerS, rotationAxis, -halfAngleRad);
    directionUnitVector = advectSphericalPositionUnitVector(
      directionUnitVector,
      midpointWindAtStart,
      midpointRadiusM,
      stepTimeS,
    );
    geometricHeightM += midpointWind.verticalVelocityMPerS * stepTimeS;
    requireFiniteTransportValue(geometricHeightM, 'geometricHeightM');
    const updatedRadiusM = sphereRadiusM + geometricHeightM;
    if (!Number.isFinite(updatedRadiusM) || updatedRadiusM <= 0) {
      throw new RangeError('updated sphere radius must be positive and finite');
    }
  }
  return { directionUnitVector, geometricHeightM, steps: stepCount };
}

// 地表付近は湿度と対流の2枚で周波数を分担する。湿度の基準の段(800 km)が雲塊の配置を、
// 中間の段(400〜100 km)が雲塊を100〜300 kmの塊へ割る境目を、対流(48 kmと24 km)が積雲の
// 粒の細かさを決める。薄い雲は地表付近の雲塊と同じ規模まで濃淡を下ろし、細かい段は雲塊を
// 割る厚い雲へ譲る。
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

// 源場から遡る有限時間 [s]。絶対時刻を周期で折り返さず、現在時刻の場からこの範囲だけ
// 風上へ標本化する。上層ほど長い窓を取り、氷雲の繊維を長く引き伸ばす。
const SURFACE_BACKTRACE_SECONDS = 8 * 3600;
const CONVECTION_BACKTRACE_SECONDS = 10 * 3600;
const UPPER_BACKTRACE_SECONDS = 14 * 3600;
const NEAR_TRACE_FRACTION = 0.35;
// 対流の1歩が渦のまわりを巻く角の上限 [rad]。強く巻く渦の中だけ歩幅を縮める。
const CONVECTION_WINDING = 2.5;

// 移流後の場。地表付近と上層の湿度は0..1、対流は0中心の高周波(xが粒、yが網目)。
export interface AdvectedFields {
  readonly surfaceHumidity: FloatNode;
  readonly upperHumidity: FloatNode;
  readonly convection: Vec2Node;
}

export class WeatherTransport {
  private readonly surfaceHumidityNoise: CirculatingNoise;
  private readonly convectionNoise: CirculatingNoise;
  private readonly upperHumidityNoise: CirculatingNoise;
  private readonly humiditySource: BakedField;
  private readonly convectionSource: BakedField;

  // 地表付近と上層の循環が流すノイズから、projection の持ち方で源の写しを組む。surfaceRadius は
  // 湿度と対流を運ぶ天体の半径 [m]。
  public constructor(
    surfaceCirculation: Circulation, upperCirculation: Circulation, projection: FieldProjection,
    private readonly surfaceRadius: number,
  ) {
    const texel = projection.texelAngle;
    this.surfaceHumidityNoise = new CirculatingNoise(surfaceCirculation, SURFACE_HUMIDITY_NOISE, texel);
    this.convectionNoise = new CirculatingNoise(surfaceCirculation, CONVECTION_NOISE, texel);
    this.upperHumidityNoise = new CirculatingNoise(upperCirculation, UPPER_HUMIDITY_NOISE, texel);
    this.humiditySource = new BakedField(
      'humiditySource', THREE.RGFormat, projection,
      (direction) => vec4(this.humiditySourceAt(direction), 0, 1),
      GPU_PASS.cloudBake);
    this.convectionSource = new BakedField(
      'convectionSource', THREE.RGFormat, projection,
      (direction) => vec4(this.convectionSourceAt(direction), 0, 1),
      GPU_PASS.cloudBake);
  }

  // 移流前の場をテクスチャへレンダリングする。advectedAt() と surfaceHumidityAt() のグラフを描く前に呼ぶ。
  public bake(renderer: WebGPURenderer, gpu?: GpuTimingSink): void {
    this.humiditySource.render(renderer, gpu);
    this.convectionSource.render(renderer, gpu);
  }

  // 移流前の湿度(xが地表付近、yが上層)。
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

  // レンダリング済み湿度テクスチャにおける地表成分のサンプリング値（移流前）。
  public surfaceHumidityAt(direction: Vec3Node): FloatNode {
    return this.humiditySource.at(direction).r;
  }

  // 現在時刻の源場を有限の風上窓で2点標本化して伸長する。時刻を周期で折り返さないため、
  // 20時間ごとの同時リセットは起きない。窓を有限にすることで強い渦でも無限に細線化しない。
  public advectedAt(
    direction: Vec3Node, surfaceWind: BalancedWind, upperWind: BalancedWind, convectionWind: BalancedWind,
  ): AdvectedFields {
    const sourceAt = (source: BakedField, flow: BalancedWind, seconds: FloatNode): Vec4Node =>
      source.at(normalize(direction.add(windStep(flow, direction, seconds).div(this.surfaceRadius))));
    const surfaceFar = float(-SURFACE_BACKTRACE_SECONDS);
    const surfaceNear = surfaceFar.mul(NEAR_TRACE_FRACTION);
    const upperFar = float(-UPPER_BACKTRACE_SECONDS);
    const upperNear = upperFar.mul(NEAR_TRACE_FRACTION);
    // 強く巻く渦では、対流の風上窓だけを短くして過剰な細線化を防ぐ。
    const winding = abs(convectionWind.turn).mul(CONVECTION_BACKTRACE_SECONDS / CONVECTION_WINDING);
    const convectionScale = inverseSqrt(winding.mul(winding).add(1));
    const convectionFar = convectionScale.mul(-CONVECTION_BACKTRACE_SECONDS);
    const convectionNear = convectionFar.mul(NEAR_TRACE_FRACTION);
    return {
      surfaceHumidity: mix(
        sourceAt(this.humiditySource, surfaceWind, surfaceNear).x,
        sourceAt(this.humiditySource, surfaceWind, surfaceFar).x, 0.5),
      upperHumidity: mix(
        sourceAt(this.humiditySource, upperWind, upperNear).y,
        sourceAt(this.humiditySource, upperWind, upperFar).y, 0.5),
      convection: mix(
        sourceAt(this.convectionSource, convectionWind, convectionNear).rg,
        sourceAt(this.convectionSource, convectionWind, convectionFar).rg, 0.5),
    };
  }

  // 保持しているGPU資源を解放する。
  public dispose(): void {
    this.humiditySource.dispose();
    this.convectionSource.dispose();
  }
}
