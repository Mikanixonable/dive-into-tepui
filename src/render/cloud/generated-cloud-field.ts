// 気候から表示時刻の雲場を焼く所有者。気候・天気の中間場・出力場を同じ寿命で管理する。
import type * as THREE from 'three/webgpu';
import { CloudField } from './cloud-field';
import { CloudWindField } from './cloud-wind-field';
import { WeatherModel } from './weather-model';
import type { WebGPURenderer } from 'three/webgpu';
import type { ClimateMap } from './climate-map';
import type { GpuTimingSink } from '../gpu-timings';
import type { FieldProjection } from '../field-projection';
import type { CloudSample } from './cloud-field-sample';
import type { CloudFieldSource } from './cloud-presentation';
import type { SurfaceWind } from './cloud-wind-sample';
import type { Vec3Node } from '../tsl-types';

export class GeneratedCloudField implements CloudFieldSource {
  private readonly model: WeatherModel;
  private readonly field: CloudField;
  private readonly wind: CloudWindField;
  // 最新の焼きで読み戻した cap 中心の地表風 [m/s]。読み戻しがまだなら (0, 0) で粒は静止する。
  private centerWindValue: SurfaceWind = { east: 0, north: 0 };
  // 最後に焼いた表示時刻。表示時刻が同じ間は生成済みの場を使う。
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
    this.wind = new CloudWindField(this.model, projection);
  }

  // 雲場のテクスチャ。出力場の所有権はこのクラスに残す。
  public get texture(): THREE.Texture { return this.field.texture; }
  // 風場のテクスチャ。出力場の所有権はこのクラスに残す。
  public get windTexture(): THREE.Texture { return this.wind.texture; }
  // 最新の焼きで読み戻した cap 中心の地表風 [m/s]。読み戻しがまだなら (0, 0)。
  public get centerWind(): SurfaceWind { return this.centerWindValue; }
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
    // 表示時刻・気候の入力・投影の置き方が前回と同じなら、焼いた場をそのまま使う。
    const climateGeneration = this.climate.generation;
    const projectionRevision = this.projection.revision;
    if (this.lastBakedDisplayTime === displayTime
      && this.lastBakedClimateGeneration === climateGeneration
      && this.lastBakedProjectionRevision === projectionRevision) return;
    // 天気の中間場から雲場まで順に焼く。
    this.model.syncTime(displayTime);
    this.model.bake(renderer, gpu);
    this.field.render(renderer, gpu);
    this.wind.render(renderer, gpu);
    this.generationValue += 1;
    this.lastBakedDisplayTime = displayTime;
    this.lastBakedClimateGeneration = climateGeneration;
    this.lastBakedProjectionRevision = projectionRevision;
    // 中心風の読み戻しを蹴る。結果は次のフレームから使う。焼きの世代が進んでいたら古い
    // 結果は捨て、読み戻しの失敗は描画を止めない(粒が静止のまま)。
    const bakedGeneration = this.generationValue;
    void this.wind.readCenterWind(renderer).then((wind) => {
      if (this.generationValue !== bakedGeneration) return;
      this.centerWindValue = wind;
    }).catch(() => { /* 中心風が読めないときは粒を静止のままにする */ });
  }

  // 保持している雲場を解放する。
  public dispose(): void {
    this.field.dispose();
    this.wind.dispose();
    this.model.dispose();
    this.climate.dispose();
  }
}
