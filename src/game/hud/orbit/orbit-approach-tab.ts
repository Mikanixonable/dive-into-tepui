// 軌道分析パネルの接近タブ: ターゲットを原点として、操作対象との水平距離(位相差の弧長換算)と
// 相対高度を折れ線で描き、相対傾斜角を1行併記する。縦横とも実距離なので、ドラッグは平行移動、
// ホイール/ピンチは縦横同倍率のズームになる。
import { injectOnce } from '../../../hud/widgets';
import { PointerPanZoom } from '../../../hud/widgets/pointer-pan-zoom';
import { approachSeries, sharedAttractor } from './orbit-analysis-data';
import { ScaleField, buildTabControls, clampScaleKm, sampleCountFor } from './orbit-analysis-tab';
import { OrbitChart } from './orbit-chart';
import { distanceAxis } from './orbit-chart-axes';
import type { Game } from '../../game';
import type { DynamicEntity } from '../../dynamic/dynamic-entity/dynamic-entity';
import type { OrbitReference } from '../../orbit-reference';
import type { ApproachTargetSource } from './orbit-analysis-data';
import type { AnalysisTab } from './orbit-analysis-tab';
import type { ChartMark, ChartPoint } from './orbit-chart';

const DEFAULT_SCALE_Y_KM = 1000;
const DEFAULT_SCALE_X_KM = 1000;
// 横軸が距離なので、どこまで先を描くかは横軸のスケールからは決まらない。低軌道の数周ぶんに
// 相当する 1 日を先まで見る。
const SAMPLE_SPAN_SEC = 86400;
// 1日ぶんを描くため、高度タブと同じ密度では周回1つあたりの点が粗く、折れ線が角ばって見える。
// 密度を底上げする倍率。
const SAMPLE_MULTIPLIER = 4;

const STYLE = `
#hud .orbit-analysis-relinc {
  display: flex; justify-content: space-between; padding: var(--space-2) 0; color: var(--text);
}
#hud .orbit-analysis-relinc-label { opacity: 0.7; }
`;

export class ApproachTab implements AnalysisTab {
  public readonly label = '接近';
  public readonly element: HTMLElement;
  private readonly chart = new OrbitChart();
  private readonly relIncValue: HTMLElement;
  private readonly yField: ScaleField;
  private readonly xField: ScaleField;
  // ドラッグでの平行移動 [m]。ズームはスケールを直接書き換える(入力欄と同じ状態)。
  private panX = 0;
  private panY = 0;
  private scaleYKm = DEFAULT_SCALE_Y_KM;
  private scaleXKm = DEFAULT_SCALE_X_KM;
  // リセットで戻るスケール [km]。手入力での確定を新しい既定値として扱う。
  private baselineYKm = DEFAULT_SCALE_Y_KM;
  private baselineXKm = DEFAULT_SCALE_X_KM;

  // チャート・相対傾斜角の行・スケール入力欄・リセットボタンの行を積む。
  public constructor() {
    injectOnce('orbit-approach-tab', STYLE);
    this.chart.element.classList.add('panzoom');
    new PointerPanZoom(this.chart.element, (dxPx, dyPx) => this.pan(dxPx, dyPx), (wd) => this.zoom(wd));

    // 相対傾斜角を数値で示す1行。
    const relIncLabel = document.createElement('span');
    relIncLabel.className = 'orbit-analysis-relinc-label';
    relIncLabel.textContent = '相対傾斜角';
    this.relIncValue = document.createElement('output');
    const relIncRow = document.createElement('div');
    relIncRow.className = 'orbit-analysis-relinc';
    relIncRow.appendChild(relIncLabel);
    relIncRow.appendChild(this.relIncValue);

    this.yField = new ScaleField('縦軸', 'km', () => this.scaleYKm, (km) => {
      this.scaleYKm = km;
      this.rebaseline();
    });
    this.xField = new ScaleField('横軸', 'km', () => this.scaleXKm, (km) => {
      this.scaleXKm = km;
      this.rebaseline();
    });
    this.element = document.createElement('div');
    this.element.appendChild(this.chart.element);
    this.element.appendChild(relIncRow);
    this.element.appendChild(buildTabControls([this.yField, this.xField], () => this.resetView()));
  }

