// 天体ごとの雲テクスチャと表示状態を統括する境界クラス。雲データ供給源（生成／観測）を選択し、
// テクスチャの準備および雲面レンダラーの寿命を管理する。
import * as THREE from 'three/webgpu';
import { OpaqueCloudSurfaceRenderer, type CumulusDetail } from '../opaque-cloud-surface-renderer';
import { CLOUD_TOP_SPAN } from './cumulus-shape';
import { capRadiusFor } from './cloud-cap';
import { v3 } from '../../math/vec3';
import type { WebGPURenderer } from 'three/webgpu';
import type { GpuTimingSink } from '../gpu-timings';
import type { CloudRenderInput } from './cloud-render-input';
import type { OrthographicCap } from '../field-projection';
import type { GraphicsSettingsData } from '../graphics-settings';
import type { CloudFieldDetailTileBinding } from './cloud-field-sampler';
import type { CloudLocalFieldBinding } from './cloud-local-field';
import type { CloudLocalFieldBaker } from './cloud-local-field-baker';

// aimFrom() で置き直すまでのキャップ初期向き。
const INITIAL_CAP_DIRECTION = new THREE.Vector3(0, 0, 1);

// aimFrom の書き込み先。
const tmpToObserver = new THREE.Vector3();
const tmpInverseSpin = new THREE.Quaternion();

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

// sampler へ注入する局所タイル。cap は視点中心へ動かし、texture は設定元が寿命を持つ。
export interface CloudPresentationDetailTile {
  readonly texture: THREE.Texture;
  readonly cap: OrthographicCap;
  readonly radius: number; // [rad]
  readonly blendStartCos: number;
  readonly composition?: CloudFieldDetailTileBinding['composition'];
}

export class CloudPresentation {
  private readonly surface: OpaqueCloudSurfaceRenderer;
  private readonly sources: Readonly<Record<CloudFieldSourceKind, CloudFieldSource>>;
  // 現在選択されている雲データ供給源。
  private source: CloudFieldSource;
  private sourceKind: CloudFieldSourceKind = CLOUD_FIELD_SOURCE_KIND.generated;
  private cloudVisible = false;
  private cirrusVisible = true;
  private translucentCumulusVisible = true;
  private detailTile: CloudPresentationDetailTile | null = null;
  private localField: CloudLocalFieldBinding | null = null;

  // 各供給源（generated / observed）を管理し、キャップの視点追従と雲メッシュの描画を同期する。
  // bodyRadius は雲層を配置する天体の基準半径 [m]。localFieldBaker は生成場へ載せる局所光学場の
  // 再焼を担い、null なら syncGraphics へ注入された場だけを使う。所有権はここへ移る。
  public constructor(
    generated: CloudFieldSource, observed: CloudFieldSource,
    private readonly cap: OrthographicCap, private readonly bodyRadius: number,
    private readonly localFieldBaker: CloudLocalFieldBaker | null = null,
  ) {
    this.sources = { generated, observed };
    this.source = generated;
    this.surface = new OpaqueCloudSurfaceRenderer(bodyRadius);
    this.aim(INITIAL_CAP_DIRECTION, 1);
  }

  // 雲場の読み手へ渡す、いまの出どころの写しと cap の置き方・世代・雲頂高度。
  public get renderInput(): CloudRenderInput {
    const detailTile: CloudFieldDetailTileBinding | null = this.sourceKind !== CLOUD_FIELD_SOURCE_KIND.generated
      || this.detailTile === null ? null : {
        texture: this.detailTile.texture,
        cap: this.detailTile.cap.placement,
        blendStartCos: this.detailTile.blendStartCos,
        composition: this.detailTile.composition,
      };
    // 局所光学場も detailTile と同じ門を通す — observed 供給源は体積場を持たない。
    // syncGraphics へ注入された場を優先し、無ければ焼き上げ済みの場を使う。
    const localField = this.sourceKind === CLOUD_FIELD_SOURCE_KIND.generated
      ? this.localField ?? this.localFieldBaker?.binding ?? null
      : null;
    return {
      field: { texture: this.source.texture, cap: this.cap.placement, detailTile, localField },
      generation: this.source.generation,
      topAltitude: this.topAltitude,
    };
  }
  public get visible(): boolean { return this.surface.visible; }
  public get cloudsVisible(): boolean { return this.cloudVisible; }
  public get topAltitude(): number { return this.surface.topAltitude; }

  public addTo(parent: THREE.Object3D): void { this.surface.addTo(parent); }

