// 天体ごとの雲テクスチャと表示状態を統括する境界クラス。雲データ供給源（生成／観測）を選択し、
// テクスチャの準備および雲面レンダラーの寿命を管理する。
import * as THREE from 'three/webgpu';
import { OpaqueCloudSurfaceRenderer, type CumulusDetail } from '../opaque-cloud-surface-renderer';
import { CLOUD_TOP_SPAN } from './cumulus-shape';
import type { CloudBlend, CloudFieldSlot } from './cloud-field-sample';
import { capRadiusFor, snapCap } from './cloud-cap';
import type { WebGPURenderer } from 'three/webgpu';
import type { GpuTimingSink } from '../gpu-timings';
import type { CloudDetailClockInput, CloudRenderInput } from './cloud-render-input';
import type { OrthographicCap } from '../field-projection';
import type { GraphicsSettingsData } from '../graphics-settings';

// aimFrom() で置き直すまでのキャップ初期向き。
const INITIAL_CAP_DIRECTION = new THREE.Vector3(0, 0, 1);

// aimFrom の書き込み先。
const tmpToObserver = new THREE.Vector3();
const tmpInverseSpin = new THREE.Quaternion();

// 雲データの供給源種別。generated は気候モデルから時々刻々生成する動的場、observed は衛星画像に基づく静止場。
// キー名は保存済み描画設定と対応するため変更しない。
export const CLOUD_FIELD_SOURCE_KIND = { observed: 'observed', generated: 'generated' } as const;
type CloudFieldSourceKind = (typeof CLOUD_FIELD_SOURCE_KIND)[keyof typeof CLOUD_FIELD_SOURCE_KIND];

// 雲データ供給源のインターフェース。slots はキャップへ投影された 2 枚の写しであり、供給元が寿命を管理する。
export interface CloudFieldSource {
  // 焼いた雲場の 2 枚(同じ cap)。雲は R・G = 積雲・巻雲、B・A = 筋の倍角ベクトル。風は R・G = 地表付近、
  // B・A = 上層の東・北の成分 [m/s]。環境は R = 陸、G = 対流、B = 気候の雲量、A = 金床。
  readonly slots: readonly [CloudFieldSlot, CloudFieldSlot];
  // 2 枚の混ぜ方。供給元が毎フレーム書き換えるので、読み手は読んだ時点の値を使う。
  readonly blend: CloudBlend;
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
  private cumulusVisible = true;
  private cirrusVisible = true;
  // 細部の時刻。bake で表示時刻へ進める。
  private clock: CloudDetailClockInput = { displayTime: 0, simSpeed: 0 };

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

  // 雲場の読み手へ渡す、いまの出どころの写しと cap の置き方・世代・雲頂高度。
  public get renderInput(): CloudRenderInput {
    return {
      field: {
        slots: this.source.slots,
        blend: this.source.blend,
        cap: this.cap.placement,
      },
      generation: this.source.generation,
      topAltitude: this.topAltitude,
      clock: this.clock,
    };
  }
  public get visible(): boolean { return this.surface.visible; }
  public get cloudsVisible(): boolean {
    return this.cloudVisible && (this.cumulusVisible || this.cirrusVisible);
  }
  public get cumulusEnabled(): boolean { return this.cloudsVisible && this.cumulusVisible; }
  public get cirrusEnabled(): boolean { return this.cloudsVisible && this.cirrusVisible; }
  public get topAltitude(): number { return this.surface.topAltitude; }

  public addTo(parent: THREE.Object3D): void { this.surface.addTo(parent); }

  // 描画設定のうち雲にかかわる項目と、見かけ直径 apparentDiameterPx [px] を表示状態へ反映する。
  public syncGraphics(graphics: GraphicsSettingsData, apparentDiameterPx: number): void {
    // 雲全体を描くかと、描くときの雲場の出どころ・積雲の精細さ・殻の分割段。
    this.setCloudsVisible(graphics.clouds);
    this.cumulusVisible = graphics.cumulus;
    this.cirrusVisible = graphics.cirrus;
    this.syncSurfaceVisibility();
    if (graphics.clouds) {
      this.setSource(graphics.cloudFieldSource);
      this.setDetail(graphics.cumulusDetail);
      this.syncLod(apparentDiameterPx);
    }
  }

  // 雲場の出どころを選ぶ。どちらの出どころも同じ cap へ焼くので、グラフは組み直さない。
  // **選び直したら結び直す** — 結び直さないと、不透明表面が前の出どころの写しを読み続ける。
  private setSource(kind: CloudFieldSourceKind): void {
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

  // cap を、天体固定・半軸で割った殻の空間で見た直下点 subpoint(単位方向)の近くの格子点へ置き直す。
  // rho は同じ空間で測った観測点の中心距離(地表が 1)。置き直した結果は不透明表面のサンプリングへ
  // 即座に反映する — 反映しないと、そのフレームだけ雲がテクスチャと 1 フレームずれる。
  // **置き方は地表に固定した格子へ揃える**(`snapCap`) — 直下点へ連続に置くと、texel の格子が
  // 地表に対して滑り、止まった雲がちらつく。
  private aim(subpoint: THREE.Vector3, rho: number): void {
    const latitude = Math.asin(Math.max(-1, Math.min(1, subpoint.y)));
    const longitude = Math.atan2(subpoint.x, subpoint.z);
    const snapped = snapCap(latitude, longitude, capRadiusFor(rho, CLOUD_TOP_SPAN / this.bodyRadius));
    this.cap.aim(snapped.latitude, snapped.longitude, snapped.radius);
    this.surface.bind(this.renderInput);
  }

  private setDetail(detail: CumulusDetail): void { this.surface.setDetail(detail); }

  // 雲全体を描くかを置き直す。偽なら不透明表面も隠す。
  public setCloudsVisible(visible: boolean): void {
    this.cloudVisible = visible;
    this.syncSurfaceVisibility();
  }

  private syncSurfaceVisibility(): void {
    if (!this.cloudVisible || !this.cumulusVisible) this.surface.hide();
  }

  // 見かけ直径 [px] から不透明表面の分割段を選ぶ。雲を描かないなら隠す。
  private syncLod(apparentDiameterPx: number): void {
    if (this.cumulusEnabled) this.surface.syncLod(apparentDiameterPx);
    else this.surface.hide();
  }

  // 雲場が描画に寄与するフレームで、選んでいる出どころの場を表示時刻 displayTime [s] へ焼き、細部の
  // 時刻を進める。simSpeed は実時間 1 秒あたりに進む表示時刻 [s]。gpu を渡すと、焼いた GPU 時間を
  // そこへ計上する。**実写の雲場では細部の時刻も止める** — 分布が止まっている空で、細部だけが
  // 流れたり入れ替わったりしない。
  public bake(renderer: WebGPURenderer, displayTime: number, simSpeed: number, gpu?: GpuTimingSink): void {
    if (!this.fieldContributes) return;
    this.source.prepare(renderer, displayTime, gpu);
    const moving = this.source === this.sources.generated;
    this.clock = { displayTime: moving ? displayTime : 0, simSpeed: moving ? simSpeed : 0 };
    this.surface.syncClock(this.clock);
  }

  // 不透明表面と、選べる雲場の出どころをすべて解放する。
  public dispose(): void {
    this.surface.dispose();
    for (const source of Object.values(this.sources)) source.dispose();
  }

  // 雲場がこのフレームの描画に寄与するか。巻雲は雲を描く限り常に大気へ立つので、
  // 雲が見える限り場は常に寄与する。
  private get fieldContributes(): boolean {
    return this.cloudsVisible;
  }
}
