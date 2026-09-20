// 天体ごとの雲テクスチャと表示状態を統括する境界クラス。雲データ供給源（生成／観測）を選択し、
// テクスチャの準備および雲面レンダラーの寿命を管理する。
import * as THREE from 'three/webgpu';
import {
  CUMULUS_DETAIL, OpaqueCloudSurfaceRenderer, type CumulusDetail,
} from '../opaque-cloud-surface-renderer';
import { CLOUD_TOP_SPAN } from './cumulus-shape';
import { capRadiusFor } from './cloud-cap';
import type { WebGPURenderer } from 'three/webgpu';
import type { GpuTimingSink } from '../gpu-timings';
import type { CloudRenderInput } from './cloud-render-input';
import type { OrthographicCap } from './field-projection';

// aim() による初回更新までのキャップ初期向き。
const INITIAL_CAP_DIRECTION = new THREE.Vector3(0, 0, 1);

// 雲データの供給源種別。generated は気候モデルから時々刻々生成する動的場、observed は衛星画像に基づく静止場。
// キー名は保存済み描画設定と対応するため変更しない。
export const CLOUD_FIELD_SOURCE_KIND = { observed: 'observed', generated: 'generated' } as const;
export type CloudFieldSourceKind = (typeof CLOUD_FIELD_SOURCE_KIND)[keyof typeof CLOUD_FIELD_SOURCE_KIND];

// 雲データ供給源のインターフェース。texture はキャップへ投影されたテクスチャであり、供給元が寿命を管理する。
export interface CloudFieldSource {
  readonly texture: THREE.Texture;
  // prepare() で更新されたテクスチャの世代番号。未準備時は 0。
  readonly generation: number;
  // 表示時刻 displayTime [s] のテクスチャを準備する。GPU 生成時間は gpu 計測へ計上する。
  prepare(renderer: WebGPURenderer, displayTime: number, gpu?: GpuTimingSink): void;
  // 保持している GPU 資源を解放する。
  dispose(): void;
}

export class CloudPresentation {
  private readonly surface: OpaqueCloudSurfaceRenderer;
  private readonly sources: Readonly<Record<CloudFieldSourceKind, CloudFieldSource>>;
  // 現在選択されている雲データ供給源。
  private source: CloudFieldSource;
  private cloudVisible = false;
  private cirrusVisible = true;
  private translucentCumulusVisible = true;

  // 各供給源（generated / observed）を管理し、キャップの視点追従と雲メッシュの描画を同期する。
  // bodyRadius は雲層を配置する天体の基準半径 [m]。
  public constructor(
    generated: CloudFieldSource, observed: CloudFieldSource,
    private readonly cap: OrthographicCap, private readonly bodyRadius: number,
  ) {
    this.sources = { generated, observed };
    this.source = generated;
    this.surface = new OpaqueCloudSurfaceRenderer(bodyRadius);
    this.aim(INITIAL_CAP_DIRECTION, 1);
  }

  public get renderInput(): CloudRenderInput {
    return {
      field: { texture: this.source.texture, cap: this.cap.placement },
      generation: this.source.generation,
      topAltitude: this.topAltitude,
    };
  }
  public get visible(): boolean { return this.surface.visible; }
  public get cloudsVisible(): boolean { return this.cloudVisible; }
  public get topAltitude(): number { return this.surface.topAltitude; }

  public addTo(parent: THREE.Object3D): void { this.surface.addTo(parent); }

  // 雲場の出どころを選ぶ。どちらの出どころも同じ cap へ焼くので、グラフは組み直さない。
  // **選び直したら結び直す** — 結び直さないと、不透明表面が前の出どころの写しを読み続ける。
  public setSource(kind: CloudFieldSourceKind): void {
    this.source = this.sources[kind];
    this.surface.bind(this.renderInput);
  }

  // cap を、天体固定・半軸で割った殻の空間で見た直下点 subpoint(単位方向)へ置き直す。
  // rho は同じ空間で測ったカメラの中心距離(地表が 1)。置き直したぶんは不透明表面の読み取りへ
  // すぐ写す — 写さないと、そのフレームだけ雲がテクスチャと 1 フレームずれる。
  public aim(subpoint: THREE.Vector3, rho: number): void {
    this.cap.aimAt(subpoint, capRadiusFor(rho, CLOUD_TOP_SPAN / this.bodyRadius));
    this.surface.bind(this.renderInput);
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
