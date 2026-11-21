// 天体ごとの雲テクスチャと表示状態を統括する境界クラス。雲データ供給源（生成／観測）を選択し、
// テクスチャの準備および雲面レンダラーの寿命を管理する。
import * as THREE from 'three/webgpu';
import {
  CUMULUS_DETAIL, OpaqueCloudSurfaceRenderer, cumulusOctavesOf, type CumulusDetail,
} from './opaque-cloud-surface-renderer';
import { CIRRUS_DETAIL, DETAIL_WAVELENGTHS, cirrusOctavesOf, type CirrusDetail } from './cloud-detail';
import { CLOUD_TOP_SPAN } from './cumulus-shape';
import { capRadiusFor, snapCap } from './cloud-cap';
import {
  DETAIL_TIERS, footprintLevel,
  type CloudQualityGovernor, type CloudQualityReading,
} from './cloud-quality-governor';
import type { WebGPURenderer } from 'three/webgpu';
import type { GpuTimingSink } from '../../gpu-timings';
import type { CloudFieldSource, CloudFieldSourceKind } from './cloud-field-source';
import type { CloudDetailClockInput, CloudRenderInput } from './cloud-render-input';
import type { OrthographicCap } from '../../field-projection';
import type { GraphicsSettingsData } from '../../graphics-settings';

// aimFrom() で置き直すまでのキャップ初期向き。
const INITIAL_CAP_DIRECTION = new THREE.Vector3(0, 0, 1);

// 段の番号(0..2 = 粗・標準・精細)から積雲の段名への写し。巻雲は段番号がそのまま段名の値。
const CUMULUS_BY_TIER = [CUMULUS_DETAIL.coarse, CUMULUS_DETAIL.standard, CUMULUS_DETAIL.fine] as const;
// 積雲の段ごとのオクターブ数(番号 0..2)。数はマテリアルの組み分けと同じ表から引く。
const CUMULUS_TIER_OCTAVES = CUMULUS_BY_TIER.map(cumulusOctavesOf);
// 巻雲の段ごとのオクターブ数(番号 0..2)と、巻雲が使う段の波長。巻雲は 32・16 km の段を
// 持たない(cloud-detail.ts の CIRRUS_FIRST_OCTAVE)。
const CIRRUS_TIER_OCTAVES = [CIRRUS_DETAIL.coarse, CIRRUS_DETAIL.standard, CIRRUS_DETAIL.fine]
  .map(cirrusOctavesOf);
const CIRRUS_WAVELENGTHS = DETAIL_WAVELENGTHS.slice(2);

// aimFrom の書き込み先。
const tmpToObserver = new THREE.Vector3();
const tmpInverseSpin = new THREE.Quaternion();

