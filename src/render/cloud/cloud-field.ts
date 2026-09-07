// 天気が凝結する雲を焼いた写し。焼くときと読むときの成分の割り当てを一手に持ち、
// 出入りをどちらも CloudSample で受け渡す。
import * as THREE from 'three/webgpu';
import { vec4 } from 'three/tsl';
import { BakedField } from './baked-field';
import { condense } from './condensation';
import { ClimateMap } from './climate-map';
import { EquirectProjection } from './field-projection';
import { WeatherModel } from './weather-model';
import type { WebGPURenderer } from 'three/webgpu';
import type { CloudSample } from './condensation';
import type { FieldProjection } from './field-projection';
import type { Vec3Node } from '../tsl-types';

// 全球の雲場の高さ [texel]。cloud-lab と同じ全球正距円筒の解像度を使う。
const GLOBAL_FIELD_HEIGHT = 512;

export class CloudField {
  private readonly field: BakedField;

  // model がいま指している時刻の雲を、projection の持ち方で焼く写し。
  public constructor(model: WeatherModel, projection: FieldProjection) {
    this.field = new BakedField('cloud', THREE.RGBAFormat, projection, 1, (direction) => {
      const cloud = condense(model.weatherAt(direction));
      return vec4(cloud.coverage, cloud.cloudTop, cloud.translucent, 1);
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
    return { coverage: texel.r, cloudTop: texel.g, translucent: texel.b };
  }

  // 保持している GPU 資源を解放する。
  public dispose(): void {
    this.field.dispose();
  }
}

// 気候から表示時刻の雲場を焼く所有者。気候・天気の中間場・出力場を同じ寿命で管理する。
export class GeneratedCloudField {
  private readonly model: WeatherModel;
  private readonly field: CloudField;

  // 気候を全球正距円筒へ投影する。
  public static global(climate: ClimateMap): GeneratedCloudField {
    return new GeneratedCloudField(climate, new EquirectProjection(GLOBAL_FIELD_HEIGHT));
  }

  // climate と、その中間場・出力場が共有する投影法を受け取る。
  public constructor(private readonly climate: ClimateMap, projection: FieldProjection) {
    this.model = new WeatherModel(climate, projection);
    this.field = new CloudField(this.model, projection);
  }

  // 雲場のテクスチャ。出力場の所有権はこのクラスに残す。
  public get texture(): THREE.Texture { return this.field.texture; }

  // 表示時刻の雲場を、天気の中間場から順に焼く。
  public bake(renderer: WebGPURenderer, displayTime: number): void {
    this.climate.request();
    this.model.syncTime(displayTime);
    this.model.bake(renderer);
    this.field.render(renderer);
  }

  // 保持している雲場を解放する。
  public dispose(): void {
    this.field.dispose();
    this.model.dispose();
    this.climate.dispose();
  }
}
