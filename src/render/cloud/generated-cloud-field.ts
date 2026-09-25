// 気候から表示時刻の雲場を焼く所有者。二時刻キャッシュを補間して、時間加速や時刻ジャンプでも
// 同じ時刻問い合わせが同じ結果を返す。中間気象場は各キャッシュ時刻の生成時だけ焼き直す。
import * as THREE from 'three/webgpu';
import { dot, fract, mix, select, sin, uniform, vec3 } from 'three/tsl';
import { BakedField } from '../baked-field';
import { GPU_PASS } from '../gpu-timings';
import { CloudField } from './cloud-field';
import {
  cloudFieldTexelFromSample, cloudSampleFromTexel, type CloudSample,
} from './cloud-field-sample';
import {
  cloudTemporalAveragePlan,
  cloudTemporalCachePlan,
  cloudTemporalSampleTimes,
  cloudUsesTemporalAverage,
} from './cloud-quality';
import { WeatherModel } from './weather-model';
import type { WebGPURenderer } from 'three/webgpu';
import type { ClimateMap } from './climate-map';
import type { GpuTimingSink } from '../gpu-timings';
import type { FieldProjection } from '../field-projection';
import type { CloudFieldSource } from './cloud-presentation';
import type { FloatUniform, Vec3Node } from '../tsl-types';

export class GeneratedCloudField implements CloudFieldSource {
  private readonly model: WeatherModel;
  private readonly fieldA: CloudField;
  private readonly fieldB: CloudField;
  private readonly blended: BakedField;
  private readonly blendAtoB: FloatUniform = uniform(0);
  private readonly temporalAverageMode: FloatUniform = uniform(0);
  private timeA: number | null = null;
  private timeB: number | null = null;
  private cachedClimateGeneration: number | null = null;
  private cachedProjectionRevision: number | null = null;
  private lastPreparedDisplayTime: number | null = null;
  private lastPreparedTemporalExposure: number | null = null;
  private qualityLevel = 2;
  private generationValue = 0;

  public constructor(
    private readonly climate: ClimateMap, private readonly projection: FieldProjection,
    surfaceRadius: number, rotationPeriod: number,
  ) {
    this.model = new WeatherModel(climate, projection, surfaceRadius, rotationPeriod);
    this.fieldA = new CloudField(this.model, projection);
    this.fieldB = new CloudField(this.model, projection);
    this.blended = new BakedField(
      'cloud-temporal',
      THREE.RGBAFormat,
      projection,
      (direction) => {
        const a = cloudFieldTexelFromSample(this.fieldA.at(direction));
        const b = cloudFieldTexelFromSample(this.fieldB.at(direction));
        const interpolated = mix(a, b, this.blendAtoB);
        // 高速時間の平均は雲量・雲頂を直接平均せず、前半/後半の瞬間場のどちらかを
        // 天体固定の位置ごとに決定的に選ぶ。これにより後段の透過・影は必ず一つの瞬間場を評価する。
        const selector = fract(sin(dot(
          direction.mul(4096),
          vec3(12.9898, 78.233, 37.719),
        )).mul(43758.5453));
        const averaged = select(selector.lessThan(this.blendAtoB), b, a);
        return mix(interpolated, averaged, this.temporalAverageMode);
      },
      GPU_PASS.cloudBake,
    );
  }

  public get texture(): THREE.Texture { return this.blended.texture; }
  public get generation(): number { return this.generationValue; }

  public at(direction: Vec3Node): CloudSample {
    return cloudSampleFromTexel(this.blended.at(direction));
  }

  public get weatherModel(): WeatherModel { return this.model; }
  public get climateMap(): ClimateMap { return this.climate; }
  public get fieldProjection(): FieldProjection { return this.projection; }

  public setQuality(level: number): void {
    if (level === this.qualityLevel) return;
    // Validation and policy ownership live in cloud-quality.ts.
    cloudTemporalSampleTimes(0, level);
    this.qualityLevel = level;
    this.lastPreparedDisplayTime = null;
    this.lastPreparedTemporalExposure = null;
  }

  public prepare(
    renderer: WebGPURenderer,
    displayTime: number,
    gpu?: GpuTimingSink,
    temporalExposureSeconds = 0,
  ): void {
    this.climate.request();
    const climateGeneration = this.climate.generation;
    const projectionRevision = this.projection.revision;
    const sourceChanged = climateGeneration !== this.cachedClimateGeneration
      || projectionRevision !== this.cachedProjectionRevision;
    if (sourceChanged) {
      this.timeA = null;
      this.timeB = null;
      this.lastPreparedDisplayTime = null;
      this.cachedClimateGeneration = climateGeneration;
      this.cachedProjectionRevision = projectionRevision;
    }
    if (!Number.isFinite(temporalExposureSeconds) || temporalExposureSeconds < 0) {
      throw new RangeError('temporalExposureSeconds must be non-negative and finite');
    }
    if (
      this.lastPreparedDisplayTime === displayTime
      && this.lastPreparedTemporalExposure === temporalExposureSeconds
      && !sourceChanged
    ) return;

    const cacheState = { timeA: this.timeA, timeB: this.timeB };
    const temporalAverage = cloudUsesTemporalAverage(temporalExposureSeconds, this.qualityLevel);
    const plan = temporalAverage
      ? cloudTemporalAveragePlan(displayTime, temporalExposureSeconds, cacheState)
      : cloudTemporalCachePlan(displayTime, this.qualityLevel, cacheState);
    for (const write of plan.writes) {
      this.renderSlot(renderer, write.slot, write.timeSeconds, gpu);
    }
    this.blendAtoB.value = plan.blendAtoB;
    this.temporalAverageMode.value = temporalAverage ? 1 : 0;
    this.blended.render(renderer, gpu);
    this.model.syncTime(displayTime);
    this.generationValue += 1;
    this.lastPreparedDisplayTime = displayTime;
    this.lastPreparedTemporalExposure = temporalExposureSeconds;
  }

  private renderSlot(
    renderer: WebGPURenderer, slot: 'A' | 'B', timeSeconds: number, gpu?: GpuTimingSink,
  ): void {
    this.model.syncTime(timeSeconds);
    this.model.bake(renderer, gpu);
    if (slot === 'A') {
      this.fieldA.render(renderer, gpu);
      this.timeA = timeSeconds;
    } else {
      this.fieldB.render(renderer, gpu);
      this.timeB = timeSeconds;
    }
  }

  public dispose(): void {
    this.blended.dispose();
    this.fieldA.dispose();
    this.fieldB.dispose();
    this.model.dispose();
    this.climate.dispose();
  }
}
