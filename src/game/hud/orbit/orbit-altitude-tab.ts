// 軌道分析パネルの高度タブ: 操作対象の基準天体からの高度を、現在時刻からの経過時間に対して
// 折れ線で描く。縦軸(高度)だけがドラッグ・ホイールで動き、横軸(経過時間)は現在時刻を
// 基準とした固定の軸なので入力欄でのみ変えられる。
import { PointerPanZoom } from '../widgets/pointer-pan-zoom';
import { altitudeSeries } from './orbit-analysis-data';
import { ScaleField, buildTabControls, clampScaleKm, sampleCountFor } from './orbit-analysis-tab';
import { OrbitChart } from './orbit-chart';
import { distanceAxis, timeAxis } from './orbit-chart-axes';
import type { Game } from '../../game';
import type { DynamicEntity } from '../../dynamic/dynamic-entity/dynamic-entity';
import type { OrbitReference } from '../../orbit-reference';
import type { AnalysisTab } from './orbit-analysis-tab';
import type { ChartMark, ChartPoint } from './orbit-chart';

const DEFAULT_SCALE_Y_KM = 1000;
const DEFAULT_SCALE_X_HOURS = 10;
const SECONDS_PER_HOUR = 3600;

export class AltitudeTab implements AnalysisTab {
  public readonly label = '高度';
  public readonly element: HTMLElement;
  private readonly chart = new OrbitChart();
  private readonly yField: ScaleField;
  // 縦軸(高度)の中心 [m]。null なら次の描画で現在高度に固定し直す。
  private centerM: number | null = null;
  private scaleYKm = DEFAULT_SCALE_Y_KM;
  private scaleXHours = DEFAULT_SCALE_X_HOURS;
  // リセットで戻る縦軸スケール [km]。手入力での確定を新しい既定値として扱う。
  private baselineYKm = DEFAULT_SCALE_Y_KM;

  // チャートと、縦軸・横軸のスケール入力欄・リセットボタンの行を積む。
  public constructor() {
    this.chart.element.classList.add('panzoom');
    new PointerPanZoom(this.chart.element, (_dxPx, dyPx) => this.pan(dyPx), (wd) => this.zoom(wd));
    this.yField = new ScaleField('縦軸', 'km', () => this.scaleYKm, (km) => {
      this.scaleYKm = km;
      this.baselineYKm = km;
    });
    const xField = new ScaleField('横軸', 'h', () => this.scaleXHours, (h) => { this.scaleXHours = h; });
    this.element = document.createElement('div');
    this.element.appendChild(this.chart.element);
    this.element.appendChild(buildTabControls([this.yField, xField], () => this.resetView()));
  }

  public available(): boolean {
    return true;
  }

  public dispose(): void {
    this.chart.dispose();
  }

  // 縦軸の中心を次の描画で現在高度に固定し直し、スケールを直近の既定値へ戻す。
  public resetView(): void {
    this.centerM = null;
    this.scaleYKm = this.baselineYKm;
    this.yField.setValue(this.scaleYKm);
  }

  // 現在時刻から横軸のスケールぶん先までの高度を引き、折れ線と現在位置の丸マークを描く。
  public draw(game: Game, entity: DynamicEntity, reference: OrbitReference): void {
    const series = altitudeSeries(
      entity, reference, game.celestialSystem, entity.state.t,
      this.scaleXHours * SECONDS_PER_HOUR, sampleCountFor(this.chart.element),
    );
    if (series === null) {
      this.drawMessage('基準が重力中心ではないため高度を定義できません');
      return;
    }
    // 縦軸の中心は、開いた/このタブを選び直した時点の現在高度に固定する。
    if (this.centerM === null) this.centerM = series.currentAlt;
    const points: (ChartPoint | null)[] = series.samples.map((s) => ({ x: s.t, y: s.alt }));
    const current = points[0];
    this.drawOnAxes(points, current ? [{ point: current, style: 'current' }] : []);
  }

  // 点列の代わりに案内文を出す。操作対象が無いときのフォールバック先としてウィンドウが使う。
  public drawMessage(message: string): void {
    this.drawOnAxes([], [], message);
  }

  // 横軸は経過時間の固定軸、縦軸は centerM を中心とした高度軸(下端は 0 でクリップ)。
  private drawOnAxes(
    points: readonly (ChartPoint | null)[], marks: readonly ChartMark[], emptyMessage?: string,
  ): void {
    this.chart.draw({
      points,
      x: timeAxis(this.scaleXHours * SECONDS_PER_HOUR, '経過時間'),
      y: distanceAxis(this.centerM ?? 0, this.scaleYKm * 1000, '高度', true),
      marks,
      emptyMessage,
    });
  }

  // ドラッグ移動量 [px] を縦軸のスケールで m へ換算し、高度の中心へ加える。プロット寸法が
  // 未確定(初回描画前)なら何もしない。
  private pan(dyPx: number): void {
    const size = this.chart.plotPixelSize();
    if (!size) return;
    this.centerM = (this.centerM ?? 0) + (dyPx / size.height) * this.scaleYKm * 1000;
  }

  private zoom(wheelDelta: number): void {
    this.scaleYKm = clampScaleKm(this.scaleYKm * Math.exp(wheelDelta));
    this.yField.setValue(this.scaleYKm);
  }
}
