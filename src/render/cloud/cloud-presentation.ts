// 1 天体ぶんの雲場と、表現 renderer へ渡す表示状態を束ねるゲーム境界。雲場の出どころ(生成/実写)を
// 選び、選んだ場の用意と不透明表面 renderer の寿命を管理する。
import * as THREE from 'three/webgpu';
import {
  CUMULUS_DETAIL, OpaqueCloudSurfaceRenderer, type CumulusDetail,
} from '../opaque-cloud-surface-renderer';
import { CLOUD_TOP_SPAN } from './cumulus-shape';
import { capRadiusFor } from './cloud-cap';
import type { WebGPURenderer } from 'three/webgpu';
import type { GpuTimingSink } from '../gpu-timings';
import type { CloudFieldBinding } from './cloud-field-sampler';
import type { OrthographicCap } from './field-projection';

// cap を置き直す前の向き。最初の syncResolved までしか使わないので、どの向きでもよい。
const INITIAL_CAP_DIRECTION = new THREE.Vector3(0, 0, 1);

// 雲場の出どころの種類。generated は気候から時々刻々焼く場、observed は衛星写真から分けた静止した場。
// 値は保存された描画設定を読む鍵なので動かさない。
export const CLOUD_FIELD_SOURCE_KIND = { observed: 'observed', generated: 'generated' } as const;
export type CloudFieldSourceKind = (typeof CLOUD_FIELD_SOURCE_KIND)[keyof typeof CLOUD_FIELD_SOURCE_KIND];

// 雲場の出どころ1つが供給するもの。texture は cap へ焼いた写しで、寿命は出どころが持つ。
export interface CloudFieldSource {
  readonly texture: THREE.Texture;
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
  // generated を読む。cap は両方が焼く先の置き方で、このクラスが毎フレーム置き直す。
  // bodyRadius は殻を載せる天体の基準半径 [m]。
  public constructor(
    generated: CloudFieldSource, observed: CloudFieldSource,
    private readonly cap: OrthographicCap, private readonly bodyRadius: number,
  ) {
    this.sources = { generated, observed };
    this.source = generated;
    this.surface = new OpaqueCloudSurfaceRenderer(bodyRadius);
    this.aim(INITIAL_CAP_DIRECTION, 1);
  }

  // 焼いた場と、それを焼いた cap の置き方の組。読み手はこれを自分の sampler へ写す。
  public get binding(): CloudFieldBinding {
    return { texture: this.source.texture, cap: this.cap.placement };
  }
  public get visible(): boolean { return this.surface.visible; }
  public get cloudsVisible(): boolean { return this.cloudVisible; }
  public get topAltitude(): number { return this.surface.topAltitude; }

  public addTo(parent: THREE.Object3D): void { this.surface.addTo(parent); }

  // 雲場の出どころを選ぶ。どちらの出どころも同じ cap へ焼くので、グラフは組み直さない。
  // **選び直したら結び直す** — 結び直さないと、不透明表面が前の出どころの写しを読み続ける。
  public setSource(kind: CloudFieldSourceKind): void {
    this.source = this.sources[kind];
    this.surface.bind(this.binding);
  }

  // cap を、天体固定・半軸で割った殻の空間で見た直下点 subpoint(単位方向)へ置き直す。
  // rho は同じ空間で測ったカメラの中心距離(地表が 1)。置き直したぶんは不透明表面の読み取りへ
  // すぐ写す — 写さないと、そのフレームだけ雲がテクスチャと 1 フレームずれる。
  public aim(subpoint: THREE.Vector3, rho: number): void {
    this.cap.aimAt(subpoint, capRadiusFor(rho, CLOUD_TOP_SPAN / this.bodyRadius));
    this.surface.bind(this.binding);
  }

  public setDetail(detail: CumulusDetail): void { this.surface.setDetail(detail); }

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
