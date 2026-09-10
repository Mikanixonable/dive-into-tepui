// 気候から表示時刻の雲場を焼く所有者。気候・天気の中間場・出力場を同じ寿命で管理する。
import * as THREE from 'three/webgpu';
import { ClimateMap } from './climate-map';
import { CloudField } from './cloud-field';
import { EquirectProjection } from './field-projection';
import { WeatherModel } from './weather-model';
import type { WebGPURenderer } from 'three/webgpu';
import type { FieldProjection } from './field-projection';

// 全球の雲場の高さ [texel]。cloud-lab と同じ全球正距円筒の解像度を使う。
const GLOBAL_FIELD_HEIGHT = 512;

export class GeneratedCloudField {
  private readonly model: WeatherModel;
  private readonly field: CloudField;
  // 最後に焼いた表示時刻。表示時刻が同じ間は生成済みの場を使う。
  private lastBakedDisplayTime: number | null = null;

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
    if (this.lastBakedDisplayTime === displayTime) return;
    this.climate.request();
    this.model.syncTime(displayTime);
    this.model.bake(renderer);
    this.field.render(renderer);
    this.lastBakedDisplayTime = displayTime;
  }

  // 保持している雲場を解放する。
  public dispose(): void {
    this.field.dispose();
    this.model.dispose();
    this.climate.dispose();
  }
}
