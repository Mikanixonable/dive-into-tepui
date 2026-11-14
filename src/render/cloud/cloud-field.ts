// 気象モデルから凝結した雲テクスチャ（ベイクドフィールド）と、雲を運ぶ風の写し。ベイク時とサンプリング時の
// 4基底割り当てを一括管理し、出入りをどちらも CloudSample で受け渡す。
import * as THREE from 'three/webgpu';
import { normalize } from 'three/tsl';
import { BakedField } from '../baked-field';
import { GPU_PASS } from '../gpu-timings';
import { condense } from './condensation';
import {
  cloudFieldTexelFromSample, cloudMotionTexel, cloudSampleFromTexel, type CloudMotion, type CloudSample,
} from './cloud-field-sample';
import { eastAt, northAt } from './sphere-frame';
import type { WebGPURenderer } from 'three/webgpu';
import type { GpuTimingSink } from '../gpu-timings';
import type { FieldProjection } from '../field-projection';
import type { WeatherModel } from './weather-model';
import type { Vec2Node, Vec3Node } from '../tsl-types';

export class CloudField {
  private readonly field: BakedField;
  // 雲を運ぶ風の写し。
  private readonly motion: BakedField;

  // model の現在時刻における雲を、指定された projection に従ってベイクするテクスチャ。サンプリング時も projection の uv を参照する。
  public constructor(model: WeatherModel, projection: FieldProjection) {
    this.field = new BakedField('cloud', THREE.RGBAFormat, projection, (direction) => {
      const cloud = condense(model.weatherAt(direction));
      return cloudFieldTexelFromSample(cloud);
    }, GPU_PASS.cloudBake);
    this.motion = new BakedField(
      'cloudMotion', THREE.RGBAFormat, projection,
      (direction) => cloudMotionTexel(smoothedWindsAt(model, direction)), GPU_PASS.cloudBake);
  }

  // 現在時刻の雲をベイクドテクスチャへレンダリングする。at() でサンプリングする前に必ず一度呼び出す。
  public render(renderer: WebGPURenderer, gpu?: GpuTimingSink): void {
    this.field.render(renderer, gpu);
    this.motion.render(renderer, gpu);
  }

  // 焼いた雲の場。テクスチャの所有権は BakedField に残す。
  public get texture(): THREE.Texture { return this.field.texture; }

  // 焼いた雲を運ぶ風の場(R・G = 地表付近、B・A = 上層の東・北の成分 [m/s])。
  public get motionTexture(): THREE.Texture { return this.motion.texture; }

  // 単位方向 direction での雲を、投影自身の uv で直接サンプリングする。cap による領域切り出しを行わないため、テクスチャ
  // 全域を参照できる。
  public at(direction: Vec3Node): CloudSample {
    return cloudSampleFromTexel(this.field.at(direction));
  }

  // 保持している GPU 資源を解放する。
  public dispose(): void {
    this.field.dispose();
    this.motion.dispose();
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
