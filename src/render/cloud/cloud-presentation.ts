// 天体ごとの雲テクスチャと表示状態を統括する境界クラス。雲データ供給源（生成／観測）を選択し、
// テクスチャの準備および雲面レンダラーの寿命を管理する。
import * as THREE from 'three/webgpu';
import { OpaqueCloudSurfaceRenderer, type CumulusDetail } from '../opaque-cloud-surface-renderer';
import { CLOUD_TOP_SPAN } from './cumulus-shape';
import { capRadiusFor } from './cloud-cap';
import type { WebGPURenderer } from 'three/webgpu';
import type { GpuTimingSink } from '../gpu-timings';
import type { CloudRenderInput } from './cloud-render-input';
import type { CloudFieldKeyframes } from './cloud-field-sampler';
import type { OrthographicCap } from '../field-projection';
import type { GraphicsSettingsData } from '../graphics-settings';

// aimFrom() で置き直すまでのキャップ初期向き。
const INITIAL_CAP_DIRECTION = new THREE.Vector3(0, 0, 1);

// cap を置き直すとき、必要な半径に足す余白 [rad]。この分だけ大きい円板を置くので、cap の中心は
// ここに書いた角だけ観測点の直下点からずれても、必要な覆いを保つ。低軌道(高度 400 km)では直下点が
// 秒速約 0.07° 動くので、30 秒に 1 回程度の置き直しになる。texel の角は余白ぶんだけ粗くなる
// (400 km で約 7%)。
const CAP_REAIM_SLACK = (2 * Math.PI) / 180;

// aimFrom の書き込み先。
const tmpToObserver = new THREE.Vector3();
const tmpInverseSpin = new THREE.Quaternion();

// 雲データの供給源種別。generated は気候モデルから時々刻々生成する動的場、observed は衛星画像に基づく静止場。
// キー名は保存済み描画設定と対応するため変更しない。
export const CLOUD_FIELD_SOURCE_KIND = { observed: 'observed', generated: 'generated' } as const;
export type CloudFieldSourceKind = (typeof CLOUD_FIELD_SOURCE_KIND)[keyof typeof CLOUD_FIELD_SOURCE_KIND];

// 雲データ供給源のインターフェース。textures はキャップへ投影された、前後 2 キー時刻の
// 下層・上層のテクスチャと補間係数であり、供給元が寿命を管理する。
export interface CloudFieldSource {
  readonly textures: CloudFieldKeyframes;
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
  // いま cap に置いてある円板。中心は殻の空間での直下点(単位方向)、半径は角 [rad]。
  // 置き直した時点の記憶で、必要な覆いを満たす間は同じ置き方を保つ。
  private placedCap: { center: THREE.Vector3; radius: number } | null = null;
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

  // 雲場の読み手へ渡す、いまの出どころの写しと cap の置き方・世代・雲頂高度。
  // 場の実体と補間係数は、読み手が結ぶ時点の値を取る — この写しを組んでからそのフレームの
  // prepare が走る経路があるので、写しを取った時点の値で固定すると prepare 前の場に 1 フレーム
  // 戻ることがある。
  public get renderInput(): CloudRenderInput {
    const source = this.source;
    return {
      field: {
        get a() { return source.textures.a; },
        get b() { return source.textures.b; },
        get blend() { return source.textures.blend; },
        cap: this.cap.placement,
      },
      generation: source.generation,
      topAltitude: this.topAltitude,
    };
  }
  public get visible(): boolean { return this.surface.visible; }
  public get cloudsVisible(): boolean { return this.cloudVisible; }
  public get topAltitude(): number { return this.surface.topAltitude; }

  public addTo(parent: THREE.Object3D): void { this.surface.addTo(parent); }

  // 描画設定のうち雲にかかわる項目と、見かけ直径 apparentDiameterPx [px] を表示状態へ反映する。
  public syncGraphics(graphics: GraphicsSettingsData, apparentDiameterPx: number): void {
    // 雲全体を描くかと、描くときの雲場の出どころ・雲の細部の段・殻の分割段。
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
    // その時点で見えうる円板(地表の地平線 + 雲頂ぶん)と、場の遡り読みの余白を含む半径 [rad]。
    const neededRadius = capRadiusFor(rho, CLOUD_TOP_SPAN / this.bodyRadius);
    // **必要な円板が置いた円板に収まる間は置き直さない** — cap の置き方が変わると場の焼き直しが
    // 走る。収まるかは「中心どうしの角距離 + 必要な半径 ≤ 置いた半径」で厳密に見る: 読み手は
    // cap の外を「雲なし」で返すので、覆いの不足はそのまま円板の縁の雲を消す。
    // 必要な半径が π/2 に張り付く遠方では余白を足せず、中心が動くたび置き直すことになる。
    const placed = this.placedCap;
    if (placed === null || placed.center.angleTo(subpoint) + neededRadius > placed.radius) {
      // 置き直す半径は必要な半径に余白を足す。このぶん中心のずれを許し、置き直しの頻度を下げる。
      const radius = Math.min(Math.PI / 2, neededRadius + CAP_REAIM_SLACK);
      this.cap.aimAt(subpoint, radius);
      this.placedCap = { center: subpoint.clone(), radius };
    }
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
    // 焼き直しで場の差し替えや補間係数が進むので、不透明表面の結びをこの表示時刻のものへ写し直す。
    this.surface.bind(this.renderInput);
  }

  // 不透明表面と、選べる雲場の出どころをすべて解放する。
  public dispose(): void {
    this.surface.dispose();
    for (const source of Object.values(this.sources)) source.dispose();
  }

  // 雲場がこのフレームの描画に寄与するか。
  private get fieldContributes(): boolean {
    return this.cloudVisible && (
      this.visible || this.cirrusVisible || this.translucentCumulusVisible);
  }
}
