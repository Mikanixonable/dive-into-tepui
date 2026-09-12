// 天気が凝結する雲を焼いた写し。焼くときと読むときの成分の割り当てを一手に持ち、
// 出入りをどちらも CloudSample で受け渡す。テクスチャの G は雲頂高度を CLOUD_TOP_SPAN で
// 正規化した値、CloudSample の cloudTop はメートルである。
import * as THREE from 'three/webgpu';
import { BakedField } from './baked-field';
import { condense } from './condensation';
import { cloudFieldTexelFromSample, cloudSampleFromTexel, type CloudSample } from './cloud-field-sample';
import type { WebGPURenderer } from 'three/webgpu';
import type { GpuTimingSink } from '../gpu-timings';
import type { FieldProjection } from './field-projection';
import type { WeatherModel } from './weather-model';
import type { Vec3Node } from '../tsl-types';

export class CloudField {
  private readonly field: BakedField;

  // model がいま指している時刻の雲を、projection の持ち方で焼く写し。読むときも projection の uv で読む。
  public constructor(model: WeatherModel, projection: FieldProjection) {
    this.field = new BakedField('cloud', THREE.RGBAFormat, projection, (direction) => {
      const cloud = condense(model.weatherAt(direction));
      return cloudFieldTexelFromSample(cloud);
    });
  }

  // いまの時刻の雲を写しへ描く。at() で読む前に必ず一度呼ぶ。
  public render(renderer: WebGPURenderer, gpu?: GpuTimingSink): void {
    this.field.render(renderer, gpu);
  }

  // 焼いた雲の場。テクスチャの所有権は BakedField に残す。
  public get texture(): THREE.Texture { return this.field.texture; }

  // 単位方向 direction での雲。**投影自身の uv で直に読む** — 実験環境が場の全域を出すための口で、
  // 描画のパイプラインは自分の CloudFieldSampler を cap の置き方へ結んで読む。
  public at(direction: Vec3Node): CloudSample {
    return cloudSampleFromTexel(this.field.at(direction));
  }

  // 保持している GPU 資源を解放する。
  public dispose(): void {
    this.field.dispose();
  }
}
