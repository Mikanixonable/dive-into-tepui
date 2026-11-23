// 天体ごとの雲テクスチャと表示状態を統括する境界クラス。雲データ供給源（生成／観測）を選択し、
// テクスチャの準備および雲面レンダラーの寿命を管理する。
import * as THREE from 'three/webgpu';
import { OpaqueCloudSurfaceRenderer, type CumulusSampling } from './opaque-cloud-surface-renderer';
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

// 段の番号(0..2 = 粗・標準・精細)ごとの、自動適応が積雲の標本の配り方を下げる先の組。いちばん粗い組は
// march を 1 本にして refine で補う — 粗い刻みを 2 本以上にすると、手前と奥で拾った雲頂が 2 枚の層に重なって見える。
// 巻雲は段番号がそのまま段名の値。
const CUMULUS_TIER_SAMPLING: readonly CumulusSampling[] = [
  { march: 1, refine: 5, octaves: 4 },
  { march: 6, refine: 3, octaves: 6 },
  { march: 12, refine: 3, octaves: 8 },
];
// 積雲の段ごとのオクターブ数(番号 0..2)。
const CUMULUS_TIER_OCTAVES = CUMULUS_TIER_SAMPLING.map((sampling) => sampling.octaves);
// 巻雲の段番号の表示名。
const CIRRUS_TIER_LABELS: readonly string[] = ['粗', '標準', '精細'];

// 巻雲の段番号 tier の表示名。
function cirrusTierLabel(tier: number): string {
  return CIRRUS_TIER_LABELS[tier] ?? String(tier);
}
// 巻雲の段ごとのオクターブ数(番号 0..2)と、巻雲が使う段の波長。巻雲は 32・16 km の段を
// 持たない(cloud-detail.ts の CIRRUS_FIRST_OCTAVE)。
const CIRRUS_TIER_OCTAVES = [CIRRUS_DETAIL.coarse, CIRRUS_DETAIL.standard, CIRRUS_DETAIL.fine]
  .map(cirrusOctavesOf);
const CIRRUS_WAVELENGTHS = DETAIL_WAVELENGTHS.slice(2);

// aimFrom の書き込み先。
const tmpToObserver = new THREE.Vector3();
const tmpInverseSpin = new THREE.Quaternion();

// 設定の標本の配り方 setting を、段の組 cap より重くならないよう下げた配り方。刻みと細部の段数は小さいほうを
// 取り、刻みを下げたときは二分の回数を cap の値にする(粗い刻みは二分で補う)。
function cappedSampling(setting: CumulusSampling, cap: CumulusSampling): CumulusSampling {
  return {
    march: Math.min(setting.march, cap.march),
    refine: setting.march > cap.march ? cap.refine : setting.refine,
    octaves: Math.min(setting.octaves, cap.octaves),
  };
}

// 2 つの標本の配り方が同じか。
function sameSampling(a: CumulusSampling, b: CumulusSampling): boolean {
  return a.march === b.march && a.refine === b.refine && a.octaves === b.octaves;
}

// 標本の配り方の表示名(刻み・二分・細部の段数)。
function samplingLabel(sampling: CumulusSampling): string {
  return `${sampling.march}·${sampling.refine}·${sampling.octaves}`;
}

// 実効の値の決定を読み出し用の形へ写す。lowered が偽なら 'setting'、真なら小さい方の上限が決め手
// (同値なら footprint — 構造的な上限を優先して示す)。
function qualityReadingOf(
  setting: string, effective: string, lowered: boolean, footprint: number, budget: number,
): CloudQualityReading {
  if (!lowered) return { setting, effective, limiter: 'setting' };
  return { setting, effective, limiter: footprint <= budget ? 'footprint' : 'budget' };
}

