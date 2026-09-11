// 1 天体ぶんの雲場と、表現 renderer へ渡す表示状態を束ねるゲーム境界。雲場の生成・焼き込みと
// 不透明表面 renderer の寿命をここで管理するが、大気・影 renderer の GPU 資源は所有しない。
import * as THREE from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import type { GpuTimingSink } from '../gpu-timings';
import { GeneratedCloudField } from './generated-cloud-field';
import {
  CUMULUS_DETAIL, OpaqueCloudSurfaceRenderer, type CumulusDetail,
} from '../opaque-cloud-surface-renderer';
import type { CloudLodMode } from './cloud-field-sampler';

export class CloudPresentation {
  private readonly surface: OpaqueCloudSurfaceRenderer;
  private cloudVisible = false;
  private cirrusVisible = true;
  private translucentCumulusVisible = true;

  public constructor(
    private readonly cloudField: GeneratedCloudField,
    bodyRadius: number,
    private readonly climateEpochUnixSec: number | null = null,
  ) {
    this.surface = new OpaqueCloudSurfaceRenderer(cloudField.sampler, bodyRadius);
  }

  public get field(): THREE.Texture { return this.cloudField.texture; }
  public get visible(): boolean { return this.surface.visible; }
  public get cloudsVisible(): boolean { return this.cloudVisible; }
  public get topAltitude(): number { return this.surface.topAltitude; }

  public addTo(parent: THREE.Object3D): void { this.surface.addTo(parent); }

  public setDetail(detail: CumulusDetail): void { this.surface.setDetail(detail); }

  public setLodSampling(mode: CloudLodMode, fixedLevel = 0): void {
    this.surface.setLodSampling(mode, fixedLevel);
  }

  public setCloudsVisible(visible: boolean): void {
    this.cloudVisible = visible;
    if (!visible) this.surface.hide();
  }

  public setAtmosphereCloudsVisible(cirrusVisible: boolean, translucentCumulusVisible: boolean): void {
    this.cirrusVisible = cirrusVisible;
    this.translucentCumulusVisible = translucentCumulusVisible;
  }

  public syncLod(apparentDiameterPx: number): void {
    if (this.cloudVisible) this.surface.syncLod(apparentDiameterPx);
    else this.surface.hide();
  }

  public bake(renderer: WebGPURenderer, displayTime: number, gpu?: GpuTimingSink): void {
    if (!this.fieldContributes) return;
    if (this.climateEpochUnixSec !== null) {
      this.cloudField.syncClimateTime(this.climateEpochUnixSec + displayTime);
    }
    this.cloudField.bake(renderer, displayTime, gpu);
  }

  public dispose(): void {
    this.surface.dispose();
    this.cloudField.dispose();
  }

  private get fieldContributes(): boolean {
    return this.cloudVisible && (
      this.visible || this.cirrusVisible || this.translucentCumulusVisible);
  }
}

export { CUMULUS_DETAIL };
