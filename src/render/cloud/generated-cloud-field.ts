// 気候から表示時刻の雲場を焼く所有者。気候・天気の中間場・出力場を同じ寿命で管理する。
import type * as THREE from 'three/webgpu';
import { CloudField } from './cloud-field';
import { WeatherModel } from './weather-model';
import type { WebGPURenderer } from 'three/webgpu';
import type { ClimateMap } from './climate-map';
import type { GpuTimingSink } from '../gpu-timings';
import type { FieldProjection } from '../field-projection';
import type { CloudSample } from './cloud-field-sample';
import type { CloudFieldSource } from './cloud-field-source';
import type { Vec3Node } from '../tsl-types';
import type { CloudState, CloudStateBinding } from './cloud-state';

export class GeneratedCloudField implements CloudFieldSource {
  private readonly model: WeatherModel;
  private readonly field: CloudField;
  // 最後に焼いた表示時刻。同じ時刻の間は生成済みの場を使う。
  private lastBakedDisplayTime: number | null = null;
  // 最後に焼いたときの気候の世代。読む画像が変われば、同じ表示時刻でも焼き直す。
  private lastBakedClimateGeneration: number | null = null;
  // 最後に焼いたときの投影の版。置き方が変われば、同じ表示時刻でも焼き直す。
  private lastBakedProjectionRevision: number | null = null;
  private generationValue = 0;
  private stateValue: CloudStateBinding = {
    absoluteTimeSeconds: 0,
    seed: 0,
  };

  // climate と、その中間場・出力場が共有する投影法を受け取る。surfaceRadius は雲を載せる天体の
  // 半径 [m]、rotationPeriod はその自転周期 [s]。
  public constructor(
    private readonly climate: ClimateMap, public readonly projection: FieldProjection,
    surfaceRadius: number, rotationPeriod: number,
  ) {
    this.model = new WeatherModel(climate, projection, surfaceRadius, rotationPeriod);
    this.field = new CloudField(this.model, projection);
  }

  // 雲場のテクスチャ。出力場の所有権はこのクラスに残す。
  public get basisTexture(): THREE.Texture { return this.field.basisTexture; }
  public get shapeTexture(): THREE.Texture { return this.field.shapeTexture; }
  public get generation(): number { return this.generationValue; }
  public get state(): CloudStateBinding { return this.stateValue; }

  // 単位方向 direction の雲を、投影自身の uv で直に読む。
  public at(direction: Vec3Node): CloudSample { return this.field.at(direction); }
  public stateAt(direction: Vec3Node): CloudState {
    return this.field.stateAt(
      direction,
      this.stateValue.absoluteTimeSeconds,
      this.stateValue.seed,
    );
  }

  // この場を焼く天気のモデル・気候・投影。prepare で焼いた中間場を読むときに使い、寿命はこのクラスが持つ。
  public get weatherModel(): WeatherModel { return this.model; }
  public get climateMap(): ClimateMap { return this.climate; }
  public get fieldProjection(): FieldProjection { return this.projection; }

  // 表示時刻の雲場を、天気の中間場から順に焼く。
  public prepare(renderer: WebGPURenderer, displayTime: number, gpu?: GpuTimingSink | null): void {
    // 気候画像の取得を始める。
    this.climate.request();
    // 表示時刻・気候の入力・投影の置き方が前回と同じなら、焼いた場をそのまま使う。
    const climateGeneration = this.climate.generation;
    const projectionRevision = this.projection.revision;
    if (this.lastBakedDisplayTime === displayTime
      && this.lastBakedClimateGeneration === climateGeneration
      && this.lastBakedProjectionRevision === projectionRevision) return;
    // 天気の中間場から雲場まで順に焼く。
    this.model.syncTime(displayTime);
    this.model.bake(renderer, gpu ?? undefined);
    this.field.render(renderer, gpu ?? undefined);
    this.generationValue += 1;
    this.lastBakedDisplayTime = displayTime;
    this.lastBakedClimateGeneration = climateGeneration;
    this.lastBakedProjectionRevision = projectionRevision;
    this.stateValue = {
      absoluteTimeSeconds: displayTime,
      seed: Math.trunc(displayTime / (24 * 60 * 60)),
    };
  }

  // 保持している雲場を解放する。
  public dispose(): void {
    this.field.dispose();
    this.model.dispose();
    this.climate.dispose();
  }
}