// 実効段の決定を読み出し用の形へ写す。実効が設定と同じなら 'setting'、それより
// 下なら小さい方の上限が決め手(同値なら footprint — 構造的な上限を優先して示す)。
function qualityReadingOf(
  quality: { readonly setting: number; readonly footprint: number; readonly effective: number },
  budget: number,
): CloudQualityReading {
  const { setting, effective } = quality;
  if (effective >= setting) return { setting, effective, limiter: 'setting' };
  return {
    setting, effective,
    limiter: quality.footprint <= budget ? 'footprint' : 'budget',
  };
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
  // 品質適応の予算上限の状態機械。null の間は予算上限が効かない(設定とフットプリント
  // 上限だけで実効段を決める)。
  private governor: CloudQualityGovernor | null = null;
  // 直近の aim() で置いた観測点の中心距離(地表 1)。フットプリント上限が読む。
  private observerRho = 1;
  // 実効の精細さ。renderInput へ段数として載せ、表面・大気・雲影が同じ値を読む。
  private effectiveCumulus: CumulusDetail = CUMULUS_DETAIL.standard;
  private effectiveCirrus: CirrusDetail = CIRRUS_DETAIL.standard;
  // 直近に実効段を決めたときの、雲種ごとの設定・フットプリント上限・実効の段番号と
  // 共通の予算上限。実効段の表示が「何で決まったか」を出すために覚える。
  private quality: {
    cumulus: { readonly setting: number; readonly footprint: number; readonly effective: number };
    cirrus: { readonly setting: number; readonly footprint: number; readonly effective: number };
    readonly budget: number;
  } = {
    cumulus: { setting: DETAIL_TIERS - 1, footprint: DETAIL_TIERS - 1, effective: DETAIL_TIERS - 1 },
    cirrus: { setting: DETAIL_TIERS - 1, footprint: DETAIL_TIERS - 1, effective: DETAIL_TIERS - 1 },
    budget: DETAIL_TIERS - 1,
  };

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

  // 雲場の読み手へ渡す、いまの出どころの写しと cap の置き方・雲頂高度。
  public get renderInput(): CloudRenderInput {
    // 同じ供給源の場・cap 配置・表示時刻・実効の段数を描画入力へそろえる。
    return {
      field: {
        slots: this.source.slots,
        blend: this.source.blend,
        cap: this.cap.placement,
      },
      topAltitude: this.topAltitude,
      clock: this.clock,
      cumulusOctaves: cumulusOctavesOf(this.effectiveCumulus),
      cirrusOctaves: cirrusOctavesOf(this.effectiveCirrus),
    };
  }
  public get visible(): boolean { return this.surface.visible; }
  // 雲全体と、少なくとも一方の雲種が有効なとき表示可能とする。
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
      // 実効の精細さ = min(設定, フットプリント上限, 予算上限)。設定の段は上限として扱う —
      // 解像できない細かさと、フレーム枠に収まらない細かさは段を落として品質を守る。
      const spanMin = this.minPixelSpan(apparentDiameterPx);
      const budget = this.governor?.levelCap ?? DETAIL_TIERS - 1;
      const footprintCumulus = footprintLevel(spanMin, CUMULUS_TIER_OCTAVES, DETAIL_WAVELENGTHS);
      const footprintCirrus = footprintLevel(spanMin, CIRRUS_TIER_OCTAVES, CIRRUS_WAVELENGTHS);
      const cumulusTier = Math.min(graphics.cumulusDetail - 1, footprintCumulus, budget);
      const cirrusTier = Math.min(graphics.cirrusDetail, footprintCirrus, budget);
      this.quality = {
        cumulus: {
          setting: graphics.cumulusDetail - 1, footprint: footprintCumulus, effective: cumulusTier,
        },
        cirrus: {
          setting: graphics.cirrusDetail, footprint: footprintCirrus, effective: cirrusTier,
        },
        budget,
      };
      this.effectiveCumulus = CUMULUS_BY_TIER[cumulusTier]!;
      this.effectiveCirrus = cirrusTier as CirrusDetail;
      this.setDetail(this.effectiveCumulus);
      this.syncLod(apparentDiameterPx);
    }
  }

  // 直下点で1画素が張る実寸 [m]。天体の見かけ直径 2R [m] が diamPx [px] になるので、
  // 1画素は中心距離で 2R/diamPx [m] を張り、直下点は中心距離の (rho−1)/rho 倍だけ近い。
  private minPixelSpan(apparentDiameterPx: number): number {
    return 2 * this.bodyRadius * (this.observerRho - 1)
      / (this.observerRho * Math.max(apparentDiameterPx, 1));
  }

  // 品質適応の予算上限の状態機械を結ぶ。結ばない間は予算上限が効かない。
  public setQualityGovernor(governor: CloudQualityGovernor): void { this.governor = governor; }

  // 実効の精細さと、その決定に効いた上限(段番号 0..2 = 粗・標準・精細)。
  // 実効段の表示が「設定・フットプリント・予算のどれで決まったか」を読む。
  public get cloudQuality(): {
    readonly cumulus: CloudQualityReading;
    readonly cirrus: CloudQualityReading;
  } {
    return {
      cumulus: qualityReadingOf(this.quality.cumulus, this.quality.budget),
      cirrus: qualityReadingOf(this.quality.cirrus, this.quality.budget),
    };
  }

  // 雲場の出どころを選ぶ。どちらの出どころも同じ cap へ焼くので、グラフは組み直さない。
  // **選び直したら結び直す** — 結び直さないと、不透明表面が前の出どころの写しを読み続ける。
  private setSource(kind: CloudFieldSourceKind): void {
    this.source = this.sources[kind];
    this.surface.bind(this.renderInput.field);
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
    this.observerRho = rho;
    const latitude = Math.asin(Math.max(-1, Math.min(1, subpoint.y)));
    const longitude = Math.atan2(subpoint.x, subpoint.z);
    const snapped = snapCap(latitude, longitude, capRadiusFor(rho, CLOUD_TOP_SPAN / this.bodyRadius));
    this.cap.aim(snapped.latitude, snapped.longitude, snapped.radius);
    this.surface.bind(this.renderInput.field);
  }

  private setDetail(detail: CumulusDetail): void { this.surface.setDetail(detail); }

  // 積雲の精細さの段を置き直す。マテリアルは段ごとに組んであるので、シェーダの組み直しは
  // 起きない。品質適応(実効段)と、段ごとのマテリアルの事前コンパイルがここを通る。
  public setCumulusDetail(detail: CumulusDetail): void { this.surface.setDetail(detail); }

  // いま不透明表面へ張っている精細さの段。
  public get cumulusDetail(): CumulusDetail { return this.surface.detail; }

  // 雲全体を描くかを置き直す。偽なら不透明表面も隠す。
  // 天体固定で見た太陽直下点の経度 [rad] を生成系へ渡す。暦を持つ呼び出し側がフレームごとに
  // 渡し、null で生成側の既定の太陽へ戻す。実写の場は時刻を持たないので何もしない。
  public setSolarLongitude(rad: number | null): void {
    this.sources.generated.setSolarLongitude?.(rad);
  }

  public setCloudsVisible(visible: boolean): void {
    this.cloudVisible = visible;
    this.syncSurfaceVisibility();
  }

  // 積雲が無効なら不透明な雲殻を隠す。
  private syncSurfaceVisibility(): void {
    if (!this.cumulusEnabled) this.surface.hide();
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
    // 巻雲は雲を描く限り常に大気へ立つので、雲が見える限り場は常に寄与する。
    if (!this.cloudsVisible) return;
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
}
