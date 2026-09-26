// 気象モデルから凝結した雲テクスチャ（ベイクドフィールド）。ベイク時とサンプリング時の4基底割り当てを一括管理し、
// 出入りをどちらも CloudSample で受け渡す。cloudTop は basis の連続重みから導出される。
import * as THREE from 'three/webgpu';
import { BakedField } from '../baked-field';
import { GPU_PASS } from '../gpu-timings';
import { condense } from './condensation';
import { cloudFieldTexelFromSample, cloudSampleFromTexel, type CloudSample } from './cloud-field-sample';
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
      const cloud = condense(model.weatherAt(direction));
      return cloudFieldTexelFromSample(cloud);
    }, GPU_PASS.cloudBake);
  }

  // 現在時刻の雲をベイクドテクスチャへレンダリングする。at() でサンプリングする前に必ず一度呼び出す。
  public render(renderer: WebGPURenderer, gpu?: GpuTimingSink): void {
    this.field.render(renderer, gpu);
  }

  // 焼いた雲の場。テクスチャの所有権は BakedField に残す。
  public get texture(): THREE.Texture { return this.field.texture; }

  // 単位方向 direction での雲を、投影自身の uv で直接サンプリングする。cap による領域切り出しを行わないため、テクスチャ
  // 全域を参照できる。
  public at(direction: Vec3Node): CloudSample {
    return cloudSampleFromTexel(this.field.at(direction));
  }

  // 保持している GPU 資源を解放する。
  public dispose(): void {
    this.field.dispose();
  }
}
