// 1 天体ぶんの雲場と、表現 renderer へ渡す表示状態を束ねるゲーム境界。雲場の出どころ(生成/実写)を
// 選び、選んだ場の用意と不透明表面 renderer の寿命を管理する。
import * as THREE from 'three/webgpu';
import {
  CUMULUS_DETAIL, OpaqueCloudSurfaceRenderer, type CumulusDetail,
} from '../opaque-cloud-surface-renderer';
import type { WebGPURenderer } from 'three/webgpu';
import type { GpuTimingSink } from '../gpu-timings';
import type { CloudFieldSampler, CloudLodMode } from './cloud-field-sampler';

// 雲場の出どころの種類。generated は気候から時々刻々焼く場、observed は衛星写真から分けた静止した場。
// 値は保存された描画設定を読む鍵なので動かさない。
export const CLOUD_FIELD_SOURCE_KIND = { observed: 'observed', generated: 'generated' } as const;
export type CloudFieldSourceKind = (typeof CLOUD_FIELD_SOURCE_KIND)[keyof typeof CLOUD_FIELD_SOURCE_KIND];

// 雲場の出どころ1つが供給するもの。texture と sampler は同じ場を指し、寿命は出どころが持つ。
export interface CloudFieldSource {
  readonly texture: THREE.Texture;
  readonly sampler: CloudFieldSampler;
  // 表示時刻 displayTime [s] の場を読める状態にする。GPU で焼くなら、その時間を gpu へ計上する。
  prepare(renderer: WebGPURenderer, displayTime: number, gpu?: GpuTimingSink): void;
  // 保持している GPU 資源を解放する。
  dispose(): void;
}

export class CloudPresentation {
  private readonly surface: OpaqueCloudSurfaceRenderer;
  private readonly sources: Readonly<Record<CloudFieldSourceKind, CloudFieldSource>>;
  // いま読んでいる雲場の出どころ。
  private source: CloudFieldSource;
  private cloudVisible = false;
  private cirrusVisible = true;
  private translucentCumulusVisible = true;

  // generated と observed は選べる雲場の出どころで、どちらの寿命もこのクラスが引き取る。はじめは
  // generated を読む。bodyRadius は殻を載せる天体の基準半径 [m]。
  public constructor(generated: CloudFieldSource, observed: CloudFieldSource, bodyRadius: number) {
    this.sources = { generated, observed };
    this.source = generated;
    this.surface = new OpaqueCloudSurfaceRenderer(generated.sampler, bodyRadius);
  }

  public get field(): THREE.Texture { return this.source.texture; }
  public get visible(): boolean { return this.surface.visible; }
  public get cloudsVisible(): boolean { return this.cloudVisible; }
  public get topAltitude(): number { return this.surface.topAltitude; }

  public addTo(parent: THREE.Object3D): void { this.surface.addTo(parent); }

  // 雲場の出どころを選ぶ。変わったときだけ、不透明表面が読む場を張り替える。
  public setSource(kind: CloudFieldSourceKind): void {
    const source = this.sources[kind];
    if (source === this.source) return;
    this.source = source;
    this.surface.setFieldSampler(source.sampler);
  }

  public setDetail(detail: CumulusDetail): void { this.surface.setDetail(detail); }

  // 雲場の mip 段の選び方を切り替える(診断用)。いま読んでいる場の読み取りに効く。
  public setLodSampling(mode: CloudLodMode, fixedLevel = 0): void {
    this.surface.setLodSampling(mode, fixedLevel);
  }

  // 雲全体を描くかを置き直す。偽なら不透明表面も隠す。
  public setCloudsVisible(visible: boolean): void {
    this.cloudVisible = visible;
    if (!visible) this.surface.hide();
  }

  // 大気の中へ立てる巻雲と半透明の積雲を、それぞれ描くかを置き直す。
  public setAtmosphereCloudsVisible(cirrusVisible: boolean, translucentCumulusVisible: boolean): void {
    this.cirrusVisible = cirrusVisible;
    this.translucentCumulusVisible = translucentCumulusVisible;
  }

  // 見かけ直径 [px] から不透明表面の分割段を選ぶ。雲を描かないなら隠す。
  public syncLod(apparentDiameterPx: number): void {
    if (this.cloudVisible) this.surface.syncLod(apparentDiameterPx);
    else this.surface.hide();
  }

  // 雲場が絵に効くフレームだけ、選んでいる出どころの場を表示時刻へ用意する。
  public bake(renderer: WebGPURenderer, displayTime: number, gpu?: GpuTimingSink): void {
    if (!this.fieldContributes) return;
    this.source.prepare(renderer, displayTime, gpu);
  }

  // 不透明表面と、選べる雲場の出どころをすべて解放する。
  public dispose(): void {
    this.surface.dispose();
    for (const source of Object.values(this.sources)) source.dispose();
  }

  // 雲場がこのフレームの絵に効くか。雲を描き、不透明表面か大気の中の雲のどれかが見えているとき真。
  private get fieldContributes(): boolean {
    return this.cloudVisible && (
      this.visible || this.cirrusVisible || this.translucentCumulusVisible);
  }
}

export { CUMULUS_DETAIL };
