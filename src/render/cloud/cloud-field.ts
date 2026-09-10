// 天気が凝結する雲を焼いた写し。焼くときと読むときの成分の割り当てを一手に持ち、
// 出入りをどちらも CloudSample で受け渡す。テクスチャの G は雲頂高度を CLOUD_TOP_SPAN で
// 正規化した値、CloudSample の cloudTop はメートルである。
import * as THREE from 'three/webgpu';
import { vec4 } from 'three/tsl';
import { BakedField } from './baked-field';
import { condense } from './condensation';
import { CLOUD_TOP_SPAN } from './cumulus-shape';
import type { WebGPURenderer } from 'three/webgpu';
import type { CloudSample } from './condensation';
import type { FieldProjection } from './field-projection';
import type { WeatherModel } from './weather-model';
import type { Vec3Node } from '../tsl-types';

export class CloudField {
  private readonly field: BakedField;

  // model がいま指している時刻の雲を、projection の持ち方で焼く写し。
  public constructor(model: WeatherModel, projection: FieldProjection) {
    this.field = new BakedField('cloud', THREE.RGBAFormat, projection, 1, (direction) => {
      const cloud = condense(model.weatherAt(direction));
      return vec4(cloud.coverage, cloud.cloudTop.div(CLOUD_TOP_SPAN), cloud.translucent, 1);
    });
  }

  // いまの時刻の雲を写しへ描く。at() で読む前に必ず一度呼ぶ。
  public render(renderer: WebGPURenderer): void {
    this.field.render(renderer);
  }

  // 焼いた雲の場。テクスチャの所有権は BakedField に残す。
  public get texture(): THREE.Texture { return this.field.texture; }

  // 単位方向 direction での雲。
  public at(direction: Vec3Node): CloudSample {
    const texel = this.field.at(direction);
    return { coverage: texel.r, cloudTop: texel.g.mul(CLOUD_TOP_SPAN), translucent: texel.b };
  }

  // 保持している GPU 資源を解放する。
  public dispose(): void {
    this.field.dispose();
  }
}