  // 位相差を測れるのは同じ主天体を周回している相手だけなので、それが接近タブの成立条件になる。
  public available(
    game: Game, entity: DynamicEntity, _reference: OrbitReference, target: ApproachTargetSource | null,
  ): boolean {
    if (target === null) return false;
    const { celestialSystem } = game;
    return sharedAttractor(
      entity, target, celestialSystem.celestialMotions, celestialSystem, entity.state.t,
    ) !== null;
  }

  public dispose(): void {
    this.chart.dispose();
  }

  // 平行移動を0へ、スケールを直近の既定値へ戻す。
  public resetView(): void {
    this.panX = 0;
    this.panY = 0;
    this.scaleYKm = this.baselineYKm;
    this.scaleXKm = this.baselineXKm;
    this.refreshFields();
  }

  // ターゲットとの相対位置の点列を引き、原点(ターゲット)と操作対象の現在位置の丸マークを添える。
  public draw(
    game: Game, entity: DynamicEntity, _reference: OrbitReference, target: ApproachTargetSource | null,
  ): void {
    const { celestialSystem } = game;
    const series = target === null ? null : approachSeries(
      entity, target, celestialSystem.celestialMotions, celestialSystem, entity.state.t,
      SAMPLE_SPAN_SEC, sampleCountFor(this.chart.element) * SAMPLE_MULTIPLIER,
    );
    // 同じ主天体を周回していても、相手の周期が求まらない(双曲線軌道)なら位相差は測れない。
    if (series === null) {
      this.relIncValue.textContent = '---';
      this.drawOnAxes([], []);
      return;
    }
    this.relIncValue.textContent = isFinite(series.relIncDeg) ? `${series.relIncDeg.toFixed(2)}°` : '---';
    const points: (ChartPoint | null)[] = series.samples.map((s) => (s ? { x: s.x, y: s.y } : null));
    const current = points.find((p): p is ChartPoint => p !== null) ?? null;
    const marks: ChartMark[] = [{ point: { x: 0, y: 0 }, style: 'target' }];
    if (current) marks.push({ point: current, style: 'current' });
    this.drawOnAxes(points, marks);
  }

  // 縦横とも平行移動量を中心とした距離軸。
  private drawOnAxes(points: readonly (ChartPoint | null)[], marks: readonly ChartMark[]): void {
    this.chart.draw({
      points,
      x: distanceAxis(this.panX, this.scaleXKm * 1000, '水平距離'),
      y: distanceAxis(this.panY, this.scaleYKm * 1000, '相対高度'),
      marks,
    });
  }

  // ドラッグ移動量 [px] を縦横それぞれのスケールで m へ換算し、平行移動量へ加える。プロット寸法が
  // 未確定(初回描画前)なら何もしない。
  private pan(dxPx: number, dyPx: number): void {
    const size = this.chart.plotPixelSize();
    if (!size) return;
    this.panX -= (dxPx / size.width) * this.scaleXKm * 1000;
    this.panY += (dyPx / size.height) * this.scaleYKm * 1000;
  }

  // 実質2D の位置図なので、縦横を同倍率で保つ。
  private zoom(wheelDelta: number): void {
    const factor = Math.exp(wheelDelta);
    this.scaleYKm = clampScaleKm(this.scaleYKm * factor);
    this.scaleXKm = clampScaleKm(this.scaleXKm * factor);
    this.refreshFields();
  }

  // 手入力での確定を、リセットで戻る先として据え直す。
  private rebaseline(): void {
    this.baselineYKm = this.scaleYKm;
    this.baselineXKm = this.scaleXKm;
  }

  // 入力欄以外(ズーム・リセット)で動いたスケールを入力欄へ映す。
  private refreshFields(): void {
    this.yField.setValue(this.scaleYKm);
    this.xField.setValue(this.scaleXKm);
  }
}
