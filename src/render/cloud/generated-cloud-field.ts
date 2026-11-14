// 気候から表示時刻の雲場を焼く所有者。気候・天気の中間場・出力場を同じ寿命で管理する。
import { CloudField } from './cloud-field';
import { WeatherModel } from './weather-model';
import type { WebGPURenderer } from 'three/webgpu';
import type { ClimateMap } from './climate-map';
import type { GpuTimingSink } from '../gpu-timings';
import type { FieldProjection } from '../field-projection';
import type { CloudBlend, CloudFieldSlot, CloudSample } from './cloud-field-sample';
import type { CloudFieldSource } from './cloud-presentation';
import type { Vec3Node } from '../tsl-types';

// 雲場を焼く表示時刻の刻み [s]。雲場は、この刻みで焼いた 2 枚のあいだを表示時刻で補間して読む。
const CLOUD_BAKE_DISPLAY_TIME_STEP = 6;

export class GeneratedCloudField implements CloudFieldSource {
  private readonly model: WeatherModel;
  private readonly field: CloudField;
  // 古い側の枚が焼かれた表示時刻。新しい側の枚はそこから CLOUD_BAKE_DISPLAY_TIME_STEP 先。
  private olderTime: number | null = null;
  // 古い側の枚の番号。
  private olderSlot: 0 | 1 = 0;
  // 直前に prepare された表示時刻。大きく飛んだときは補間せず焼き直す。
  private lastDisplayTime: number | null = null;
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

  // 雲場の 2 枚と混ぜ方。出力場の所有権はこのクラスに残す。
  public get slots(): readonly [CloudFieldSlot, CloudFieldSlot] { return this.field.slots; }
  public get blend(): CloudBlend { return this.field.blend; }
  public get generation(): number { return this.generationValue; }

  // 単位方向 direction での雲を、投影自身の uv で直に読む(cap の窓ぎめを通さない読み方)。
  public at(direction: Vec3Node): CloudSample { return this.field.at(direction); }

  // この場を焼く天気のモデル・気候・投影。prepare で焼いた中間場を読むときに使い、寿命はこのクラスが持つ。
  public get weatherModel(): WeatherModel { return this.model; }
  public get climateMap(): ClimateMap { return this.climate; }
  public get fieldProjection(): FieldProjection { return this.projection; }

  // 表示時刻 displayTime の雲場の混ぜ方を置く。表示時刻が新しい側の刻みに届いたら、その先の刻みを焼き足す。
  public prepare(renderer: WebGPURenderer, displayTime: number, gpu?: GpuTimingSink): void {
    // 気候画像の取得を始める。
    this.climate.request();
    const climateGeneration = this.climate.generation;
    const projectionRevision = this.projection.revision;
    const jump = this.lastDisplayTime === null ? Infinity : displayTime - this.lastDisplayTime;
    this.lastDisplayTime = displayTime;
    const older = this.olderTime;
    // 2 枚が表示時刻を挟めないとき(巻き戻し・大きな飛び・気候か投影の変化)は、表示時刻の 1 枚だけを焼き直す。
    const olderTime = older === null || !this.canReuse(displayTime, older, jump, climateGeneration, projectionRevision)
      ? this.bakeFresh(renderer, displayTime, gpu)
      : displayTime >= older + CLOUD_BAKE_DISPLAY_TIME_STEP ? this.bakeAhead(renderer, older, gpu)
        : older;
    const fraction = (displayTime - olderTime) / CLOUD_BAKE_DISPLAY_TIME_STEP;
    this.field.setBlend(this.olderSlot, fraction);
  }

  // 古い側の枚を残したまま、表示時刻を補間で読めるか。
  private canReuse(
    displayTime: number, older: number, jump: number, climateGeneration: number, projectionRevision: number,
  ): boolean {
    return this.lastBakedClimateGeneration === climateGeneration
      && this.lastBakedProjectionRevision === projectionRevision
      && displayTime >= older && displayTime <= older + 2 * CLOUD_BAKE_DISPLAY_TIME_STEP
      && jump < CLOUD_BAKE_DISPLAY_TIME_STEP;
  }

  // 表示時刻 displayTime の天気を新しい側の枚(1)へ焼き、補間の重みを新しい側へ満たす(古い側は使わない)。
  // 古い側の枚は、次の prepare で先の刻みへ焼き直される。大きな時間加速で毎フレーム飛ぶときも、焼くのは 1 回で済む。
  private bakeFresh(renderer: WebGPURenderer, displayTime: number, gpu?: GpuTimingSink): number {
    this.bakeSlot(renderer, 1, displayTime, gpu);
    this.lastBakedClimateGeneration = this.climate.generation;
    this.lastBakedProjectionRevision = this.projection.revision;
    this.olderSlot = 0;
    this.olderTime = displayTime - CLOUD_BAKE_DISPLAY_TIME_STEP;
    this.generationValue += 1;
    return this.olderTime;
  }

  // 古い側の枚を、新しい側の刻みのさらに先の表示時刻で焼き直し、焼き直した枚を新しい側にする。
  private bakeAhead(renderer: WebGPURenderer, older: number, gpu?: GpuTimingSink): number {
    const aheadTime = older + 2 * CLOUD_BAKE_DISPLAY_TIME_STEP;
    this.bakeSlot(renderer, this.olderSlot, aheadTime, gpu);
    this.olderSlot = this.olderSlot === 0 ? 1 : 0;
    this.olderTime = older + CLOUD_BAKE_DISPLAY_TIME_STEP;
    this.generationValue += 1;
    return this.olderTime;
  }

  // 表示時刻 time の天気を中間場から焼き、枚 slot の雲・風・環境へ描く。
  private bakeSlot(renderer: WebGPURenderer, slot: 0 | 1, time: number, gpu?: GpuTimingSink): void {
    this.model.syncTime(time);
    this.model.bake(renderer, gpu);
    this.field.renderSlot(slot, renderer, gpu);
  }

  // 保持している雲場を解放する。
  public dispose(): void {
    this.field.dispose();
    this.model.dispose();
    this.climate.dispose();
  }
}
