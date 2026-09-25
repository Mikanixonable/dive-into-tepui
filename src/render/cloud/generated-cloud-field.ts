// 気候から表示時刻の雲場を焼く所有者。二時刻キャッシュを補間して、時間加速や時刻ジャンプでも
// 同じ時刻問い合わせが同じ結果を返す。中間気象場は各キャッシュ時刻の生成時だけ焼き直す。
import * as THREE from 'three/webgpu';
import { mix, uniform } from 'three/tsl';
import { BakedField } from '../baked-field';
import { GPU_PASS } from '../gpu-timings';
import { CloudField } from './cloud-field';
import {
  cloudFieldTexelFromSample, cloudSampleFromTexel, type CloudSample,
} from './cloud-field-sample';
import { cloudTemporalCachePlan, cloudTemporalSampleTimes } from './cloud-quality';
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
  private timeA: number | null = null;
  private timeB: number | null = null;
  private cachedClimateGeneration: number | null = null;
  private cachedProjectionRevision: number | null = null;
  private lastPreparedDisplayTime: number | null = null;
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
      (direction) => mix(
        cloudFieldTexelFromSample(this.fieldA.at(direction)),
        cloudFieldTexelFromSample(this.fieldB.at(direction)),
        this.blendAtoB,
      ),
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
  }

  public prepare(renderer: WebGPURenderer, displayTime: number, gpu?: GpuTimingSink): void {
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
    if (this.lastPreparedDisplayTime === displayTime && !sourceChanged) return;

    const plan = cloudTemporalCachePlan(displayTime, this.qualityLevel, {
      timeA: this.timeA,
      timeB: this.timeB,
    });
    for (const write of plan.writes) {
      this.renderSlot(renderer, write.slot, write.timeSeconds, gpu);
    }
    this.blendAtoB.value = plan.blendAtoB;
    this.blended.render(renderer, gpu);
    this.model.syncTime(displayTime);
    this.generationValue += 1;
    this.lastPreparedDisplayTime = displayTime;
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
