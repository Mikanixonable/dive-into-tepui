// 天気が凝結する雲を焼いた写し。焼くときと読むときの成分の割り当てを一手に持ち、
// 出入りをどちらも CloudSample で受け渡す。テクスチャの G は雲頂高度を CLOUD_TOP_SPAN で
// 正規化した値、CloudSample の cloudTop はメートルである。
import * as THREE from 'three/webgpu';
import { BakedField } from './baked-field';
import { CloudFieldSampler } from './cloud-field-sampler';
import { condense } from './condensation';
import { cloudFieldTexelFromSample, type CloudSample } from './cloud-field-sample';
import type { WebGPURenderer } from 'three/webgpu';
import type { GpuTimingSink } from '../gpu-timings';
import type { FieldProjection } from './field-projection';
import type { WeatherModel } from './weather-model';
import type { Vec3Node } from '../tsl-types';

export class CloudField {
  private readonly field: BakedField;
  private readonly sampler: CloudFieldSampler;

  // model がいま指している時刻の雲を、projection の持ち方で焼く写し。読むときも projection の uv で読む。
  public constructor(model: WeatherModel, projection: FieldProjection) {
    this.field = new BakedField('cloud', THREE.RGBAFormat, projection, (direction) => {
      const cloud = condense(model.weatherAt(direction));
      return cloudFieldTexelFromSample(cloud);
    });
    // 投影の uvAt は投影自身の uniform を読むので、投影に束縛して渡す。
    this.sampler = new CloudFieldSampler(this.field.texture, (direction) => projection.uvAt(direction));
  }

  // いまの時刻の雲を写しへ描く。at() で読む前に必ず一度呼ぶ。
  public render(renderer: WebGPURenderer, gpu?: GpuTimingSink): void {
    this.field.render(renderer, gpu);
  }

  // 焼いた雲の場。テクスチャの所有権は BakedField に残す。
  public get texture(): THREE.Texture { return this.field.texture; }

  // 表現 renderer が共有する読み取り規則。sampler は field の GPU 資源を所有しない。
  public get fieldSampler(): CloudFieldSampler { return this.sampler; }

  // 単位方向 direction での雲。
  public at(direction: Vec3Node): CloudSample {
    return this.sampler.sampleCloud(direction);
  }

  // 保持している GPU 資源を解放する。
  public dispose(): void {
    this.field.dispose();
  }
}
