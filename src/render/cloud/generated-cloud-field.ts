// 気候から表示時刻の雲場を焼く所有者。気候・天気の中間場・出力場を同じ寿命で管理する。
import type * as THREE from 'three/webgpu';
import { CloudField } from './cloud-field';
import { WeatherModel } from './weather-model';
import type { WebGPURenderer } from 'three/webgpu';
import type { ClimateMap } from './climate-map';
import type { GpuTimingSink } from '../gpu-timings';
import type { FieldProjection } from './field-projection';
import type { CloudSample } from './cloud-field-sample';
import type { CloudFieldSource } from './cloud-presentation';
import type { Vec3Node } from '../tsl-types';
import {
  canBakeInWindow, temporalLodFor, targetSimulationTime, type TemporalLodMode,
} from './temporal-lod';
import { simulationSecondsPerFrame, splitSimulationTime } from './weather-time';
import type { CloudState, CloudStateBinding } from './cloud-state';
import { CLOUD_QUALITY, type CloudQualityLevel } from './cloud-quality';

export class GeneratedCloudField implements CloudFieldSource {
  private readonly model: WeatherModel;
  private readonly field: CloudField;
  // 最後に焼いた target 時刻。極端な時間加速では表示時刻そのものを毎フレーム追わず、保持中の場を使う。
  private lastBakedDisplayTime: number | null = null;
  // 最後に焼いたときの気候の世代。読む画像が変われば、同じ表示時刻でも焼き直す。
  private lastBakedClimateGeneration: number | null = null;
  // 最後に焼いたときの投影の版。置き方が変われば、同じ表示時刻でも焼き直す。
  private lastBakedProjectionRevision: number | null = null;
  private lastBakedTemporalMode: TemporalLodMode | null = null;
  private lastRequestedDisplayTime: number | null = null;
  private lastRequestedWallTimeMs: number | null = null;
  private bakeWindowStartMs: number | null = null;
  private bakeCountInWindow = 0;
  private generationValue = 0;
  private quality: CloudQualityLevel = 'standard';
  private stateValue: CloudStateBinding = {
    absoluteTimeSeconds: 0,
    seed: 0,
    temporalMode: 'normal',
  };

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
  public get generation(): number { return this.generationValue; }
  public get state(): CloudStateBinding { return this.stateValue; }
  public setQuality(level: CloudQualityLevel): void { this.quality = level; }

  // 単位方向 direction での雲を、投影自身の uv で直に読む(cap の窓ぎめを通さない読み方)。
  public at(direction: Vec3Node): CloudSample { return this.field.at(direction); }
  public stateAt(direction: Vec3Node): CloudState {
    return this.field.stateAt(
      direction,
      this.stateValue.absoluteTimeSeconds,
      this.stateValue.seed,
      this.stateValue.temporalMode,
    );
  }

  // この場を焼く天気のモデル・気候・投影。prepare で焼いた中間場を読むときに使い、寿命はこのクラスが持つ。
  public get weatherModel(): WeatherModel { return this.model; }
  public get climateMap(): ClimateMap { return this.climate; }
  public get fieldProjection(): FieldProjection { return this.projection; }

  // 表示時刻の雲場を、天気の中間場から順に焼く。
  public prepare(renderer: WebGPURenderer, displayTime: number, gpu: GpuTimingSink | null, nowMs: number): void {
    // 気候画像の取得を始める。
    this.climate.request();
    const realFrameSeconds = this.lastRequestedWallTimeMs === null
      ? 0 : Math.max(0, nowMs - this.lastRequestedWallTimeMs) / 1000;
    const simulationDelta = simulationSecondsPerFrame(this.lastRequestedDisplayTime, displayTime);
    const temporal = temporalLodFor(simulationDelta, realFrameSeconds);
    const targetTime = targetSimulationTime(displayTime, temporal, splitSimulationTime(displayTime));
    // 次のフレームのLOD判定は、最後に要求した表示時刻から行う。bakeをrate limitした場合も
    // 間の時刻をcatch-upして大量に焼かない。
    this.lastRequestedDisplayTime = displayTime;
    this.lastRequestedWallTimeMs = nowMs;
    // 表示時刻・気候の入力・投影の置き方が前回と同じなら、焼いた場をそのまま使う。
    const climateGeneration = this.climate.generation;
    const projectionRevision = this.projection.revision;
    if (this.lastBakedDisplayTime === targetTime
      && this.lastBakedClimateGeneration === climateGeneration
      && this.lastBakedProjectionRevision === projectionRevision
      && this.lastBakedTemporalMode === temporal.mode) return;
    const maxBakesPerRealSecond = Math.min(
      temporal.maxBakesPerRealSecond,
      CLOUD_QUALITY[this.quality].maxFieldUpdatesPerSecond,
    );
    if (!canBakeInWindow(
      nowMs, this.bakeWindowStartMs, this.bakeCountInWindow,
      { ...temporal, maxBakesPerRealSecond },
    )) return;
    if (this.bakeWindowStartMs === null || nowMs - this.bakeWindowStartMs >= 1000) {
      this.bakeWindowStartMs = nowMs;
      this.bakeCountInWindow = 0;
    }
    // 天気の中間場から雲場まで順に焼く。
    this.model.syncTime(targetTime, temporal);
    this.model.bake(renderer, gpu ?? undefined);
    this.field.render(renderer, gpu ?? undefined);
    this.bakeCountInWindow += 1;
    this.generationValue += 1;
    this.lastBakedDisplayTime = targetTime;
    this.lastBakedClimateGeneration = climateGeneration;
    this.lastBakedProjectionRevision = projectionRevision;
    this.lastBakedTemporalMode = temporal.mode;
    this.stateValue = {
      absoluteTimeSeconds: targetTime,
      seed: Math.trunc(targetTime / (24 * 60 * 60)),
      temporalMode: temporal.mode,
    };
  }

  // 保持している雲場を解放する。
  public dispose(): void {
    this.field.dispose();
    this.model.dispose();
    this.climate.dispose();
  }
}
