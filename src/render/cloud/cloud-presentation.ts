// 1 天体ぶんの雲場と、表現 renderer へ渡す表示状態を束ねるゲーム境界。雲場の生成・焼き込みと
// 不透明表面 renderer の寿命をここで管理するが、大気・影 renderer の GPU 資源は所有しない。
import * as THREE from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { GeneratedCloudField } from './generated-cloud-field';
import {
  CUMULUS_DETAIL, OpaqueCloudSurfaceRenderer, type CumulusDetail,
} from '../opaque-cloud-surface-renderer';
import type { AtmosphereClouds } from '../atmosphere';
import type { ShadowCumulus } from '../pipeline/shadow/cloud-shadow-renderer';

export interface CloudPresentationSnapshot {
  readonly field: THREE.Texture;
  readonly topAltitude: number;
  readonly cloudsVisible: boolean;
  readonly surfaceVisible: boolean;
  readonly cirrusVisible: boolean;
  readonly translucentCumulusVisible: boolean;
}

export class CloudPresentation {
  private readonly surface: OpaqueCloudSurfaceRenderer;
  private cloudVisible = false;
  private cirrusVisible = true;
  private translucentCumulusVisible = true;

  public constructor(
    private readonly cloudField: GeneratedCloudField,
    bodyRadius: number,
  ) {
    this.surface = new OpaqueCloudSurfaceRenderer(cloudField.sampler, bodyRadius);
  }

  public get field(): THREE.Texture { return this.cloudField.texture; }
  public get visible(): boolean { return this.surface.visible; }
  public get cloudsVisible(): boolean { return this.cloudVisible; }
  public get topAltitude(): number { return this.surface.topAltitude; }

  // 1 フレームの三つの表現が同じ場と表示条件を見るための読み取り専用スナップショット。field は
  // texture の参照だけで、GPU 資源の所有権は GeneratedCloudField に残る。
  public snapshot(): CloudPresentationSnapshot {
    return {
      field: this.cloudField.texture,
      topAltitude: this.surface.topAltitude,
      cloudsVisible: this.cloudVisible,
      surfaceVisible: this.surface.visible,
      cirrusVisible: this.cirrusVisible,
      translucentCumulusVisible: this.translucentCumulusVisible,
    };
  }

  public atmosphereAt(bodyFromWorld: THREE.Matrix4): AtmosphereClouds | null {
    const snapshot = this.snapshot();
    if (!snapshot.cloudsVisible) return null;
    return { field: snapshot.field, bodyFromWorld: bodyFromWorld.clone() };
  }

  public shadowAt(
    center: THREE.Vector3, surfaceRadius: number, axes: THREE.Vector3, bodyFromWorld: THREE.Matrix4,
  ): ShadowCumulus | null {
    const snapshot = this.snapshot();
    if (!snapshot.cloudsVisible || !snapshot.surfaceVisible) return null;
    return {
      center: center.clone(), surfaceRadius, axes: axes.clone(), topAltitude: snapshot.topAltitude,
      bodyFromWorld: bodyFromWorld.clone(), field: snapshot.field,
    };
  }

  public addTo(parent: THREE.Object3D): void { this.surface.addTo(parent); }

  public setDetail(detail: CumulusDetail): void { this.surface.setDetail(detail); }

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

  public bake(renderer: WebGPURenderer, displayTime: number): void {
    if (!this.fieldContributes) return;
    this.cloudField.bake(renderer, displayTime);
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
