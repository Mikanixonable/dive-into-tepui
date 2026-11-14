// 気象モデルから地表風と陸海を焼く風テクスチャ(ベイクドフィールド)。粒の移流と陸海の
// 条件づけが描画時に読む、雲場と同じ投影の場。
import * as THREE from 'three/webgpu';
import { BakedField } from '../baked-field';
import { GPU_PASS } from '../gpu-timings';
import { windTexelFromSample } from './cloud-wind-sample';
import type { WebGPURenderer } from 'three/webgpu';
import type { GpuTimingSink } from '../gpu-timings';
import type { FieldProjection } from '../field-projection';
import type { WeatherModel } from './weather-model';

export class CloudWindField {
  private readonly field: BakedField;

  // model の現在時刻における地表風と陸海を、指定された projection に従ってベイクするテクスチャ。
  public constructor(model: WeatherModel, projection: FieldProjection) {
    this.field = new BakedField('wind', THREE.RGBAFormat, projection, (direction) => {
      const weather = model.weatherAt(direction);
      return windTexelFromSample({ wind: weather.surfaceWind, land: weather.landFraction });
    }, GPU_PASS.cloudBake);
  }

  // 現在時刻の風をベイクドテクスチャへレンダリングする。読む前に必ず一度呼び出す。
  public render(renderer: WebGPURenderer, gpu?: GpuTimingSink): void {
    this.field.render(renderer, gpu);
  }

  // 焼いた風の場。テクスチャの所有権は BakedField に残す。
  public get texture(): THREE.Texture { return this.field.texture; }

  // 保持している GPU 資源を解放する。
  public dispose(): void {
    this.field.dispose();
  }
}
