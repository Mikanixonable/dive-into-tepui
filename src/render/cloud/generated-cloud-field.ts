// 気候から表示時刻の雲場を焼く所有者。気候・天気の中間場・出力場を同じ寿命で管理する。
import * as THREE from 'three/webgpu';
import type { ClimateMapLike } from './climate-map';
import { CloudField } from './cloud-field';
import { EquirectProjection } from './field-projection';
import { WeatherModel } from './weather-model';
import type { WebGPURenderer } from 'three/webgpu';
import type { FieldProjection } from './field-projection';
import type { CloudFieldSampler, CloudUvAt } from './cloud-field-sampler';
import { monthlyClimateClockAt } from './monthly-climate-clock';

// 全球の雲場の高さ [texel]。cloud-lab と同じ全球正距円筒の解像度を使う。
const GLOBAL_FIELD_HEIGHT = 512;

export class GeneratedCloudField {
  private readonly model: WeatherModel;
  private readonly field: CloudField;
  // 最後に焼いた表示時刻。表示時刻が同じ間は生成済みの場を使う。
  private lastBakedDisplayTime: number | null = null;
  // 気候テクスチャの到着前に焼いた場を、画像公開後の同じ時刻へ持ち越さない。
  private lastBakedClimateGeneration: number | null = null;
  private lastClimateMonth = -1;
  private lastClimateBlend = Number.NaN;

  // 気候を全球正距円筒へ投影する。
  public static global(
    climate: ClimateMapLike, uvAt?: CloudUvAt,
    projection: FieldProjection = new EquirectProjection(GLOBAL_FIELD_HEIGHT),
  ): GeneratedCloudField {
    return new GeneratedCloudField(climate, projection, uvAt);
  }

  // climate と、その中間場・出力場が共有する投影法を受け取る。
  public constructor(
    private readonly climate: ClimateMapLike, projection: FieldProjection, uvAt?: CloudUvAt,
  ) {
    this.model = new WeatherModel(climate, projection);
    this.field = new CloudField(this.model, projection, uvAt);
  }

  // 雲場のテクスチャ。出力場の所有権はこのクラスに残す。
  public get texture(): THREE.Texture { return this.field.texture; }

  // 雲場の所有者が公開する共有読み取り契約。sampler の破棄は不要で、texture の寿命はこのクラスが持つ。
  public get sampler(): CloudFieldSampler { return this.field.fieldSampler; }

  // 表示時刻の雲場を、天気の中間場から順に焼く。
  public bake(renderer: WebGPURenderer, displayTime: number): void {
    this.climate.request();
    const climateGeneration = this.climate.generation;
    if (this.lastBakedDisplayTime === displayTime
      && this.lastBakedClimateGeneration === climateGeneration) return;
    this.model.syncTime(displayTime);
    this.model.bake(renderer);
    this.field.render(renderer);
    this.lastBakedDisplayTime = displayTime;
    this.lastBakedClimateGeneration = climateGeneration;
  }

  // 月別気候を使う場合だけ呼び出し元が明示的に月を同期する。既存単月入力は変更しない。
  public syncClimateMonth(monthIndex: number, blend: number): void {
    if (!('setMonth' in this.climate) || typeof this.climate.setMonth !== 'function') {
      throw new Error('The configured climate map does not support monthly input');
    }
    this.climate.setMonth(monthIndex, blend);
    this.lastClimateMonth = monthIndex;
    this.lastClimateBlend = blend;
    this.lastBakedDisplayTime = null;
    this.lastBakedClimateGeneration = null;
  }

  // 絶対UTC秒を月別気候のcurrent/next選択へ変換する。
  public syncClimateTime(unixSeconds: number): void {
    const clock = monthlyClimateClockAt(unixSeconds);
    if (clock.monthIndex === this.lastClimateMonth && clock.blend === this.lastClimateBlend) return;
    this.syncClimateMonth(clock.monthIndex, clock.blend);
  }

  // 保持している雲場を解放する。
  public dispose(): void {
    this.field.dispose();
    this.model.dispose();
    this.climate.dispose();
  }
}
