// 気候から表示時刻の雲場を焼く所有者。気候・天気の中間場・出力場を同じ寿命で管理する。
import * as THREE from 'three/webgpu';
import { CloudField } from './cloud-field';
import { EquirectProjection } from './field-projection';
import { WeatherModel } from './weather-model';
import { monthlyClimateClockAt } from './monthly-climate-clock';
import type { WebGPURenderer } from 'three/webgpu';
import type { ClimateMapLike } from './climate-map';
import type { GpuTimingSink } from '../gpu-timings';
import type { FieldProjection } from './field-projection';
import type { CloudFieldSampler } from './cloud-field-sampler';
import type { CloudFieldSource } from './cloud-presentation';

// 全球の雲場の高さ [texel]。cloud-lab と同じ全球正距円筒の解像度を使う。
const GLOBAL_FIELD_HEIGHT = 512;

export class GeneratedCloudField implements CloudFieldSource {
  private readonly model: WeatherModel;
  private readonly field: CloudField;
  // 最後に焼いた表示時刻。表示時刻が同じ間は生成済みの場を使う。
  private lastBakedDisplayTime: number | null = null;
  // 気候テクスチャの到着前に焼いた場を、画像公開後の同じ時刻へ持ち越さない。
  private lastBakedClimateGeneration: number | null = null;
  private lastClimateMonth = -1;
  private lastClimateBlend = Number.NaN;

  // 気候を全球へ投影する。surfaceRadius は天体の半径 [m]、rotationPeriod は自転周期 [s]、
  // climateEpochUnixSec は表示時刻 0 の UTC [s](null なら気候の月を表示時刻へ合わせない)。
  public static global(
    climate: ClimateMapLike, surfaceRadius: number, rotationPeriod: number, climateEpochUnixSec: number | null,
    projection: FieldProjection = new EquirectProjection(GLOBAL_FIELD_HEIGHT),
  ): GeneratedCloudField {
    return new GeneratedCloudField(climate, projection, surfaceRadius, rotationPeriod, climateEpochUnixSec);
  }

  // climate と、その中間場・出力場が共有する投影法を受け取る。surfaceRadius は雲を載せる天体の
  // 半径 [m]、rotationPeriod はその自転周期 [s]、climateEpochUnixSec は表示時刻 0 の UTC [s]
  // (月別でない気候では null にする)。
  public constructor(
    private readonly climate: ClimateMapLike, projection: FieldProjection,
    surfaceRadius: number, rotationPeriod: number,
    private readonly climateEpochUnixSec: number | null,
  ) {
    this.model = new WeatherModel(climate, projection, surfaceRadius, rotationPeriod);
    this.field = new CloudField(this.model, projection);
  }

  // 雲場のテクスチャ。出力場の所有権はこのクラスに残す。
  public get texture(): THREE.Texture { return this.field.texture; }

  // 雲場の所有者が公開する共有読み取り契約。sampler の破棄は不要で、texture の寿命はこのクラスが持つ。
  public get sampler(): CloudFieldSampler { return this.field.fieldSampler; }

  // 表示時刻の雲場を、気候の月を合わせてから天気の中間場から順に焼く。
  public prepare(renderer: WebGPURenderer, displayTime: number, gpu?: GpuTimingSink): void {
    // 気候の月を表示時刻へ合わせ、気候画像の取得を始める。
    if (this.climateEpochUnixSec !== null) this.syncClimateTime(this.climateEpochUnixSec + displayTime);
    this.climate.request();
    // 表示時刻と気候の入力が前回と同じなら、焼いた場をそのまま使う。
    const climateGeneration = this.climate.generation;
    if (this.lastBakedDisplayTime === displayTime
      && this.lastBakedClimateGeneration === climateGeneration) return;
    // 天気の中間場から雲場まで順に焼く。
    this.model.syncTime(displayTime);
    this.model.bake(renderer, gpu);
    this.field.render(renderer, gpu);
    this.lastBakedDisplayTime = displayTime;
    this.lastBakedClimateGeneration = climateGeneration;
  }

  // 絶対UTC秒を月別気候のcurrent/next選択へ変換する。
  private syncClimateTime(unixSeconds: number): void {
    const clock = monthlyClimateClockAt(unixSeconds);
    if (clock.monthIndex === this.lastClimateMonth && clock.blend === this.lastClimateBlend) return;
    this.syncClimateMonth(clock.monthIndex, clock.blend);
  }

  // 気候の月を monthIndex と次の月への混ぜ具合 blend へ置き直し、次の prepare で焼き直させる。
  // 月別でない気候なら例外。
  private syncClimateMonth(monthIndex: number, blend: number): void {
    if (!('setMonth' in this.climate) || typeof this.climate.setMonth !== 'function') {
      throw new Error('The configured climate map does not support monthly input');
    }
    this.climate.setMonth(monthIndex, blend);
    this.lastClimateMonth = monthIndex;
    this.lastClimateBlend = blend;
    this.lastBakedDisplayTime = null;
    this.lastBakedClimateGeneration = null;
  }

  // 保持している雲場を解放する。
  public dispose(): void {
    this.field.dispose();
    this.model.dispose();
    this.climate.dispose();
  }
}
