// 気候から表示時刻の雲場を焼く所有者。気候・天気の中間場・出力場を同じ寿命で管理する。
import type * as THREE from 'three/webgpu';
import { CloudField } from './cloud-field';
import { WeatherModel } from './weather-model';
import type { WebGPURenderer } from 'three/webgpu';
import type { ClimateMap } from './climate-map';
import type { GpuTimingSink } from '../gpu-timings';
import type { FieldProjection } from '../field-projection';
import type { CloudSample } from './cloud-field-sample';
import type { CloudFieldSource } from './cloud-presentation';
import type { Vec3Node } from '../tsl-types';

// 雲場を焼き直す表示時刻の刻み [s]。前回のベイクからこの幅のあいだは、気候と投影が同じ限り
// 前回の場を使い続ける。この幅では場の変化が texel より細かく、焼き直しても見えの差が出ない。
const CLOUD_BAKE_DISPLAY_TIME_STEP = 6;

export class GeneratedCloudField implements CloudFieldSource {
  private readonly model: WeatherModel;
  private readonly field: CloudField;
  // 最後に焼いた表示時刻。表示時刻が CLOUD_BAKE_DISPLAY_TIME_STEP より近い間は生成済みの場を使う。
  private lastBakedDisplayTime: number | null = null;
  // 最後に焼いたときの気候の世代。読む画像が変われば、同じ表示時刻でも焼き直す。
  private lastBakedClimateGeneration: number | null = null;
  // 最後に焼いたときの投影の版。置き方が変われば、同じ表示時刻でも焼き直す。
  private lastBakedProjectionRevision: number | null = null;
  private generationValue = 0;

  // climate と、その中間場・出力場が共有する投影法を受け取る。surfaceRadius は雲を載せる天体の
  // 半径 [m]、rotationPeriod はその自転周期 [s]。
  public constructor(
    private readonly climate: ClimateMap, private readonly projection: FieldProjection,
    surfaceRadius: number, rotationPeriod: number,
  ) {
    this.model = new WeatherModel(climate, projection, surfaceRadius, rotationPeriod);
    this.field = new CloudField(this.model, projection);
  }

  // 雲場のテクスチャ。出力場の所有権はこのクラスに残す。
  public get texture(): THREE.Texture { return this.field.texture; }
  public get motionTexture(): THREE.Texture { return this.field.motionTexture; }
  public get environmentTexture(): THREE.Texture { return this.field.environmentTexture; }
  public get generation(): number { return this.generationValue; }

  // 単位方向 direction での雲を、投影自身の uv で直に読む(cap の窓ぎめを通さない読み方)。
  public at(direction: Vec3Node): CloudSample { return this.field.at(direction); }

  // この場を焼く天気のモデル・気候・投影。prepare で焼いた中間場を読むときに使い、寿命はこのクラスが持つ。
  public get weatherModel(): WeatherModel { return this.model; }
  public get climateMap(): ClimateMap { return this.climate; }
  public get fieldProjection(): FieldProjection { return this.projection; }

  // 表示時刻の雲場を、天気の中間場から順に焼く。
  public prepare(renderer: WebGPURenderer, displayTime: number, gpu?: GpuTimingSink): void {
    // 気候画像の取得を始める。
    this.climate.request();
    // 表示時刻が前回のベイクに近く、気候の入力と投影の置き方が同じなら、焼いた場をそのまま使う。
    // 時刻の差は絶対値で見る — 止まっている間と、巻き戻しの中も同じ場で足りる。
    const climateGeneration = this.climate.generation;
    const projectionRevision = this.projection.revision;
    if (this.lastBakedDisplayTime !== null
      && Math.abs(displayTime - this.lastBakedDisplayTime) < CLOUD_BAKE_DISPLAY_TIME_STEP
      && this.lastBakedClimateGeneration === climateGeneration
      && this.lastBakedProjectionRevision === projectionRevision) return;
    // 天気の中間場から雲場まで順に焼く。
    this.model.syncTime(displayTime);
    this.model.bake(renderer, gpu);
    this.field.render(renderer, gpu);
    this.generationValue += 1;
    this.lastBakedDisplayTime = displayTime;
    this.lastBakedClimateGeneration = climateGeneration;
    this.lastBakedProjectionRevision = projectionRevision;
  }

  // 保持している雲場を解放する。
  public dispose(): void {
    this.field.dispose();
    this.model.dispose();
    this.climate.dispose();
  }
}
