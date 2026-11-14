// 気象モデルから凝結した雲テクスチャ(2 枚・時刻の違う組)と、雲を運ぶ風・環境の写し。ベイク時と
// サンプリング時の 4基底割り当てを一括管理し、出入りをどちらも CloudSample で受け渡す。
import * as THREE from 'three/webgpu';
import { normalize, uniform } from 'three/tsl';
import { BakedField } from '../baked-field';
import { GPU_PASS } from '../gpu-timings';
import { condense } from './condensation';
import {
  blendBakedTexels, cloudEnvironmentTexel, cloudFieldTexelFromSample, cloudMotionTexel, cloudSampleFromTexels,
  type CloudBlend, type CloudFieldSlot, type CloudMotion, type CloudSample,
} from './cloud-field-sample';
import { eastAt, northAt } from './sphere-frame';
import type { WebGPURenderer } from 'three/webgpu';
import type { GpuTimingSink } from '../gpu-timings';
import type { FieldProjection } from '../field-projection';
import type { WeatherModel } from './weather-model';
import type { FloatUniform, Vec2Node, Vec3Node, Vec4Node } from '../tsl-types';

export class CloudField {
  // 枚ごとの雲・風・環境の写し。どの枚も同じ投影へ、同じ時刻の天気から焼く。
  private readonly clouds: readonly [BakedField, BakedField];
  private readonly motions: readonly [BakedField, BakedField];
  private readonly environments: readonly [BakedField, BakedField];
  // 読み手に渡す 2 枚の組。枚の中身は焼くたびに入れ替わる。
  public readonly slots: readonly [CloudFieldSlot, CloudFieldSlot];
  // 2 枚の混ぜ方。setBlend で書き、読み手は同じ値を参照する。
  private readonly blendValue: CloudBlend = { parity: 0, fraction: 0 };
  private readonly parity: FloatUniform = uniform(0);
  private readonly fraction: FloatUniform = uniform(0);

  // model の現在時刻における雲を、指定された projection に従ってベイクするテクスチャ。サンプリング時も projection の uv を参照する。
  public constructor(model: WeatherModel, projection: FieldProjection) {
    const cloudTexelAt = (direction: Vec3Node) => cloudFieldTexelFromSample(condense(model.weatherAt(direction)));
    const motionTexelAt = (direction: Vec3Node) => cloudMotionTexel(smoothedWindsAt(model, direction));
    const environmentTexelAt = (direction: Vec3Node) => cloudEnvironmentTexel(condense(model.weatherAt(direction)));
    const bake = (name: string, source: (direction: Vec3Node) => Vec4Node) =>
      new BakedField(name, THREE.RGBAFormat, projection, source, GPU_PASS.cloudBake);
    this.clouds = [bake('cloudA', cloudTexelAt), bake('cloudB', cloudTexelAt)];
    this.motions = [bake('cloudMotionA', motionTexelAt), bake('cloudMotionB', motionTexelAt)];
    this.environments = [bake('cloudEnvironmentA', environmentTexelAt), bake('cloudEnvironmentB', environmentTexelAt)];
    this.slots = [
      { cloud: this.clouds[0].texture, motion: this.motions[0].texture, environment: this.environments[0].texture },
      { cloud: this.clouds[1].texture, motion: this.motions[1].texture, environment: this.environments[1].texture },
    ];
  }

  // 2 枚の混ぜ方。読み手はこの値を読んだ時点の混ぜ方で雲を読む。
  public get blend(): CloudBlend { return this.blendValue; }

  // 混ぜ方を置く。parity は古い側の枚の番号、fraction は古い側から新しい側への混合比。
  public setBlend(parity: 0 | 1, fraction: number): void {
    this.blendValue.parity = parity;
    this.blendValue.fraction = fraction;
    this.parity.value = parity;
    this.fraction.value = fraction;
  }

  // 現在時刻の雲・風・環境を枚 slot へレンダリングする。at() でサンプリングする前に、その枚を焼いておく。
  public renderSlot(slot: 0 | 1, renderer: WebGPURenderer, gpu?: GpuTimingSink): void {
    this.clouds[slot].render(renderer, gpu);
    this.motions[slot].render(renderer, gpu);
    this.environments[slot].render(renderer, gpu);
  }

  // 単位方向 direction での雲を、投影自身の uv で直接サンプリングする。cap による領域切り出しを行わないため、テクスチャ
  // 全域を参照できる。
  public at(direction: Vec3Node): CloudSample {
    const cloud = blendBakedTexels(
      this.clouds[0].at(direction), this.clouds[1].at(direction), this.parity, this.fraction);
    const environment = blendBakedTexels(
      this.environments[0].at(direction), this.environments[1].at(direction), this.parity, this.fraction);
    return cloudSampleFromTexels(cloud, environment);
  }

  // 保持している GPU 資源を解放する。
  public dispose(): void {
    for (const field of [...this.clouds, ...this.motions, ...this.environments]) field.dispose();
  }
}

// 雲の細部を運ぶ風を均す半径 [rad]。中心と東西南北へこれだけ離した 5 点の平均を取る。細部は数百キロの
// 流れに乗ればよく、気圧の写しの texel ごとに揺れる局所の風で運ぶと、周期のあいだに戻す距離が場所ごとに
// ねじれて模様が渦巻く。200 km 相当。
const WIND_SMOOTHING_ANGLE = 200e3 / 6.371e6;

// 単位方向 direction のまわり数百キロで均した、雲を運ぶ風。
function smoothedWindsAt(model: WeatherModel, direction: Vec3Node): CloudMotion {
  // 中心と東西南北の 5 点で風を読み、成分ごとに平均する。
  const east = eastAt(direction).mul(WIND_SMOOTHING_ANGLE);
  const north = northAt(direction).mul(WIND_SMOOTHING_ANGLE);
  const points = [
    direction, normalize(direction.add(east)), normalize(direction.sub(east)),
    normalize(direction.add(north)), normalize(direction.sub(north)),
  ];
  const winds = points.map((point) => model.windsAt(point));
  const average = (pick: (motion: CloudMotion) => Vec2Node): Vec2Node =>
    winds.map(pick).reduce((sum, wind) => sum.add(wind)).div(points.length);
  return {
    surfaceWind: average((motion) => motion.surfaceWind),
    upperWind: average((motion) => motion.upperWind),
  };
}
