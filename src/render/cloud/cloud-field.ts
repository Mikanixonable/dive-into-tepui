// 気象モデルから凝結した雲テクスチャ（ベイクドフィールド）。下層・上層の 2 層を 1 回で焼き、出入りを
// どちらも CloudSample で受け渡す。
import * as THREE from 'three/webgpu';
import { BakedField } from '../baked-field';
import { GPU_PASS } from '../gpu-timings';
import { condense } from './condensation';
import { cloudFieldTexelsFromSample, cloudSampleFromTexels, type CloudSample } from './cloud-field-sample';
import type { CloudFieldTextures } from './cloud-field-sampler';
import type { WebGPURenderer } from 'three/webgpu';
import type { GpuTimingSink } from '../gpu-timings';
import type { FieldProjection } from '../field-projection';
import type { WeatherModel } from './weather-model';
import type { Vec3Node } from '../tsl-types';

export class CloudField {
  private readonly field: BakedField;

  // model の現在時刻における雲を、指定された projection に従ってベイクするテクスチャ。サンプリング時も projection の uv を参照する。
  public constructor(model: WeatherModel, projection: FieldProjection) {
    this.field = new BakedField('cloud', THREE.RGBAFormat, projection, (direction) => {
      const texels = cloudFieldTexelsFromSample(condense(direction, model.weatherAt(direction)));
      return [texels.lower, texels.upper];
    }, GPU_PASS.cloudBake);
  }

  // 現在時刻の雲をベイクドテクスチャへレンダリングする。at() でサンプリングする前に必ず一度呼び出す。
  public render(renderer: WebGPURenderer, gpu?: GpuTimingSink): void {
    this.field.render(renderer, gpu);
  }

  // 焼いた雲の場の下層・上層。テクスチャの所有権は BakedField に残す。
  public get textures(): CloudFieldTextures {
    return { lower: this.field.textureAt(0), upper: this.field.textureAt(1) };
  }

  // 単位方向 direction での雲を、投影自身の uv で直接サンプリングする。cap による領域切り出しを行わないため、テクスチャ
  // 全域を参照できる。
  public at(direction: Vec3Node): CloudSample {
    return cloudSampleFromTexels({ lower: this.field.at(direction, 0), upper: this.field.at(direction, 1) });
  }

  // 保持している GPU 資源を解放する。
  public dispose(): void {
    this.field.dispose();
  }
}