export class CloudPresentation {
  private readonly surface: OpaqueCloudSurfaceRenderer;
  private readonly sources: Readonly<Record<CloudFieldSourceKind, CloudFieldSource>>;
  // 現在選択されている雲データ供給源。
  private source: CloudFieldSource;
  // 描画設定が雲全体・雲種ごとに描くと決めているか。実際に描くかは cloudsVisible と雲種ごとの
  // *Visible が設定を合成して答える。
  private cloudsEnabled = false;
  private cumulusEnabled = true;
  private cirrusEnabled = true;
  // 細部の時刻。bake で表示時刻へ進める。
  private clock: CloudDetailClockInput = { displayTime: 0, simSpeed: 0 };
  // 品質適応の予算上限の状態機械。null の間は予算上限が効かない(設定とフットプリント
  // 上限だけで実効段を決める)。
  private governor: CloudQualityGovernor | null = null;
  // 直近の aim() で置いた観測点の中心距離(地表 1)。フットプリント上限が読む。
  private observerRho = 1;
  // 実効の精細さ。renderInput へ段数として載せ、表面・大気・雲影が同じ値を読む。
  private effectiveCirrus: CirrusDetail = CIRRUS_DETAIL.standard;
  // 直近に実効の値を決めたときの、雲種ごとの読み出し。実効の値の表示が「何で決まったか」を出すために覚える。
  private quality: { cumulus: CloudQualityReading; cirrus: CloudQualityReading } = {
    cumulus: { setting: '', effective: '', limiter: 'setting' },
    cirrus: { setting: '', effective: '', limiter: 'setting' },
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
      cumulusOctaves: this.surface.currentSampling.octaves,
      cirrusOctaves: cirrusOctavesOf(this.effectiveCirrus),
    };
  }
  // 雲全体と、少なくとも一方の雲種が有効なとき表示可能とする。
  public get cloudsVisible(): boolean {
    return this.cloudsEnabled && (this.cumulusEnabled || this.cirrusEnabled);
  }
  public get cumulusVisible(): boolean { return this.cloudsVisible && this.cumulusEnabled; }
  public get cirrusVisible(): boolean { return this.cloudsVisible && this.cirrusEnabled; }
  public get topAltitude(): number { return this.surface.topAltitude; }

  public addTo(parent: THREE.Object3D): void { this.surface.addTo(parent); }

  // 描画設定のうち雲にかかわる項目と、見かけ直径 apparentDiameterPx [px] を表示状態へ反映する。
  public syncGraphics(graphics: GraphicsSettingsData, apparentDiameterPx: number): void {
    // 雲全体を描くかと、描くときの雲場の出どころ・積雲の標本の配り方・殻の分割段。
    this.setCloudsEnabled(graphics.clouds);
    this.cumulusEnabled = graphics.cumulus;
    this.cirrusEnabled = graphics.cirrus;
    this.syncSurfaceVisibility();
    if (graphics.clouds) {
      this.setSource(graphics.cloudFieldSource);
      // 実効の精細さは、設定の値をフットプリント上限と予算上限の小さい方の段の組まで下げたもの。設定は上限として
      // 扱う — 解像できない細かさと、フレーム枠に収まらない細かさは段を落として品質を守る。最も精細な段まで
      // 許されるときは設定の値のまま。
      const spanMin = this.minPixelSpan(apparentDiameterPx);
      const budget = this.governor?.levelCap ?? DETAIL_TIERS - 1;
      const footprintCumulus = footprintLevel(spanMin, CUMULUS_TIER_OCTAVES, DETAIL_WAVELENGTHS);
      const footprintCirrus = footprintLevel(spanMin, CIRRUS_TIER_OCTAVES, CIRRUS_WAVELENGTHS);
      const cumulusSetting: CumulusSampling = {
        march: graphics.cumulusMarchSteps, refine: graphics.cumulusRefineSteps, octaves: graphics.cumulusOctaves,
      };
      const cumulusCap = Math.min(footprintCumulus, budget);
      const cumulus = cumulusCap >= DETAIL_TIERS - 1
        ? cumulusSetting : cappedSampling(cumulusSetting, CUMULUS_TIER_SAMPLING[cumulusCap]!);
      const cirrusTier = Math.min(graphics.cirrusDetail, footprintCirrus, budget);
      this.quality = {
        cumulus: qualityReadingOf(
          samplingLabel(cumulusSetting), samplingLabel(cumulus),
          !sameSampling(cumulus, cumulusSetting), footprintCumulus, budget),
        cirrus: qualityReadingOf(
          cirrusTierLabel(graphics.cirrusDetail), cirrusTierLabel(cirrusTier),
          cirrusTier < graphics.cirrusDetail, footprintCirrus, budget),
      };
      this.effectiveCirrus = cirrusTier as CirrusDetail;
      this.surface.setSampling(cumulus);
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

  // 実効の精細さと、その決定に効いた上限。実効の値の表示が「設定・フットプリント・予算のどれで決まったか」を読む。
  public get cloudQuality(): {
    readonly cumulus: CloudQualityReading;
    readonly cirrus: CloudQualityReading;
  } {
    return this.quality;
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

  // 天体固定で見た太陽直下点の経度 [rad] を生成系へ渡す。暦を持つ呼び出し側がフレームごとに
  // 渡し、null で生成側の既定の太陽へ戻す。実写の場は時刻を持たないので何もしない。
  public setSolarLongitude(rad: number | null): void {
    this.sources.generated.setSolarLongitude?.(rad);
  }

  // 雲全体を描くかを置き直す。偽なら不透明表面も隠す。
  public setCloudsEnabled(enabled: boolean): void {
    this.cloudsEnabled = enabled;
    this.syncSurfaceVisibility();
  }

  // 積雲を描かないなら不透明な雲殻を隠す。
  private syncSurfaceVisibility(): void {
    if (!this.cumulusVisible) this.surface.hide();
  }

  // 見かけ直径 [px] から不透明表面の分割段を選ぶ。雲を描かないなら隠す。
  private syncLod(apparentDiameterPx: number): void {
    if (this.cumulusVisible) this.surface.syncLod(apparentDiameterPx);
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