  // 描画設定のうち雲にかかわる項目と、見かけ直径 apparentDiameterPx [px] を表示状態へ反映する。
  // localField は生成場へ差し込む局所光学場で、三経路が同じ写しを読む。
  public syncGraphics(
    graphics: GraphicsSettingsData, apparentDiameterPx: number,
    detailTile: CloudPresentationDetailTile | null = null,
    localField: CloudLocalFieldBinding | null = null,
  ): void {
    this.detailTile = detailTile;
    this.localField = localField;
    if (detailTile !== null) detailTile.cap.aimAt(this.cap.placement.center, detailTile.radius);
    // 雲全体を描くかと、描くときの雲場の出どころ・積雲の精細さ・殻の分割段。
    this.setCloudsVisible(graphics.clouds);
    if (graphics.clouds) {
      this.setSource(graphics.cloudFieldSource);
      this.setDetail(graphics.cumulusDetail);
      this.syncLod(apparentDiameterPx);
    }
    // 大気の中へ立てる巻雲と半透明の積雲。
    this.setAtmosphereCloudsVisible(
      graphics.clouds && graphics.cirrus,
      graphics.clouds && graphics.translucentCumulus,
    );
  }

  // 雲場の出どころを選ぶ。どちらの出どころも同じ cap へ焼くので、グラフは組み直さない。
  // **選び直したら結び直す** — 結び直さないと、不透明表面が前の出どころの写しを読み続ける。
  private setSource(kind: CloudFieldSourceKind): void {
    this.sourceKind = kind;
    this.source = this.sources[kind];
    this.surface.bind(this.renderInput);
  }

  // cap を、描画座標の観測点 observer から見た直下点へ置き直す。center・spin・axes は殻を持つ天体の
  // 中心・自転姿勢・半軸(どれも描画座標)。**殻の空間で測る** — 天体固定のまま取ると、扁平のぶん
  // (地球で最大 0.19 度)中心が読み手の空間と食い違う。
  public aimFrom(
    observer: THREE.Vector3, center: THREE.Vector3, spin: THREE.Quaternion, axes: THREE.Vector3,
  ): void {
    const toObserver = tmpToObserver.subVectors(observer, center)
      .applyQuaternion(tmpInverseSpin.copy(spin).invert())
      .divide(axes);
    const rho = toObserver.length();
    if (!(rho > 0)) return;
    this.aim(toObserver.divideScalar(rho), rho);
  }

  // cap を、天体固定・半軸で割った殻の空間で見た直下点 subpoint(単位方向)へ置き直す。
  // rho は同じ空間で測った観測点の中心距離(地表が 1)。置き直した結果は不透明表面のサンプリングへ
  // 即座に反映する — 反映しないと、そのフレームだけ雲がテクスチャと 1 フレームずれる。
  private aim(subpoint: THREE.Vector3, rho: number): void {
    this.cap.aimAt(subpoint, capRadiusFor(rho, CLOUD_TOP_SPAN / this.bodyRadius));
    this.detailTile?.cap.aimAt(subpoint, this.detailTile.radius);
    this.surface.bind(this.renderInput);
  }

  private setDetail(detail: CumulusDetail): void { this.surface.setDetail(detail); }

  // 雲全体を描くかを置き直す。偽なら不透明表面も隠す。
  public setCloudsVisible(visible: boolean): void {
    this.cloudVisible = visible;
    if (!visible) this.surface.hide();
  }

  // 大気の中へ立てる巻雲と半透明の積雲を、それぞれ描くかを置き直す。
  private setAtmosphereCloudsVisible(cirrusVisible: boolean, translucentCumulusVisible: boolean): void {
    this.cirrusVisible = cirrusVisible;
    this.translucentCumulusVisible = translucentCumulusVisible;
  }

  // 見かけ直径 [px] から不透明表面の分割段を選ぶ。雲を描かないなら隠す。
  private syncLod(apparentDiameterPx: number): void {
    if (this.cloudVisible) this.surface.syncLod(apparentDiameterPx);
    else this.surface.hide();
  }

  // 雲場が描画に寄与するフレームで、選んでいる出どころの場を表示時刻 displayTime [s] へ焼く。gpu を
  // 渡すと、焼いた GPU 時間をそこへ計上する。
  public bake(renderer: WebGPURenderer, displayTime: number, gpu?: GpuTimingSink): void {
    if (!this.fieldContributes) return;
    this.source.prepare(renderer, displayTime, gpu);
    // 局所場の中心は直近の aimFrom が置いた cap の中心 — 最大1フレーム遅れだが許容する。
    const center = this.cap.placement.center;
    this.localFieldBaker?.maybeRebuild(displayTime, v3(center.x, center.y, center.z));
  }

  // 不透明表面と、選べる雲場の出どころ・局所場の焼き器をすべて解放する。
  public dispose(): void {
    this.surface.dispose();
    for (const source of Object.values(this.sources)) source.dispose();
    this.localFieldBaker?.dispose();
  }

  // 雲場がこのフレームの描画に寄与するか。
  private get fieldContributes(): boolean {
    return this.cloudVisible && (
      this.visible || this.cirrusVisible || this.translucentCumulusVisible);
  }
}
